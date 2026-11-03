import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../equipment/equipment-profile.entity';
import { LegacyShiftMetricRow, LegacyShiftMetricsReader, ShiftMetricsSource } from '../legacy/legacy-shift-metrics.reader';
import { runTenantSpanning, withTenantId } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import {
  addDays, forecastShift, HISTORY_DAYS, indiaDate, SHIFT_FUEL_METHOD, shiftEnd, ShiftKey, ShiftObservation, targetShifts,
} from './shift-fuel-forecast';

/** Beside the shift pass (…001) and the forecast pass (…002): its own, so none waits on another. */
export const SHIFT_FUEL_PASS_LOCK_KEY = 8_742_310_003;

/**
 * How far back each pass re-reads the existing platform: the forecast's 28 days, plus the
 * week in which it is known to revise a shift after the fact. Re-read whole every pass
 * rather than from a watermark on `updated_at`, because a first sync of a machine needs
 * the full 28 days anyway, and at one row per machine per shift the whole window is a few
 * thousand rows an hour for the fleet.
 */
export const SYNC_LOOKBACK_DAYS = HISTORY_DAYS + 7;

const ROWS_PER_STATEMENT = 1_000;

export interface ShiftFuelPassSummary {
  at: string;
  /** Machines in 2.0 the existing platform's rows can be placed against. */
  machines: number;
  /** Equipment numbers held by more than one account, so placed against none. */
  ambiguous: string[];
  /** False when no LEGACY_SHIFT_DB_* is configured: forecasts came from rows already synced. */
  synced: boolean;
  read: number;
  /** Rows refused before they reached the table: a shift that is not 1 or 2, a negative figure. */
  invalid: number;
  inserted: number;
  revised: number;
  forecastsIssued: number;
}

export interface Machine {
  tenantId: string;
  externalId: string;
  active: boolean;
}

interface CleanRow {
  externalId: string;
  sdate: string;
  shift: 1 | 2;
  fuelL: number | null;
  workHrs: number | null;
  legacyUpdatedAt: Date | null;
}

/**
 * Copies the existing platform's shift totals into 2.0 and forecasts the next shifts from
 * them (D50).
 *
 * The existing platform has no idea which account a machine belongs to here, so a row is
 * placed by its equipment number alone: the machine in 2.0 whose `external_id` it is,
 * among machines created in 2.0 (`ta-2.0`). Machines mirrored from IoT Platform 1.0 are
 * keyed by 1.0's row id instead, and an id that happened to equal an equipment number
 * would be a coincidence, not the same machine. A number held by two accounts is placed
 * against neither: sending one account's fuel to another is the one mistake here that
 * cannot be undone by the next sync.
 *
 * Writes run under the owning account's session, so the policy checks every row; only
 * the question "which accounts have a machine with this number" spans accounts.
 */
@Injectable()
export class ShiftFuelService {
  private readonly logger = new Logger(ShiftFuelService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(LegacyShiftMetricsReader) private readonly legacy: ShiftMetricsSource,
  ) {}

  get configured(): boolean {
    return this.legacy.configured;
  }

  /**
   * One pass — sync, then forecast — or null because another is already running.
   *
   * Never waits on the lock: the pass that holds it is doing exactly this work, and the
   * next tick finds whatever is left. Without the lock nothing would be corrupted — the
   * upsert and the insert-if-absent both settle on the unique keys — but two passes would
   * read the far database twice for one answer.
   */
  async run(now = new Date()): Promise<ShiftFuelPassSummary | null> {
    const lock = await tryTakePassLock(this.ds, SHIFT_FUEL_PASS_LOCK_KEY);
    if (!lock) return null;
    try {
      return await this.pass(now);
    } finally {
      await lock.release();
    }
  }

