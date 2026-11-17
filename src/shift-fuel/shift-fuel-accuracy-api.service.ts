import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { withTenantSession } from '../scope/tenant-session';
import {
  AccuracyQuery, FleetAccuracy, isCompleted, MachineAccuracy, PerCheckpoint, scoreAccuracy, ShiftOutcome,
} from './shift-fuel-accuracy';
import { indiaDate, SHIFT_FUEL_METHOD, ShiftNo } from './shift-fuel-forecast';
import { SHIFT_FUEL_NOWCAST_METHOD } from './shift-fuel-nowcast';

export interface MachineAccuracyView extends MachineAccuracy {
  name: string | null;
}

export interface ShiftFuelAccuracy extends AccuracyQuery {
  asOf: string;
  fleet: FleetAccuracy;
  machines: MachineAccuracyView[];
  /** The newest day with a completed shift the existing platform has totalled, in range or not. */
  latestDataDate: string | null;
}

interface ActualRow {
  source_system: string; external_id: string; name: string | null; sdate: string; shift: ShiftNo;
  fuel_l: number; predicted_l: number | null;
}

interface CheckpointRow {
  source_system: string; external_id: string; sdate: string; shift: ShiftNo;
  c2: number | null; c4: number | null; c6: number | null;
}

/**
 * How accurate the shift fuel forecast has been (D53), over HTTP. Reads only 2.0's own
 * tables — the hourly sync's copy of the existing platform's totals, and what D50 and D52
 * wrote before each shift ended — so the page keeps itself current with nothing asking
 * the existing platform anything on a request.
 *
 * The SQL fetches; `shift-fuel-accuracy.ts` decides. Which shifts count and how a miss is
 * summed are a definition the user signed off, and a definition split between a query and
 * a function is two definitions.
 */
@Injectable()
export class ShiftFuelAccuracyApiService {
  constructor(private readonly ds: DataSource) {}

  async accuracy(scope: RequestScope, query: AccuracyQuery, at: Date = new Date()): Promise<ShiftFuelAccuracy> {
    const head = { ...query, asOf: at.toISOString() };
    if (scope.equipmentIds !== undefined && scope.equipmentIds.length === 0) {
      return { ...head, fleet: scoreAccuracy([], query.level, at).fleet, machines: [], latestDataDate: null };
    }
    const ids = scope.equipmentIds ? [...scope.equipmentIds] : null;

    return withTenantSession(this.ds, scope, async (m) => {
      // One at a time: all three share this transaction's connection.
      const actuals: ActualRow[] = await m.query(
        `SELECT a."source_system", a."external_id", p."name", a."sdate"::text AS sdate, a."shift"::int AS shift,
                a."fuel_l"::float8 AS fuel_l, f."predicted_l"::float8 AS predicted_l
           FROM "legacy_shift_metric" a
           JOIN "equipment_profile" p
             ON p."tenant_id" = a."tenant_id" AND p."source_system" = a."source_system" AND p."external_id" = a."external_id"
           LEFT JOIN "shift_fuel_forecast" f
             ON f."tenant_id" = a."tenant_id" AND f."source_system" = a."source_system" AND f."external_id" = a."external_id"
            AND f."sdate" = a."sdate" AND f."shift" = a."shift" AND f."method" = $2
          WHERE a."tenant_id" = $1 AND a."sdate" BETWEEN $3::date AND $4::date
            -- A row with no figure is the existing platform not knowing; scoring it as
            -- zero would mark every forecast for it wrong.
            AND a."fuel_l" IS NOT NULL
            AND ($5::text[] IS NULL OR a."external_id" = ANY($5::text[]))`,
        [scope.tenantId, SHIFT_FUEL_METHOD, query.from, query.to, ids],
      );

      // Each checkpoint is the newest snapshot at or before it, per shift, in one pass over
      // the first six hours' snapshots: three lookups per machine-shift would read the same
      // rows three times over a 92-day range.
      const checkpoints: CheckpointRow[] = await m.query(
        `SELECT "source_system", "external_id", "sdate"::text AS sdate, "shift"::int AS shift,
                (array_agg("predicted_l"::float8 ORDER BY "as_of" DESC) FILTER (WHERE "as_of" <= "starts_at" + interval '2 hours'))[1] AS c2,
                (array_agg("predicted_l"::float8 ORDER BY "as_of" DESC) FILTER (WHERE "as_of" <= "starts_at" + interval '4 hours'))[1] AS c4,
                (array_agg("predicted_l"::float8 ORDER BY "as_of" DESC) FILTER (WHERE "as_of" <= "starts_at" + interval '6 hours'))[1] AS c6
           FROM "shift_fuel_nowcast"
          WHERE "tenant_id" = $1 AND "method" = $2 AND "sdate" BETWEEN $3::date AND $4::date
            AND "as_of" <= "starts_at" + interval '6 hours'
            AND ($5::text[] IS NULL OR "external_id" = ANY($5::text[]))
          GROUP BY "source_system", "external_id", "sdate", "shift"`,
        [scope.tenantId, SHIFT_FUEL_NOWCAST_METHOD, query.from, query.to, ids],
      );

      // The newest few shifts with a figure, not just the newest day: up to three shifts
      // dated today or yesterday can still be running or not yet started, and the newest
      // *completed* one is what "the latest day with data" means.
      const recent: { sdate: string; shift: ShiftNo }[] = await m.query(
        `SELECT "sdate"::text AS sdate, "shift"::int AS shift
           FROM "legacy_shift_metric"
          WHERE "tenant_id" = $1 AND "fuel_l" IS NOT NULL AND "sdate" <= $2::date
            AND ($3::text[] IS NULL OR "external_id" = ANY($3::text[]))
          GROUP BY "sdate", "shift"
          ORDER BY "sdate" DESC, "shift" DESC
          LIMIT 4`,
        [scope.tenantId, indiaDate(at), ids],
      );

      const key = (r: { source_system: string; external_id: string; sdate: string; shift: number }) =>
        `${r.source_system}|${r.external_id}|${r.sdate}|${r.shift}`;
      const atCheckpoint = new Map<string, PerCheckpoint<number | null>>(
        checkpoints.map((c) => [key(c), { 2: c.c2, 4: c.c4, 6: c.c6 }]),
      );
      const names = new Map<string, string | null>();
      const outcomes: ShiftOutcome[] = actuals.map((a) => {
        names.set(`${a.source_system}|${a.external_id}`, a.name);
        return {
          sourceSystem: a.source_system, externalId: a.external_id, sdate: a.sdate, shift: a.shift,
          actualL: a.fuel_l, forecastL: a.predicted_l,
          checkpointL: atCheckpoint.get(key(a)) ?? { 2: null, 4: null, 6: null },
        };
      });

      const scored = scoreAccuracy(outcomes, query.level, at);
      return {
        ...head,
        fleet: scored.fleet,
        machines: scored.machines.map((mc) => ({ ...mc, name: names.get(`${mc.sourceSystem}|${mc.externalId}`) ?? null })),
        latestDataDate: recent.find((r) => isCompleted(r, at))?.sdate ?? null,
      };
    });
  }
}
