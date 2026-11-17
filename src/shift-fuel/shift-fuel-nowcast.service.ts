import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CLIENT_SOURCE_SYSTEM } from '../equipment/equipment-profile.entity';
import { FuelCounterProbe, FuelCounterSource, LegacyShiftMetricsReader } from '../legacy/legacy-shift-metrics.reader';
import { withTenantId } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { addDays, forecastShift, HISTORY_DAYS, SHIFT_FUEL_METHOD, ShiftKey, ShiftObservation, shiftStart } from './shift-fuel-forecast';
import {
  DEFAULT_NOWCAST_TICK_SECONDS, nowcastShift, OPENING_LOOKBACK_MS, pickSeries, runningShift, SHIFT_FUEL_NOWCAST_METHOD,
  soFarLitres, STALE_AFTER_MS, tickFloor,
} from './shift-fuel-nowcast';
import { Machine, ShiftFuelService } from './shift-fuel.service';

/** Beside D50's sync and forecast pass (…003): its own, so the quarter-hourly nowcast never waits on the hourly sync. */
export const SHIFT_FUEL_NOWCAST_LOCK_KEY = 8_742_310_004;

/**
 * The unit a fuel counter must be in for its rise to be litres. The existing platform's
 * `fuel_consumption` measurement says 'liter'; a series that says anything else is
 * skipped and counted rather than read, because a counter in some other unit would give a
 * figure that looks right and is off by a constant.
 */
const COUNTER_UNIT = 'liter';

export interface ShiftFuelNowcastPassSummary {
  at: string;
  /** The tick the snapshots describe. */
  asOf: string;
  sdate: string;
  shift: 1 | 2;
  /** Active machines in 2.0 placed by equipment number, as D50 places them. */
  machines: number;
  /** Machines the existing platform has no `fuel_consumption` series for. */
  unmapped: number;
  /** Machines whose only fuel series are in a unit other than litres. */
  wrongUnit: number;
  /** Machines with no counter reading since the shift started: no snapshot, rather than a zero. */
  silent: number;
  /** Snapshots written from a reading more than half an hour older than their as_of. */
  stale: number;
  issued: number;
}

interface Burned {
  externalId: string;
  soFarL: number;
  counterAt: Date;
}

/**
 * The running shift's fuel, re-forecast every tick from the litres already burned (D52).
 *
 * One snapshot per machine per tick, appended. The base each one adds a share of is the
 * shift's own forecast where D50 has issued it, and otherwise the same arithmetic over the
 * same synced history — so the morning's first snapshots, made before the morning sync has
 * issued today's forecast, still rest on the number that forecast will be.
 *
 * Placement is D50's, by its own method: an equipment number held by two accounts is
 * placed in neither, and only active machines are nowcast.
 */
@Injectable()
export class ShiftFuelNowcastService {
  private readonly logger = new Logger(ShiftFuelNowcastService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(LegacyShiftMetricsReader) private readonly counters: FuelCounterSource,
    private readonly fuel: ShiftFuelService,
  ) {}

  get configured(): boolean {
    return this.counters.configured;
  }

  /**
   * One pass, or null because another is already running. Never waits on the lock, for the
   * reason D50's pass gives; and without it the unique key on (machine, shift, method,
   * as_of) still keeps the first snapshot of a tick and drops the second.
   */
  async run(now = new Date(), tickSeconds = DEFAULT_NOWCAST_TICK_SECONDS): Promise<ShiftFuelNowcastPassSummary | null> {
    const lock = await tryTakePassLock(this.ds, SHIFT_FUEL_NOWCAST_LOCK_KEY);
    if (!lock) return null;
    try {
      return await this.pass(now, tickSeconds);
    } finally {
      await lock.release();
    }
  }

  private async pass(now: Date, tickSeconds: number): Promise<ShiftFuelNowcastPassSummary> {
    const asOf = tickFloor(now, tickSeconds);
    const key = runningShift(asOf);
    const start = shiftStart(key);
    const summary: ShiftFuelNowcastPassSummary = {
      at: now.toISOString(), asOf: asOf.toISOString(), sdate: key.sdate, shift: key.shift,
      machines: 0, unmapped: 0, wrongUnit: 0, silent: 0, stale: 0, issued: 0,
    };
    // The tick that starts a shift has nothing burned to read; the table refuses it too.
    if (asOf.getTime() <= start.getTime()) return summary;

    const { placed } = await this.fuel.machines();
    const active = [...placed.values()].filter((m) => m.active);
    summary.machines = active.length;
    if (active.length === 0) return summary;

    const probes = await this.counters.readFuelCounters(active.map((m) => m.externalId).sort(), {
      shiftStart: start, asOf, openingSince: new Date(start.getTime() - OPENING_LOOKBACK_MS),
    });
    const seriesOf = new Map<string, FuelCounterProbe[]>();
    for (const p of probes) seriesOf.set(p.equnr, [...(seriesOf.get(p.equnr) ?? []), p]);

    const byTenant = new Map<string, Burned[]>();
    for (const machine of active) {
      const burned = this.burned(machine, seriesOf.get(machine.externalId) ?? [], summary);
      if (!burned) continue;
      if (asOf.getTime() - burned.counterAt.getTime() > STALE_AFTER_MS) summary.stale += 1;
      byTenant.set(machine.tenantId, [...(byTenant.get(machine.tenantId) ?? []), burned]);
    }
    if (summary.wrongUnit) this.logger.warn(`${summary.wrongUnit} machine(s) skipped: fuel counter not in ${COUNTER_UNIT}.`);

    for (const [tenantId, rows] of byTenant) {
      summary.issued += await withTenantId(this.ds, tenantId, (m) => this.snapshot(m, tenantId, key, asOf, rows));
    }
    return summary;
  }

