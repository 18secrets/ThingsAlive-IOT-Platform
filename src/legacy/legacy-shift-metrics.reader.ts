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

/** One reading of a fuel counter: when the device took it, and the litres it showed. */
export interface FuelCounterReading {
  at: Date;
  value: number;
}

/**
 * One fuel counter series of one machine, probed at both ends of a running shift (D52).
 * A machine can have more than one; which to read is the nowcast's decision, not this file's.
 */
export interface FuelCounterProbe {
  equnr: string;
  /** The existing platform's `device_sensor_measurements.id`. */
  seriesId: number;
  unit: string | null;
  /** The counter at the shift start: the last reading in the few minutes before it, else the first after. */
  opening: FuelCounterReading | null;
  /** The newest reading at or before `asOf` and not before the shift start; null when there is none. */
  latest: FuelCounterReading | null;
}

export interface FuelCounterWindow {
  shiftStart: Date;
  asOf: Date;
  /** How far before the start a reading still counts as the counter at the start. */
  openingSince: Date;
}

/** What the nowcast needs from the existing platform's fuel counters. The spec hands it a fake. */
export interface FuelCounterSource {
  readonly configured: boolean;
  readFuelCounters(equnrs: readonly string[], window: FuelCounterWindow): Promise<FuelCounterProbe[]>;
}

/**
 * How much earlier than its own timestamp a reading may have been stored. The logs are
 * partitioned by `created_at`, not by `timestamp`, so a bound on `timestamp` alone opens
 * every partition; this lower bound on `created_at` is what keeps a probe to the newest one
 * or two. An hour covers a device clock running ahead of the server's; a reading stamped
 * further ahead than that is not one to trust with a shift's litres anyway.
 */
const CLOCK_AHEAD_MS = 3_600_000;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Bounded batches, so one query never carries an unbounded parameter array. */
const EQUNRS_PER_QUERY = 500;

/**
 * Shift totals from the existing platform: litres and working hours per machine per
 * shift (D50); and, for the shift under way, where each machine's fuel counter stood at
 * its start and stands now (D52).
 *
 * Read-only twice over: the connection opens every transaction
 * read-only (`createLegacyDataSource`), and each read here also says so itself, so a
 * future edit that pointed this at a writable connection would still be refused.
 *
 * Connected on first use, not at boot. The scheduler runs the shift runner, the forecast
 * pass and the outbox as well, and none of them should stop because somebody else's
 * database is down for maintenance; a read that cannot connect fails that pass, which
 * says so in the log and is tried again on the next tick.
 */
@Injectable()
export class LegacyShiftMetricsReader implements ShiftMetricsSource, FuelCounterSource, OnModuleDestroy {
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

  /**
   * Each machine's fuel counter at the start of the running shift and as of `asOf` (D52).
   *
   * This reads the existing platform's largest table on its live database every quarter
   * hour, so every read of it is an index probe and never a scan: per series, a `LIMIT 1`
   * down `(device_sensor_measurement_id, "timestamp")` in the direction it needs, bounded
   * on `created_at` as well so only the newest one or two partitions are opened. Two probes
   * a series as a rule; a third only for a series with nothing in the minutes before the
   * start — a machine switched on during the shift — to find its first reading after it.
   * A machine with no reading since the start costs one.
   *
   * Bounded above on `created_at` too: a snapshot as of 08:15 sees only what had reached
   * the existing platform by 08:15, so a pass that runs late cannot be scored on readings
   * the snapshot it claims to be could not have had.
   */
  async readFuelCounters(equnrs: readonly string[], window: FuelCounterWindow): Promise<FuelCounterProbe[]> {
    if (!this.source) throw new Error('No LEGACY_SHIFT_DB_* configuration; nothing to read from.');
    if (equnrs.length === 0) return [];
    const ds = await this.connection();
    const schema = `"${this.config?.schema ?? 'public'}"`;
    const createdSince = new Date(window.openingSince.getTime() - CLOCK_AHEAD_MS);

    // One probe of each series' log, in `order`, inside [$2, $3]; the LATERAL makes it one
    // index descent per series without one round trip per series.
    const probe = (order: 'ASC' | 'DESC') => `
      SELECT s.id AS series_id, x."timestamp" AS at, x.value::float8 AS value
        FROM unnest($1::int[]) AS s(id)
        CROSS JOIN LATERAL (
          SELECT l."timestamp", l.value
            FROM ${schema}."device_sensor_measurement_logs" l
           WHERE l.device_sensor_measurement_id = s.id
             AND l."timestamp" >= $2 AND l."timestamp" <= $3
             AND l.created_at >= $4 AND l.created_at <= $5
             AND l.deleted_at IS NULL AND l.value IS NOT NULL
           ORDER BY l."timestamp" ${order}
           LIMIT 1) x`;
    type Hit = { series_id: number; at: Date; value: number };
    const byId = (hits: Hit[]) => new Map(hits.map((h): [number, FuelCounterReading] =>
      [Number(h.series_id), { at: new Date(h.at), value: Number(h.value) }]));

    const out: FuelCounterProbe[] = [];
    for (let i = 0; i < equnrs.length; i += EQUNRS_PER_QUERY) {
      const batch = equnrs.slice(i, i + EQUNRS_PER_QUERY);
      out.push(...await ds.transaction(async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        // Equipment number to fuel counter. Small tables; the logs are the only large one.
        const series: { equnr: string; series_id: number; unit: string | null }[] = await m.query(
          `SELECT em.equipment::text AS equnr, dsm.id::int AS series_id, sm.unit::text AS unit
             FROM ${schema}."equipment_master" em
             JOIN ${schema}."devices" d ON d.equipment_id = em.id
             JOIN ${schema}."device_sensors" ds ON ds.device_id = d.id AND ds.deleted_at IS NULL
             JOIN ${schema}."device_sensor_measurements" dsm ON dsm.device_sensor_id = ds.id AND dsm.deleted_at IS NULL
             JOIN ${schema}."sensor_measurements" sm ON sm.id = dsm.sensor_measurement_id
            WHERE em.equipment = ANY($1::text[]) AND sm.name = 'fuel_consumption'
            ORDER BY 1, 2`,
          [batch],
        );
        if (series.length === 0) return [];
        const ids = series.map((s) => s.series_id);

        const latest = byId(await m.query(probe('DESC'), [ids, window.shiftStart, window.asOf, createdSince, window.asOf]));
        const live = ids.filter((id) => latest.has(id));
        const opening = live.length
          ? byId(await m.query(probe('DESC'), [live, window.openingSince, window.shiftStart, createdSince, window.asOf]))
          : new Map<number, FuelCounterReading>();
        const late = live.filter((id) => !opening.has(id));
        if (late.length) {
          const first = byId(await m.query(probe('ASC'), [late, window.shiftStart, window.asOf, createdSince, window.asOf]));
          for (const [id, r] of first) opening.set(id, r);
        }
        return series.map((s): FuelCounterProbe => ({
          equnr: s.equnr, seriesId: s.series_id, unit: s.unit,
          opening: opening.get(s.series_id) ?? null, latest: latest.get(s.series_id) ?? null,
        }));
      }));
    }
    return out;
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
