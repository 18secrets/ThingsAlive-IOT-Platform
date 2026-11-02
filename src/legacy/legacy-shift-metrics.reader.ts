import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createLegacyDataSource, LEGACY_SHIFT_METRICS_CONFIG, LegacyDbConfig } from './legacy-source';

/**
 * One row of the existing platform's `equipment_shift_metrics`, as it holds it.
 *
 * The table and its columns are named in this file and nowhere else, for the reason
 * `legacy-fleet.reader.ts` gives: when the existing platform renames one, this is the one
 * file to change. Values pass through untouched — numeric as text, `sdate` as text — and
 * the decisions about them are the sync's.
 */
export interface LegacyShiftMetricRow {
  equnr: string;
  /** YYYY-MM-DD. Read as text: pg turns a bare date into local midnight otherwise. */
  sdate: string;
  shift: number;
  fuel_consumption: string | null;
  work_hrs_new: string | null;
  updated_at: Date | null;
}

/** What the sync needs from a source of shift rows. The spec hands it a fake. */
export interface ShiftMetricsSource {
  readonly configured: boolean;
  read(equnrs: readonly string[], sinceDate: string): Promise<LegacyShiftMetricRow[]>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Bounded batches, so one query never carries an unbounded parameter array. */
const EQUNRS_PER_QUERY = 500;

/**
 * Shift totals from the existing platform: litres and working hours per machine per
 * shift (D50).
 *
 * One table, five columns, read-only twice over: the connection opens every transaction
 * read-only (`createLegacyDataSource`), and each read here also says so itself, so a
 * future edit that pointed this at a writable connection would still be refused.
 *
 * Connected on first use, not at boot. The scheduler runs the shift runner, the forecast
 * pass and the outbox as well, and none of them should stop because somebody else's
 * database is down for maintenance; a read that cannot connect fails that pass, which
 * says so in the log and is tried again on the next tick.
 */
@Injectable()
export class LegacyShiftMetricsReader implements ShiftMetricsSource, OnModuleDestroy {
  private readonly logger = new Logger(LegacyShiftMetricsReader.name);
  private readonly source: DataSource | null;
  private connecting: Promise<DataSource> | null = null;

  constructor(@Optional() @Inject(LEGACY_SHIFT_METRICS_CONFIG) private readonly config?: LegacyDbConfig | null) {
    if (config && !IDENTIFIER.test(config.schema ?? 'public')) {
      // Interpolated into the SQL below, so held to a plain identifier. Refused at boot,
      // where somebody is looking, rather than on the first hourly pass.
      throw new Error(`LEGACY_SHIFT_DB_SCHEMA "${config.schema}" is not a plain identifier.`);
    }
    this.source = config ? createLegacyDataSource(config) : null;
  }

  get configured(): boolean {
    return this.source !== null;
  }

  async read(equnrs: readonly string[], sinceDate: string): Promise<LegacyShiftMetricRow[]> {
    if (!this.source) throw new Error('No LEGACY_SHIFT_DB_* configuration; nothing to read from.');
    if (equnrs.length === 0) return [];
    const ds = await this.connection();
    const table = `"${this.config?.schema ?? 'public'}"."equipment_shift_metrics"`;

    const rows: LegacyShiftMetricRow[] = [];
    for (let i = 0; i < equnrs.length; i += EQUNRS_PER_QUERY) {
      const batch = equnrs.slice(i, i + EQUNRS_PER_QUERY);
      rows.push(...await ds.transaction(async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        return m.query(
          `SELECT equnr, sdate::text AS sdate, shift::int AS shift,
                  fuel_consumption::text AS fuel_consumption, work_hrs_new::text AS work_hrs_new, updated_at
             FROM ${table}
            WHERE equnr = ANY($1::text[])
              AND sdate >= $2::date
            ORDER BY equnr, sdate, shift`,
          [batch, sinceDate],
        ) as Promise<LegacyShiftMetricRow[]>;
      }));
    }
    return rows;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.source?.isInitialized) await this.source.destroy();
  }

  private async connection(): Promise<DataSource> {
    const source = this.source as DataSource;
    if (source.isInitialized) return source;
    // One attempt in flight at a time; a failed one is forgotten so the next pass retries.
    this.connecting ??= source.initialize().then(
      (ds) => {
        this.logger.log(`Reading shift totals from ${this.config?.host}/${this.config?.database} (read-only).`);
        return ds;
      },
      (err) => {
        this.connecting = null;
        throw err;
      },
    );
    return this.connecting;
  }
}