  private async pass(now: Date): Promise<ShiftFuelPassSummary> {
    const { placed, ambiguous } = await this.machines();
    const summary: ShiftFuelPassSummary = {
      at: now.toISOString(), machines: placed.size, ambiguous, synced: false,
      read: 0, invalid: 0, inserted: 0, revised: 0, forecastsIssued: 0,
    };
    if (ambiguous.length) {
      this.logger.warn(`Equipment number(s) held by more than one account, not synced: ${ambiguous.join(', ')}.`);
    }
    if (placed.size === 0) return summary;

    if (this.legacy.configured) {
      const since = addDays(indiaDate(now), -SYNC_LOOKBACK_DAYS);
      const rows = await this.legacy.read([...placed.keys()].sort(), since);
      summary.read = rows.length;
      summary.synced = true;

      const byTenant = new Map<string, Map<string, CleanRow>>();
      for (const raw of rows) {
        const row = clean(raw);
        const machine = placed.get(raw.equnr);
        if (!row || !machine) {
          summary.invalid += 1;
          continue;
        }
        const rowsOf = byTenant.get(machine.tenantId) ?? new Map<string, CleanRow>();
        // Unique upstream on (equnr, sdate, shift), so a repeat is not expected; if one
        // comes, the newer revision wins rather than the statement failing on itself.
        const key = `${row.externalId}|${row.sdate}|${row.shift}`;
        const seen = rowsOf.get(key);
        if (!seen || (row.legacyUpdatedAt?.getTime() ?? 0) >= (seen.legacyUpdatedAt?.getTime() ?? 0)) rowsOf.set(key, row);
        byTenant.set(machine.tenantId, rowsOf);
      }
      if (summary.invalid) this.logger.warn(`${summary.invalid} shift row(s) from the existing platform refused.`);

      for (const [tenantId, rowsOf] of byTenant) {
        const { inserted, revised } = await withTenantId(this.ds, tenantId, (m) => this.upsert(m, tenantId, [...rowsOf.values()], now));
        summary.inserted += inserted;
        summary.revised += revised;
      }
    }

    const tenants = new Map<string, string[]>();
    for (const machine of placed.values()) {
      if (!machine.active) continue;
      tenants.set(machine.tenantId, [...(tenants.get(machine.tenantId) ?? []), machine.externalId]);
    }
    for (const [tenantId, externalIds] of tenants) {
      summary.forecastsIssued += await withTenantId(this.ds, tenantId, (m) => this.forecast(m, tenantId, externalIds, now));
    }
    return summary;
  }

  /**
   * Every 2.0-created machine, by equipment number, and the numbers two accounts share.
   * Public so the nowcast (D52) places machines by this same rule rather than a copy of it.
   */
  async machines(): Promise<{ placed: Map<string, Machine>; ambiguous: string[] }> {
    const profiles = await runTenantSpanning(this.ds, 'shift fuel: placing equipment numbers', (m) =>
      m.getRepository(EquipmentProfile).find({
        where: { sourceSystem: CLIENT_SOURCE_SYSTEM },
        select: { tenantId: true, externalId: true, status: true },
      }));
    const byNumber = new Map<string, Machine[]>();
    for (const p of profiles) {
      byNumber.set(p.externalId, [...(byNumber.get(p.externalId) ?? []),
        { tenantId: p.tenantId, externalId: p.externalId, active: p.status === 'active' }]);
    }
    const placed = new Map<string, Machine>();
    const ambiguous: string[] = [];
    for (const [number, machines] of byNumber) {
      if (machines.length === 1) placed.set(number, machines[0]);
      else ambiguous.push(number);
    }
    return { placed, ambiguous: ambiguous.sort() };
  }

