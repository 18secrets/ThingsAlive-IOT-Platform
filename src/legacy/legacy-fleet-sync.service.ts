import { ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DataSource } from 'typeorm';
import {
  DeviceSnapshotItem, EQUIPMENT_SNAPSHOT_V1, EquipmentSnapshotEnvelope, EquipmentSnapshotItem, SensorMapSnapshotItem,
} from '../projection/contracts/contracts';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { EquipmentProjection } from '../projection/entities/equipment-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionService, SyncResult } from '../projection/services/projection.service';
import { runTenantSpanning } from '../scope/tenant-session';
import { LegacyFleet, readLegacyFleet } from './legacy-fleet.reader';
import { LEGACY_DATA_SOURCE, legacyConfigFrom } from './legacy-source';

/** The source system 1.0's rows are mirrored under, as in the seeds and signal aliases. */
export const LEGACY_SOURCE_SYSTEM = 'iot-platform-1';

type Kind = 'equipment' | 'device' | 'sensor_map';

export interface FleetSyncResult {
  at: string;
  read: { equipment: number; devices: number; sensorMap: number };
  /** Rows that did not meet the snapshot contract, recorded in projection_rejection. */
  invalid: { equipment: number; devices: number; sensorMap: number };
  applied: Record<string, SyncResult>;
}

/**
 * Fills the mirror tables from IoT Platform 1.0 (task QSYNC1).
 *
 * Until this, `equipment_projection`, `device_projection` and `sensor_map_projection`
 * were filled only by a seed, so 1.0 fleet onboarding (QONBOARD1) and the telemetry
 * reader, which both read them, saw seeded data and nothing else.
 *
 * It adds no write path of its own. It reads 1.0 over the read-only connection (D01),
 * turns the rows into the `equipment-snapshot/v1` contract and hands that to
 * `ProjectionService.apply` — the same door every snapshot uses, with its tenant-map
 * refusal, its checksums and its reconcile. Each pass is a *full* snapshot, so a
 * machine 1.0 deleted is marked missing here rather than lingering as live.
 *
 * Full mode has one way to do damage: a read that comes back empty because a grant or
 * a schema name is wrong looks exactly like "1.0 has no machines", and would mark the
 * whole mirror missing. So a kind that reads zero rows while the mirror holds live
 * ones refuses the pass, unless the caller says the empty fleet is real.
 *
 * Rows that fail the contract (a device with no IMEI, a machine with no client) are
 * recorded in `projection_rejection`, the same table that records an unmapped client,
 * and left out — never defaulted.
 */
@Injectable()
export class LegacyFleetSyncService {
  private readonly logger = new Logger(LegacyFleetSyncService.name);
  private readonly schema = legacyConfigFrom(process.env)?.schema ?? 'public';

  constructor(
    private readonly ds: DataSource,
    private readonly projection: ProjectionService,
    @Optional() @Inject(LEGACY_DATA_SOURCE) private readonly legacy?: DataSource | null,
  ) {}

  get connected(): boolean {
    return !!this.legacy?.isInitialized;
  }

  async run(options: { allowEmpty?: boolean } = {}, now = new Date()): Promise<FleetSyncResult> {
    if (!this.legacy?.isInitialized) {
      throw new ServiceUnavailableException({
        code: 'legacy_not_configured',
        message: 'No connection to IoT Platform 1.0 (LEGACY_DB_*). Nothing was read or changed.',
      });
    }
    const fleet = await readLegacyFleet(this.legacy, this.schema);
    return this.apply(fleet, options, now);
  }

