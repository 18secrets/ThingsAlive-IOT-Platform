import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ParquetReader, ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantId } from '../../scope/tenant-session';
import { ARCHIVE_STORAGE, ArchiveStorage } from './archive-storage';
import { TelemetryArchive } from './telemetry-archive.entity';

/** D14: raw readings stay hot this long; a month is archived once all of it is older. */
export const HOT_DAYS = 90;
const CHUNK = 20_000;
const DAY = 86_400_000;

/**
 * What one archived reading carries (D14.1): the raw row, and the binding that
 * interpreted it when it was taken — so the file still means something after that
 * binding is superseded and its calibration replaced. A reading no binding covered is
 * archived with those fields empty rather than left out: it was in the partition, and
 * the partition is about to be dropped.
 */
export const ARCHIVE_SCHEMA = new ParquetSchema({
  id: { type: 'UTF8' },
  tenant_id: { type: 'UTF8' },
  imei: { type: 'UTF8' },
  signal: { type: 'UTF8' },
  value: { type: 'DOUBLE' },
  unit: { type: 'UTF8', optional: true },
  source_timestamp: { type: 'TIMESTAMP_MILLIS' },
  received_at: { type: 'TIMESTAMP_MILLIS' },
  /** `live` or `replayed`: the reading's own quality flag. */
  source: { type: 'UTF8' },
  binding_version_id: { type: 'UTF8', optional: true },
  equipment_source_system: { type: 'UTF8', optional: true },
  equipment_external_id: { type: 'UTF8', optional: true },
  component_id: { type: 'UTF8', optional: true },
  signal_key: { type: 'UTF8', optional: true },
  measurement_role: { type: 'UTF8', optional: true },
  canonical_unit: { type: 'UTF8', optional: true },
  calibration_version_id: { type: 'UTF8', optional: true },
});

const FIELDS = Object.keys(ARCHIVE_SCHEMA.fields);
type ArchiveRow = Record<string, string | number | Date | null>;

/** One line per row, in file order — the same function over what was read from the
 * database and over what was read back from the object. */
function canonical(row: ArchiveRow): string {
  return JSON.stringify(FIELDS.map((f) => {
    const v = row[f] ?? null;
    return v instanceof Date ? v.getTime() : v;
  })) + '\n';
}

export interface ArchiveRunResult {
  status: 'not_configured' | 'ran';
  months: { month: string; archived: { tenantId: string; rows: number; part: number }[]; dropped: number | null; error?: string }[];
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

/**
 * Telemetry older than 90 days, out to Parquet and out of the database (task QARCH1,
 * D14, D24) — a budget control, not hygiene.
 *
 * Per month, per account: export the account's rows to its own prefix, read the object
 * back and check row count and checksum, and record it verified. Then ask the database
 * to drop the partition — which recounts every account under an exclusive lock and
 * refuses unless each has a verified archive of exactly that many rows
 * (`drop_archived_telemetry_partition`). A month that fails anywhere stays in the
 * database, and the next pass tries again.
 */
@Injectable()
export class TelemetryArchiveService {
  private readonly logger = new Logger(TelemetryArchiveService.name);

  constructor(private readonly ds: DataSource, @Inject(ARCHIVE_STORAGE) private readonly storage: ArchiveStorage) {}

