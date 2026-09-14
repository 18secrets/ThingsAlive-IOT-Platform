import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TelemetryBatchEnvelope } from '../projection/contracts/contracts';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { TelemetryReading } from './telemetry-reading.entity';
import { runTenantSpanning } from '../scope/tenant-session';

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

/**
 * Ingest for readings, idempotent by design (task P1-44).
 *
 * The dedupe key is (imei, signal, source_timestamp) and it is enforced by the
 * database, not by a check-then-insert: two workers consuming the same queue would
 * both pass a check and both insert. ON CONFLICT DO NOTHING lets the constraint be
 * the arbiter, and a duplicate becomes a counted no-op instead of a second row.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    private readonly ds: DataSource,
  ) {}

  /**
   * A batch off the broker carries readings for whatever devices happened to report,
   * which is to say several tenants at once. Like the projection sync, ingest is a
   * producer of tenant data and runs tenant-spanning; the tenant of each row is
   * decided here, from the sensor map, and a reading that cannot resolve one is
   * refused rather than stored under a guess.
   */
  async ingest(envelope: TelemetryBatchEnvelope, receivedAt = new Date()): Promise<IngestResult> {
    if (!envelope.readings.length) return { accepted: 0, duplicates: 0, rejected: 0 };
    return runTenantSpanning(this.ds, `telemetry ingest from ${envelope.sourceSystem}`, (m) =>
      this.ingestWithin(m, envelope, receivedAt),
    );
  }

  private async ingestWithin(
    m: EntityManager,
    envelope: TelemetryBatchEnvelope,
    receivedAt: Date,
  ): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 };

    // A reading whose device is not mapped has no tenant, and therefore no home.
    const imeis = [...new Set(envelope.readings.map((r) => r.imei))];
    const tenantByImei = new Map<string, string>();
    const sensorMapRepo = m.getRepository(SensorMapProjection);
    for (const row of await sensorMapRepo.find({ where: imeis.map((imei) => ({ imei })) })) {
      tenantByImei.set(row.imei, row.tenantId);
    }

    const rows: Partial<TelemetryReading>[] = [];
    for (const r of envelope.readings) {
      const tenantId = tenantByImei.get(r.imei);
      if (!tenantId) {
        const rejections = m.getRepository(ProjectionRejection);
        await rejections.save(
          rejections.create({
            sourceSystem: envelope.sourceSystem,
            kind: 'telemetry',
            externalId: r.imei,
            reason: `No sensor mapping for IMEI ${r.imei}; the reading has no resolvable tenant.`,
            payload: r as unknown as Record<string, unknown>,
          }),
        );
        result.rejected += 1;
        continue;
      }
      rows.push({
        tenantId,
        imei: r.imei,
        signal: r.signal,
        value: r.value,
        unit: r.unit ?? null,
        sourceTimestamp: new Date(r.sourceTimestamp),
        receivedAt,
        source: envelope.source,
      });
    }

    if (!rows.length) return result;

    const inserted = await m
      .createQueryBuilder()
      .insert()
      .into(TelemetryReading)
      .values(rows)
      .orIgnore() // ON CONFLICT DO NOTHING — the unique index decides, not a prior read.
      .execute();

    result.accepted = inserted.identifiers.filter(Boolean).length;
    result.duplicates = rows.length - result.accepted;
    if (result.duplicates) {
      this.logger.debug(`${result.duplicates} duplicate reading(s) ignored (${envelope.source}).`);
    }
    return result;
  }
}
