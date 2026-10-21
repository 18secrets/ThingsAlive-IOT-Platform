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
 * How far back an ingest will build a partition for, rather than refuse the
 * reading (task QPART1). This bound does two jobs: it keeps a reconnecting
 * logger's backlog and the legacy backfill (months, sometimes years, of real
 * history) landing correctly, and it stops a device with a broken clock reporting
 * the year 2000 from creating a few hundred empty partitions nobody asked for.
 * `telemetry_reading` migrated on a 12-months-ahead, 2-months-behind buffer, and
 * the daily maintenance task only ever extends forward — neither covers a reading
 * dated further back than this on its own.
 */
export const MAX_BACKFILL_MONTHS = 24;

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

    const rejections = m.getRepository(ProjectionRejection);
    const oldestAllowedMonth = new Date(Date.UTC(
      receivedAt.getUTCFullYear(), receivedAt.getUTCMonth() - MAX_BACKFILL_MONTHS, 1,
    ));

    const rows: (Partial<TelemetryReading> & { sourceTimestamp: Date })[] = [];
    for (const r of envelope.readings) {
      const tenantId = tenantByImei.get(r.imei);
      if (!tenantId) {
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

      const sourceTimestamp = new Date(r.sourceTimestamp);
      if (sourceTimestamp < oldestAllowedMonth) {
        await rejections.save(
          rejections.create({
            sourceSystem: envelope.sourceSystem,
            kind: 'telemetry',
            externalId: r.imei,
            reason: `Reading for ${r.imei}/${r.signal} is dated ${sourceTimestamp.toISOString()}, `
              + `more than ${MAX_BACKFILL_MONTHS} months before it arrived — refused rather than `
              + 'building it a partition, since a value this old is more likely a clock fault '
              + 'than a backfill.',
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
        sourceTimestamp,
        receivedAt,
        source: envelope.source,
      });
    }

    if (!rows.length) return result;

    // Forward is already covered by the migration's own buffer and the daily
    // maintenance task; this is what makes an older month — a reconnecting
    // logger's backlog, the legacy backfill — land correctly without waiting on
    // either of those.
    //
    // A literal 'YYYY-MM-01' string, not a JS Date object: a Date cast to ::date
    // is interpreted in the session's own timezone, and this table's session sets
    // none — midnight UTC on the 1st becomes the last day of the *previous* month
    // wherever the server's local zone sits behind UTC, silently building the wrong
    // partition every time.
    const months = new Set(rows.map((r) =>
      `${r.sourceTimestamp.getUTCFullYear()}-${String(r.sourceTimestamp.getUTCMonth() + 1).padStart(2, '0')}-01`));
    for (const month of months) {
      await m.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    }

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