  /** Partitions whose whole month ended more than 90 days before `now` (D14.4). */
  async eligibleMonths(now = new Date()): Promise<Date[]> {
    const rows: { name: string }[] = await this.ds.query(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'telemetry_reading' ORDER BY 1`,
    );
    const cutoff = now.getTime() - HOT_DAYS * DAY;
    return rows
      .map((r) => /^telemetry_reading_(\d{4})_(\d{2})$/.exec(r.name))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)))
      .filter((month) => nextMonth(month).getTime() <= cutoff);
  }

  async run(now = new Date()): Promise<ArchiveRunResult> {
    if (!this.storage.configured) {
      this.logger.warn('No ARCHIVE_S3_* configuration: telemetry past 90 days stays in the database.');
      return { status: 'not_configured', months: [] };
    }
    const result: ArchiveRunResult = { status: 'ran', months: [] };
    for (const month of await this.eligibleMonths(now)) {
      const entry: ArchiveRunResult['months'][number] = { month: monthKey(month), archived: [], dropped: null };
      result.months.push(entry);
      try {
        entry.archived = await this.archiveMonth(month, now);
        entry.dropped = await this.dropMonth(month);
        this.logger.log(`Archived and dropped ${monthKey(month)}: ${entry.dropped} row(s).`);
      } catch (err) {
        entry.error = (err as Error).message;
        this.logger.error(`Telemetry ${monthKey(month)} not archived: ${entry.error}`);
      }
    }
    return result;
  }

  /** The platform's view: every archive written and every partition dropped. */
  async list(scope: RequestScope) {
    if (!scope.isPlatformRole) throw new ForbiddenException('Only Things Alive can read the telemetry archive log.');
    return runTenantSpanning(this.ds, `telemetry archive read by ${scope.userId}`, async (m) => ({
      archives: await m.getRepository(TelemetryArchive).find({ order: { month: 'DESC', tenantId: 'ASC', part: 'DESC' } }),
      drops: await m.query(`SELECT * FROM "telemetry_partition_drop" ORDER BY "month" DESC`),
    }));
  }

  /**
   * Every account with rows in the month gets a verified archive of exactly its current
   * rows. One already verified at that count is left alone; a count that has moved since
   * (a late arrival) is exported again as the next part.
   */
  async archiveMonth(month: Date, now = new Date()): Promise<{ tenantId: string; rows: number; part: number }[]> {
    const from = month;
    const to = nextMonth(month);
    const counts: { tenant_id: string; n: string }[] = await runTenantSpanning(this.ds, 'telemetry archive: count', (m) => m.query(
      `SELECT "tenant_id", count(*) AS n FROM "telemetry_reading"
        WHERE "source_timestamp" >= $1 AND "source_timestamp" < $2 GROUP BY "tenant_id" ORDER BY 1`, [from, to],
    ));
    const done: { tenantId: string; rows: number; part: number }[] = [];
    for (const { tenant_id: tenantId, n } of counts) {
      const latest = await runTenantSpanning(this.ds, 'telemetry archive: latest', (m) => m.getRepository(TelemetryArchive).findOne({
        where: { tenantId, month: from.toISOString().slice(0, 10) }, order: { part: 'DESC' },
      }));
      if (latest?.verifiedAt && Number(latest.rowCount) === Number(n)) continue;
      const part = (latest?.part ?? 0) + 1;
      const archive = await this.exportTenantMonth(tenantId, month, part, now);
      await this.verify(archive);
      done.push({ tenantId, rows: Number(archive.rowCount), part });
    }
    return done;
  }

  async dropMonth(month: Date): Promise<number> {
    const [row] = await this.ds.query(`SELECT drop_archived_telemetry_partition($1::date) AS dropped`, [month.toISOString().slice(0, 10)]);
    return Number(row.dropped);
  }

  // ------------------------------------------------------------------------- inside

  private async exportTenantMonth(tenantId: string, month: Date, part: number, now: Date): Promise<TelemetryArchive> {
    const dir = mkdtempSync(join(tmpdir(), 'ta-archive-'));
    const file = join(dir, 'part.parquet');
    const key = `tenants/${tenantId}/telemetry/${monthKey(month)}/part-${part}.parquet`;
    try {
      const writer = await ParquetWriter.openFile(ARCHIVE_SCHEMA, file);
      const hash = createHash('sha256');
      let rows = 0;
      let after: { at: Date; id: string } | null = null;
      for (;;) {
        // Keyset, oldest first, in chunks — a month is millions of rows, and the file is
        // written in the order the checksum is taken.
        const chunk: ArchiveRow[] = await withTenantId(this.ds, tenantId, (m) => m.query(
          `SELECT r."id", r."tenant_id", r."imei", r."signal", r."value", r."unit", r."source_timestamp", r."received_at", r."source",
                  b."id" AS binding_version_id, b."source_system" AS equipment_source_system,
                  b."external_id" AS equipment_external_id, b."component_id", b."signal_key", b."measurement_role",
                  b."canonical_unit", b."calibration_version_id"::text AS calibration_version_id
             FROM "telemetry_reading" r
             LEFT JOIN LATERAL (
               SELECT * FROM "signal_binding_version" b
                WHERE b."tenant_id" = r."tenant_id" AND b."imei" = r."imei" AND b."signal_key" = r."signal"
                  AND b."is_primary" AND b."status" IN ('active', 'superseded')
                  AND b."valid_from" <= r."source_timestamp" AND (b."valid_to" IS NULL OR b."valid_to" > r."source_timestamp")
                ORDER BY b."valid_from" DESC LIMIT 1) b ON true
            WHERE r."tenant_id" = $1 AND r."source_timestamp" >= $2 AND r."source_timestamp" < $3
              AND ($4::timestamptz IS NULL OR (r."source_timestamp", r."id") > ($4::timestamptz, $5::uuid))
            ORDER BY r."source_timestamp", r."id"
            LIMIT ${CHUNK}`,
          [tenantId, month, nextMonth(month), after?.at ?? null, after?.id ?? null],
        ));
        for (const row of chunk) {
          const clean: ArchiveRow = {};
          for (const f of FIELDS) clean[f] = row[f] ?? null;
          clean.value = Number(clean.value);
          await writer.appendRow(Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null)));
          hash.update(canonical(clean));
          rows += 1;
        }
        if (chunk.length < CHUNK) break;
        const last = chunk[chunk.length - 1];
        after = { at: last.source_timestamp as Date, id: last.id as string };
      }
      await writer.close();
      const byteSize = statSync(file).size;
      await this.storage.put(key, file);
      // Awaited here, inside the try: the `finally` below removes the file.
      return await runTenantSpanning(this.ds, 'telemetry archive: record', (m) => m.getRepository(TelemetryArchive).save({
        tenantId, month: month.toISOString().slice(0, 10), part, objectKey: key,
        rowCount: String(rows), checksum: hash.digest('hex'), byteSize: String(byteSize),
        exportedAt: now, verifiedAt: null, verifyError: null,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Read the object back — not the local file, which proves only that the write began —
   * and recompute count and checksum. Recorded verified only if both match, and the
   * count still matches the database.
   */
  private async verify(archive: TelemetryArchive): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'ta-verify-'));
    const file = join(dir, 'part.parquet');
    let problem: string | null = null;
    try {
      await this.storage.get(archive.objectKey, file);
      const reader = await ParquetReader.openFile(file);
      const cursor = reader.getCursor();
      const hash = createHash('sha256');
      let rows = 0;
      for (let row = await cursor.next(); row; row = await cursor.next()) {
        const r = row as ArchiveRow;
        const clean: ArchiveRow = {};
        for (const f of FIELDS) {
          const v = r[f] ?? null;
          clean[f] = (f === 'source_timestamp' || f === 'received_at') && v !== null ? new Date(v as Date) : v;
        }
        hash.update(canonical(clean));
        rows += 1;
      }
      await reader.close();
      if (rows !== Number(archive.rowCount)) problem = `object holds ${rows} row(s), ${archive.rowCount} were written`;
      else if (hash.digest('hex') !== archive.checksum) problem = 'checksum of the object differs from what was written';
    } catch (err) {
      problem = `object could not be read back: ${(err as Error).message}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await runTenantSpanning(this.ds, 'telemetry archive: verify', (m) => m.getRepository(TelemetryArchive).update(
      { id: archive.id }, problem ? { verifyError: problem } : { verifiedAt: new Date(), verifyError: null },
    ));
    if (problem) throw new Error(`${archive.objectKey}: ${problem}`);
  }
}
