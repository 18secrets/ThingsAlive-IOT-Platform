import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TELEMETRY_READING_V1 } from '../projection/contracts/contracts';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { runTenantSpanning } from '../scope/tenant-session';
import { TelemetryBatchEnvelope } from '../projection/contracts/contracts';
import { LEGACY_DATA_SOURCE } from './legacy-source';

export interface PullRequest {
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  /** Exclusive. Readings at exactly this instant belong to the previous window. */
  from: Date;
  /** Inclusive. */
  to: Date;
}

export interface PullResult {
  envelope: TelemetryBatchEnvelope | null;
  /** Why nothing came back, when nothing did. */
  reason?: 'no-connection' | 'no-devices' | 'no-sensors' | 'no-readings';
}

/** A cap, so one machine with a fast logger cannot exhaust memory on a single pull. */
export const MAX_READINGS_PER_PULL = 50_000;

/**
 * Telemetry for one shift window, read from the existing platform (task P1-110).
 *
 * One query against one of their tables. The chain from a reading to a canonical signal
 * runs `device_sensor_measurement_logs` → `device_sensor_measurements` →
 * `device_sensors` → `devices`, and this deliberately walks none of it: the mapping
 * already exists here as `sensor_map_projection`, whose `external_id` *is* the
 * measurement id. So the join happens locally against a mirror we already keep in step,
 * and the read from their database is a primary-key lookup over a time range.
 *
 * That matters for more than tidiness. Joining four of their tables would make this
 * break the next time they alter one, in a scheduled job, quietly. Selecting three
 * columns from one table is the smallest grant they can give us and the smallest
 * surface for them to break.
 *
 * A sensor remapped upstream and not yet synced would attribute readings to the wrong
 * signal — which is why the projection carries that warning, and why the reader trusts
 * the projection rather than re-deriving the mapping from the readings.
 */
@Injectable()
export class LegacyTelemetryReader {
  private readonly logger = new Logger(LegacyTelemetryReader.name);

  constructor(
    private readonly ds: DataSource,
    @Optional() @Inject(LEGACY_DATA_SOURCE) private readonly legacy?: DataSource | null,
  ) {}

  get connected(): boolean {
    return !!this.legacy?.isInitialized;
  }

  async pull(request: PullRequest): Promise<PullResult> {
    if (!this.legacy?.isInitialized) return { envelope: null, reason: 'no-connection' };

    const map = await this.sensorMapFor(request);
    if (map.size === 0) {
      // Two different nothings, kept apart. No device fitted is a commissioning gap;
      // no sensor mapped is a synchronisation gap. Collapsing them into "no data"
      // is how a fleet sits unscored with nobody able to say which of the two it is.
      return { envelope: null, reason: await this.hasDevices(request) ? 'no-sensors' : 'no-devices' };
    }

    const rows: { measurement_id: string; ts: Date; value: string }[] = await this.legacy.query(
      `SELECT "device_sensor_measurement_id"::text AS measurement_id,
              "timestamp" AS ts,
              "value"::text AS value
         FROM "device_sensor_measurement_logs"
        WHERE "device_sensor_measurement_id" = ANY($1::bigint[])
          AND "timestamp" > $2
          AND "timestamp" <= $3
        ORDER BY "timestamp" ASC
        LIMIT ${MAX_READINGS_PER_PULL}`,
      [[...map.keys()], request.from, request.to],
    );
    if (rows.length === 0) return { envelope: null, reason: 'no-readings' };

    if (rows.length === MAX_READINGS_PER_PULL) {
      // Said out loud rather than silently truncated. A window clipped at the cap has
      // been scored on part of itself, and a prediction built from the first half of a
      // shift is not wrong in a way anybody can see.
      this.logger.warn(
        `Window for ${request.externalId} hit the ${MAX_READINGS_PER_PULL}-reading cap. `
        + 'The score for this shift is built from part of it.',
      );
    }

    const readings = rows.flatMap((row) => {
      const sensor = map.get(row.measurement_id);
      if (!sensor) return [];
      return [{
        imei: sensor.imei,
        signal: sensor.signal,
        value: Number(row.value),
        unit: sensor.unit ?? undefined,
        sourceTimestamp: new Date(row.ts).toISOString(),
      }];
    }).filter((r) => Number.isFinite(r.value));

    if (readings.length === 0) return { envelope: null, reason: 'no-readings' };

    return {
      envelope: {
        contract: TELEMETRY_READING_V1,
        sourceSystem: request.sourceSystem,
        // Read from a store rather than received off a wire, and still live: these are
        // the real readings for the window that just closed. 'replayed' is for a
        // deliberate re-run of history, and labelling these that way would let a real
        // prediction be dismissed as an artefact of a backfill.
        source: 'live',
        readings,
      },
    };
  }

  /**
   * Which upstream measurement ids belong to this machine, and what each one means.
   *
   * Tenant-spanning because it is a read of the mirror on behalf of a runner with no
   * request behind it; the tenant is pinned in the query rather than taken from a
   * session, so it cannot widen.
   */
  private async sensorMapFor(
    request: PullRequest,
  ): Promise<Map<string, { imei: string; signal: string; unit: string | null }>> {
    return runTenantSpanning(this.ds, `telemetry pull for ${request.externalId}`, async (m) => {
      const devices = await m.getRepository(DeviceProjection).find({
        where: {
          tenantId: request.tenantId,
          sourceSystem: request.sourceSystem,
          equipmentExternalId: request.externalId,
        },
      });
      const imeis = [...new Set(devices.map((d) => d.imei))];
      if (imeis.length === 0) return new Map();

      const sensors = await m.getRepository(SensorMapProjection).find({
        where: imeis.map((imei) => ({
          tenantId: request.tenantId, sourceSystem: request.sourceSystem, imei,
        })),
      });
      return new Map(sensors.map((s) => [s.externalId, {
        imei: s.imei, signal: s.signal, unit: s.unit,
      }]));
    });
  }

  private async hasDevices(request: PullRequest): Promise<boolean> {
    return runTenantSpanning(this.ds, `telemetry pull for ${request.externalId}`, async (m) =>
      (await m.getRepository(DeviceProjection).count({
        where: {
          tenantId: request.tenantId,
          sourceSystem: request.sourceSystem,
          equipmentExternalId: request.externalId,
        },
      })) > 0);
  }
}