  /** The pass, from rows already read. Separate so the mapping is testable without a second database. */
  async apply(fleet: LegacyFleet, options: { allowEmpty?: boolean } = {}, now = new Date()): Promise<FleetSyncResult> {
    // One pass at a time. Two at once — the daily tick and a manual run — would both
    // see a new machine as absent and the second insert would fail on the mirror's
    // unique key. A session lock, because the projection apply opens its own
    // transaction, which a transaction lock taken here could not span.
    const lock = this.ds.createQueryRunner();
    await lock.connect();
    try {
      await lock.query(`SELECT pg_advisory_lock(hashtextextended('legacy-fleet-sync', 0))`);
      return await this.applyLocked(fleet, options, now);
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended('legacy-fleet-sync', 0))`).catch(() => undefined);
      await lock.release();
    }
  }

  private async applyLocked(fleet: LegacyFleet, options: { allowEmpty?: boolean }, now: Date): Promise<FleetSyncResult> {
    if (!options.allowEmpty) await this.refuseEmptyOverLive(fleet);

    const rejected: { kind: Kind; externalId: string; reason: string; payload: unknown }[] = [];
    const keep = <T extends object>(kind: Kind, cls: new () => T, items: (T & { externalId: string })[]): T[] =>
      items.filter((item) => {
        const errors = validateSync(plainToInstance(cls, item), { whitelist: false });
        if (!errors.length) return true;
        rejected.push({
          kind, externalId: item.externalId, payload: item,
          reason: errors.map((e) => Object.values(e.constraints ?? {}).join('; ') || e.property).join('; '),
        });
        return false;
      });

    const equipment = keep('equipment', EquipmentSnapshotItem, fleet.equipment.map((r) => ({
      externalId: String(r.id),
      externalClientId: r.client_id === null ? '' : String(r.client_id),
      name: r.equipment ?? undefined,
      category: r.equipment_category_txt ?? r.equipment_category ?? undefined,
      plantExternalId: r.plant_id === null ? undefined : String(r.plant_id),
      sourceUpdatedAt: iso(r.updated_at),
      raw: compact({
        manufacturer: r.manufacturer, modelNumber: r.model_number, serialNumber: r.manuf_serial_no,
        engineType: r.engine_type, cclNumber: r.ccl_number, description: r.description,
        equipmentType: r.equipment_type_txt, licensePlate: r.license_plate, vin: r.vin,
      }),
    })));
    const devices = keep('device', DeviceSnapshotItem, fleet.devices.map((r) => ({
      externalId: String(r.id),
      externalClientId: r.client_id === null ? '' : String(r.client_id),
      imei: (r.imei_number ?? '').trim(),
      equipmentExternalId: r.equipment_id === null ? undefined : String(r.equipment_id),
      name: r.tool_name ?? undefined,
      sourceUpdatedAt: iso(r.updated_at),
      raw: compact({ type: r.type }),
    })));
    const sensorMap = keep('sensor_map', SensorMapSnapshotItem, fleet.sensorMap.map((r) => ({
      // The measurement id is the key the telemetry reader joins 1.0's log rows on.
      externalId: String(r.id),
      externalClientId: r.client_id === null ? '' : String(r.client_id),
      imei: (r.imei_number ?? '').trim(),
      signal: r.measurement_name ?? '',
      sensorName: r.sensor_name ?? undefined,
      unit: r.unit ?? undefined,
      sourceUpdatedAt: iso(r.updated_at),
      raw: compact({
        deviceId: r.device_id, isKpi: r.is_kpi, calibrationOffset: r.calibration_offset,
        thresholdMin: r.threshold_min, thresholdMax: r.threshold_max,
      }),
    })));

    if (rejected.length) {
      await runTenantSpanning(this.ds, 'legacy fleet sync: rejected rows', async (m) => {
        const repo = m.getRepository(ProjectionRejection);
        // Once per row and reason, not once per pass: the same bad 1.0 row read every
        // day is one problem, and a table that repeats it daily buries the new ones.
        const known = new Set((await repo.find({ where: { sourceSystem: LEGACY_SOURCE_SYSTEM } }))
          .map((r) => `${r.kind}|${r.externalId}|${r.reason}`));
        const fresh = rejected
          .map((r) => ({ ...r, reason: `Fails the snapshot contract: ${r.reason}` }))
          .filter((r) => !known.has(`${r.kind}|${r.externalId}|${r.reason}`));
        if (fresh.length) {
          await repo.save(fresh.map((r) => repo.create({
            sourceSystem: LEGACY_SOURCE_SYSTEM, kind: r.kind, externalId: r.externalId,
            reason: r.reason, payload: r.payload as Record<string, unknown>,
          })));
        }
      });
      this.logger.warn(`${rejected.length} 1.0 row(s) failed the snapshot contract and were left out.`);
    }

    const envelope = Object.assign(new EquipmentSnapshotEnvelope(), {
      contract: EQUIPMENT_SNAPSHOT_V1, sourceSystem: LEGACY_SOURCE_SYSTEM, mode: 'full' as const,
      generatedAt: now.toISOString(), equipment, devices, sensorMap,
    });
    const applied = await this.projection.apply(envelope, now);
    const count = (k: Kind) => rejected.filter((r) => r.kind === k).length;
    return {
      at: now.toISOString(),
      read: { equipment: fleet.equipment.length, devices: fleet.devices.length, sensorMap: fleet.sensorMap.length },
      invalid: { equipment: count('equipment'), devices: count('device'), sensorMap: count('sensor_map') },
      applied,
    };
  }

  private async refuseEmptyOverLive(fleet: LegacyFleet): Promise<void> {
    const live = await runTenantSpanning(this.ds, 'legacy fleet sync: live mirror counts', async (m) => ({
      equipment: await m.getRepository(EquipmentProjection).count({ where: { sourceSystem: LEGACY_SOURCE_SYSTEM, status: 'live' } }),
      devices: await m.getRepository(DeviceProjection).count({ where: { sourceSystem: LEGACY_SOURCE_SYSTEM, status: 'live' } }),
      sensorMap: await m.getRepository(SensorMapProjection).count({ where: { sourceSystem: LEGACY_SOURCE_SYSTEM, status: 'live' } }),
    }));
    const empty = (['equipment', 'devices', 'sensorMap'] as const).filter((k) => fleet[k].length === 0 && live[k] > 0);
    if (empty.length) {
      throw new ConflictException({
        code: 'legacy_read_empty',
        message: `1.0 returned no ${empty.join(', ')} while the mirror holds ${empty.map((k) => `${live[k]} live`).join(', ')}. `
          + 'That is more often a grant or schema problem than an empty fleet, so nothing was changed. '
          + 'Run again with allowEmpty=true if 1.0 really is empty.',
      });
    }
  }
}

function iso(d: Date | null): string | undefined {
  return d ? new Date(d).toISOString() : undefined;
}

/** Leaves out nulls, so a column 1.0 never filled does not change the checksum when it is added. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}