  /** Litres since the shift started for one machine, or null — counted in the summary — when there is no honest figure. */
  private burned(machine: Machine, series: FuelCounterProbe[], summary: ShiftFuelNowcastPassSummary): Burned | null {
    if (series.length === 0) {
      summary.unmapped += 1;
      return null;
    }
    const litres = series.filter((s) => (s.unit ?? '').trim().toLowerCase() === COUNTER_UNIT);
    if (litres.length === 0) {
      summary.wrongUnit += 1;
      return null;
    }
    // No reading since the start is not a machine that burned nothing — it is a feed that
    // said nothing, and a zero here would read as an idle shift. No snapshot instead.
    const picked = pickSeries(litres);
    if (!picked) {
      summary.silent += 1;
      return null;
    }
    return {
      externalId: machine.externalId,
      soFarL: soFarLitres(picked.opening.value, picked.latest.value),
      counterAt: picked.latest.at,
    };
  }

  /**
   * The base for each machine, then one snapshot each, insert-if-absent: a second pass in
   * the same tick finds its rows already there and writes nothing.
   */
  private async snapshot(m: EntityManager, tenantId: string, key: ShiftKey, asOf: Date, rows: Burned[]): Promise<number> {
    const ids = rows.map((r) => r.externalId);
    const issued: { external_id: string; predicted_l: number }[] = await m.query(
      `SELECT "external_id", "predicted_l"::float8 AS predicted_l
         FROM "shift_fuel_forecast"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = ANY($3::text[])
          AND "sdate" = $4::date AND "shift" = $5 AND "method" = $6`,
      [tenantId, CLIENT_SOURCE_SYSTEM, ids, key.sdate, key.shift, SHIFT_FUEL_METHOD],
    );
    const base = new Map<string, { baseL: number; source: 'issued' | 'computed' }>(
      issued.map((f) => [f.external_id, { baseL: Number(f.predicted_l), source: 'issued' }]),
    );

    const missing = ids.filter((id) => !base.has(id));
    if (missing.length) {
      // The same history and the same function D50's forecast uses, so a computed base is
      // the number the issued one will be when the sync has made it from the same rows.
      const history: (ShiftObservation & { externalId: string })[] = (await m.query(
        `SELECT "external_id", "sdate"::text AS sdate, "shift"::int AS shift, "fuel_l"::float8 AS fuel_l
           FROM "legacy_shift_metric"
          WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = ANY($3::text[])
            AND "shift" = $4 AND "sdate" >= $5::date AND "sdate" < $6::date`,
        [tenantId, CLIENT_SOURCE_SYSTEM, missing, key.shift, addDays(key.sdate, -HISTORY_DAYS), key.sdate],
      )).map((r: { external_id: string; sdate: string; shift: 1 | 2; fuel_l: number | null }) => ({
        externalId: r.external_id, sdate: r.sdate, shift: r.shift, fuelL: r.fuel_l,
      }));
      for (const id of missing) {
        base.set(id, { baseL: forecastShift(history.filter((h) => h.externalId === id), key).predictedL, source: 'computed' });
      }
    }

    const out = rows.map((r) => {
      const b = base.get(r.externalId) as { baseL: number; source: 'issued' | 'computed' };
      return { ...r, ...b, ...nowcastShift({ soFarL: r.soFarL, baseL: b.baseL, asOf, key }) };
    });
    const written: unknown[] = await m.query(
      `INSERT INTO "shift_fuel_nowcast"
         ("tenant_id", "source_system", "external_id", "sdate", "shift", "as_of", "counter_at",
          "so_far_l", "base_l", "base_source", "predicted_l", "method")
       SELECT $1, $2, x.external_id, $3::date, $4, $5, x.counter_at, x.so_far_l, x.base_l, x.base_source, x.predicted_l, $6
         FROM unnest($7::text[], $8::timestamptz[], $9::numeric[], $10::numeric[], $11::text[], $12::numeric[])
           AS x(external_id, counter_at, so_far_l, base_l, base_source, predicted_l)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "sdate", "shift", "method", "as_of") DO NOTHING
       RETURNING 1`,
      [
        tenantId, CLIENT_SOURCE_SYSTEM, key.sdate, key.shift, asOf, SHIFT_FUEL_NOWCAST_METHOD,
        out.map((r) => r.externalId), out.map((r) => r.counterAt.toISOString()), out.map((r) => r.soFarL),
        out.map((r) => r.baseL), out.map((r) => r.source), out.map((r) => r.predictedL),
      ],
    );
    return written.length;
  }
}
