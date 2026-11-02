import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentRef } from '../kpi/types';
import { withTenantSession } from '../scope/tenant-session';
import { runningShift, SHIFT_FUEL_NOWCAST_METHOD } from './shift-fuel-nowcast';

/** The newest snapshot of one machine's running shift (D52). */
export interface ShiftFuelNowcastView {
  sdate: string;
  shift: 1 | 2;
  startsAt: string;
  endsAt: string;
  method: string;
  /** The tick the snapshot describes. */
  asOf: string;
  /** When the newest counter reading it used was taken; far behind asOf means a stale feed. */
  counterAt: string;
  soFarL: number;
  /** The pre-shift forecast it took a share of, and whether that was issued or computed. */
  baseL: number;
  baseSource: 'issued' | 'computed';
  predictedL: number;
}

export interface FleetShiftFuelNowcast extends ShiftFuelNowcastView {
  sourceSystem: string;
  externalId: string;
  name: string | null;
}

interface Row {
  source_system: string; external_id: string; name: string | null; sdate: string; shift: 1 | 2;
  starts_at: Date; ends_at: Date; as_of: Date; counter_at: Date;
  so_far_l: number; base_l: number; base_source: 'issued' | 'computed'; predicted_l: number; method: string;
}

/**
 * The nowcast over HTTP, beside D50's forecast rather than inside its service, so the two
 * change apart. Reads only, like D50's: a snapshot the pass has not written is absent, never
 * made on request — one made by a request would have no tick and nobody could score it.
 *
 * Only the running shift: once a shift ends the existing platform's total replaces every
 * guess at it, and the snapshots stay in the table for scoring, not for display.
 */
@Injectable()
export class ShiftFuelNowcastApiService {
  constructor(private readonly ds: DataSource) {}

  /**
   * D50's per-machine answer with the nowcast beside it. Added, never merged in: every
   * field D50 returns comes back unchanged, so a reader of the forecast is not broken by it.
   */
  async besideMachine<T extends object>(scope: RequestScope, ref: EquipmentRef, forecast: T, at: Date = new Date()): Promise<T & { nowcast: ShiftFuelNowcastView | null }> {
    return { ...forecast, nowcast: await this.machine(scope, ref, at) };
  }

  /** D50's fleet answer with each machine's nowcast beside it, on the same terms. */
  async besideFleet<T extends object>(scope: RequestScope, forecast: T, at: Date = new Date()): Promise<T & { nowcasts: FleetShiftFuelNowcast[] }> {
    return { ...forecast, nowcasts: await this.fleet(scope, at) };
  }

  /** This machine's newest snapshot of the shift under way at `at`, or null when there is none. */
  async machine(scope: RequestScope, ref: EquipmentRef, at: Date = new Date()): Promise<ShiftFuelNowcastView | null> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    const [row] = await this.latest(scope, at, ref);
    return row ? view(row) : null;
  }

  /** Each machine in scope with a snapshot of the shift under way at `at`: its newest one. */
  async fleet(scope: RequestScope, at: Date = new Date()): Promise<FleetShiftFuelNowcast[]> {
    if (scope.equipmentIds !== undefined && scope.equipmentIds.length === 0) return [];
    const rows = await this.latest(scope, at, null);
    return rows.map((r) => ({ sourceSystem: r.source_system, externalId: r.external_id, name: r.name, ...view(r) }));
  }

  /** Newest snapshot per machine of the shift under way at `at`; one machine's when `ref` is given. */
  private latest(scope: RequestScope, at: Date, ref: EquipmentRef | null): Promise<Row[]> {
    const key = runningShift(at);
    return withTenantSession(this.ds, scope, (m) => m.query(
      `SELECT DISTINCT ON (n."source_system", n."external_id")
              n."source_system", n."external_id", p."name", n."sdate"::text AS sdate, n."shift"::int AS shift,
              n."starts_at", n."ends_at", n."as_of", n."counter_at",
              n."so_far_l"::float8 AS so_far_l, n."base_l"::float8 AS base_l, n."base_source",
              n."predicted_l"::float8 AS predicted_l, n."method"
         FROM "shift_fuel_nowcast" n
         JOIN "equipment_profile" p
           ON p."tenant_id" = n."tenant_id" AND p."source_system" = n."source_system" AND p."external_id" = n."external_id"
        WHERE n."tenant_id" = $1 AND n."method" = $2 AND n."sdate" = $3::date AND n."shift" = $4 AND n."as_of" <= $5
          AND ($6::text[] IS NULL OR n."external_id" = ANY($6::text[]))
          AND ($7::text IS NULL OR (n."source_system" = $7 AND n."external_id" = $8))
        ORDER BY n."source_system", n."external_id", n."as_of" DESC`,
      [
        scope.tenantId, SHIFT_FUEL_NOWCAST_METHOD, key.sdate, key.shift, at,
        scope.equipmentIds ? [...scope.equipmentIds] : null,
        ref?.sourceSystem ?? null, ref?.externalId ?? null,
      ],
    ));
  }
}

function view(r: Row): ShiftFuelNowcastView {
  return {
    sdate: r.sdate, shift: r.shift,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    method: r.method, asOf: new Date(r.as_of).toISOString(), counterAt: new Date(r.counter_at).toISOString(),
    soFarL: r.so_far_l, baseL: r.base_l, baseSource: r.base_source, predictedL: r.predicted_l,
  };
}
