import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelemetryBatchEnvelope } from '../projection/contracts/contracts';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { TelemetryReading } from './telemetry-reading.entity';

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
    @InjectRepository(TelemetryReading) private readonly readings: Repository<TelemetryReading>,
    @InjectRepository(SensorMapProjection) private readonly sensorMap: Repository<SensorMapProjection>,
    @InjectRepository(ProjectionRejection) private readonly rejections: Repository<ProjectionRejection>,
  ) {}

  async ingest(envelope: TelemetryBatchEnvelope, receivedAt = new Date()): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 };
    if (!envelope.readings.length) return result;

    // A reading whose device is not mapped has no tenant, and therefore no home.
    const imeis = [...new Set(envelope.readings.map((r) => r.imei))];
    const tenantByImei = new Map<string, string>();
    for (const row of await this.sensorMap.find({ where: imeis.map((imei) => ({ imei })) })) {
      tenantByImei.set(row.imei, row.tenantId);
    }

    const rows: Partial<TelemetryReading>[] = [];
    for (const r of envelope.readings) {
      const tenantId = tenantByImei.get(r.imei);
      if (!tenantId) {
        await this.rejections.save(
          this.rejections.create({
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

    const inserted = await this.readings
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