  /**
   * Insert what is new, rewrite what the existing platform revised, leave the rest alone.
   * The WHERE on the update is what makes a pass over unchanged data write nothing, so
   * `synced_at` says when a row last changed rather than when somebody last looked.
   */
  private async upsert(m: EntityManager, tenantId: string, rows: CleanRow[], now: Date): Promise<{ inserted: number; revised: number }> {
    let inserted = 0;
    let revised = 0;
    for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
      const batch = rows.slice(i, i + ROWS_PER_STATEMENT);
      const written: { inserted: boolean }[] = await m.query(
        `INSERT INTO "legacy_shift_metric"
           ("tenant_id", "source_system", "external_id", "sdate", "shift", "fuel_l", "work_hrs", "legacy_updated_at", "synced_at")
         SELECT $1, $2, x.external_id, x.sdate, x.shift, x.fuel_l, x.work_hrs, x.legacy_updated_at, $3
           FROM unnest($4::text[], $5::date[], $6::smallint[], $7::numeric[], $8::numeric[], $9::timestamptz[])
             AS x(external_id, sdate, shift, fuel_l, work_hrs, legacy_updated_at)
         ON CONFLICT ("tenant_id", "source_system", "external_id", "sdate", "shift") DO UPDATE
            SET "fuel_l" = EXCLUDED."fuel_l", "work_hrs" = EXCLUDED."work_hrs",
                "legacy_updated_at" = EXCLUDED."legacy_updated_at", "synced_at" = EXCLUDED."synced_at"
          WHERE ("legacy_shift_metric"."fuel_l", "legacy_shift_metric"."work_hrs", "legacy_shift_metric"."legacy_updated_at")
                IS DISTINCT FROM (EXCLUDED."fuel_l", EXCLUDED."work_hrs", EXCLUDED."legacy_updated_at")
         RETURNING (xmax = 0) AS inserted`,
        [
          tenantId, CLIENT_SOURCE_SYSTEM, now,
          batch.map((r) => r.externalId), batch.map((r) => r.sdate), batch.map((r) => r.shift),
          batch.map((r) => r.fuelL), batch.map((r) => r.workHrs),
          batch.map((r) => r.legacyUpdatedAt?.toISOString() ?? null),
        ],
      );
      for (const w of written) {
        if (w.inserted) inserted += 1;
        else revised += 1;
      }
    }
    return { inserted, revised };
  }

  /**
   * Forecast each machine's next shifts from what has been synced, and keep whichever
   * forecast got there first. Insert-if-absent, so a shift is forecast once — by the first
   * pass that could — and a later pass with fresher inputs does not replace it: a forecast
   * that moves after the fact cannot be scored.
   */
  private async forecast(m: EntityManager, tenantId: string, externalIds: string[], now: Date): Promise<number> {
    const newest: { external_id: string; sdate: string; shift: number }[] = await m.query(
      `SELECT DISTINCT ON ("external_id") "external_id", "sdate"::text AS sdate, "shift"::int AS shift
         FROM "legacy_shift_metric"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = ANY($3::text[])
        ORDER BY "external_id", "sdate" DESC, "shift" DESC`,
      [tenantId, CLIENT_SOURCE_SYSTEM, externalIds],
    );
    // A machine with no row at all has nothing to anchor a forecast to; it waits for one.
    const targets = newest.flatMap((n) => targetShifts({ sdate: n.sdate, shift: n.shift as 1 | 2 }, now)
      .map((t) => ({ externalId: n.external_id, ...t })));
    if (targets.length === 0) return 0;

    const dates = targets.map((t) => t.sdate).sort();
    const history: (ShiftObservation & { external_id: string })[] = (await m.query(
      `SELECT "external_id", "sdate"::text AS sdate, "shift"::int AS shift, "fuel_l"::float8 AS fuel_l
         FROM "legacy_shift_metric"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = ANY($3::text[])
          AND "sdate" >= $4::date AND "sdate" < $5::date`,
      [tenantId, CLIENT_SOURCE_SYSTEM, [...new Set(targets.map((t) => t.externalId))],
        addDays(dates[0], -HISTORY_DAYS), dates[dates.length - 1]],
    )).map((r: { external_id: string; sdate: string; shift: 1 | 2; fuel_l: number | null }) => ({
      external_id: r.external_id, sdate: r.sdate, shift: r.shift, fuelL: r.fuel_l,
    }))
      // The existing platform opens a shift's row when the shift starts and fills it as it
      // runs. Read as history, a shift ten minutes old is one that burned almost nothing,
      // and as the newest of its kind it would carry half the forecast's weight.
      .filter((h) => shiftEnd({ sdate: h.sdate, shift: h.shift }) <= now);

    const rows = targets.map((t) => ({
      ...t, ...forecastShift(history.filter((h) => h.external_id === t.externalId), t as ShiftKey),
    }));
    const issued: unknown[] = await m.query(
      `INSERT INTO "shift_fuel_forecast"
         ("tenant_id", "source_system", "external_id", "sdate", "shift", "predicted_l", "method", "inputs_through", "issued_at")
       SELECT $1, $2, x.external_id, x.sdate, x.shift, x.predicted_l, $3, x.inputs_through, $4
         FROM unnest($5::text[], $6::date[], $7::smallint[], $8::numeric[], $9::date[])
           AS x(external_id, sdate, shift, predicted_l, inputs_through)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "sdate", "shift", "method") DO NOTHING
       RETURNING 1`,
      [
        tenantId, CLIENT_SOURCE_SYSTEM, SHIFT_FUEL_METHOD, now,
        rows.map((r) => r.externalId), rows.map((r) => r.sdate), rows.map((r) => r.shift),
        rows.map((r) => r.predictedL), rows.map((r) => r.inputsThrough),
      ],
    );
    return issued.length;
  }
}

/**
 * A row as 2.0 will hold it, or null when it cannot be held honestly. Refused rather than
 * repaired: a negative litre count is a fault upstream, and clamping it to zero would
 * record a shift that burned nothing.
 */
function clean(raw: LegacyShiftMetricRow): CleanRow | null {
  const shift = Number(raw.shift);
  if (shift !== 1 && shift !== 2) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.sdate ?? '')) return null;
  const fuelL = figure(raw.fuel_consumption);
  const workHrs = figure(raw.work_hrs_new);
  if (fuelL === undefined || workHrs === undefined) return null;
  const legacyUpdatedAt = raw.updated_at ? new Date(raw.updated_at) : null;
  if (legacyUpdatedAt && Number.isNaN(legacyUpdatedAt.getTime())) return null;
  return { externalId: raw.equnr, sdate: raw.sdate, shift, fuelL, workHrs, legacyUpdatedAt };
}

/** null stays null; a number must be a finite non-negative one; anything else is undefined (refused). */
function figure(value: string | number | null): number | null | undefined {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
