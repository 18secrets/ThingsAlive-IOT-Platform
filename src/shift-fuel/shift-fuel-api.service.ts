import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { EquipmentRef } from '../kpi/types';
import { withTenantSession } from '../scope/tenant-session';
import { LegacyShiftMetric, ShiftFuelForecast } from './shift-fuel.entities';
import { addDays, compareShifts, indiaDate, shiftEnd, shiftFuelMethodFrom, shiftStart } from './shift-fuel-forecast';

/** One shift of one machine: what was forecast, and what the existing platform says happened. */
export interface ShiftFuelRow {
  sdate: string;
  shift: 1 | 2;
  startsAt: string;
  endsAt: string;
  /** Null when no forecast was issued for this shift. */
  predictedL: number | null;
  inputsThrough: string | null;
  issuedAt: string | null;
  /** Null until the existing platform has totalled the shift, or when it has a row and no figure. */
  fuelL: number | null;
  workHrs: number | null;
  syncedAt: string | null;
}

export interface MachineShiftFuel {
  equipment: EquipmentRef;
  method: string;
  asOf: string;
  days: number;
  shifts: ShiftFuelRow[];
}

export interface FleetShiftFuelForecast {
  sourceSystem: string;
  externalId: string;
  name: string | null;
  sdate: string;
  shift: 1 | 2;
  startsAt: string;
  endsAt: string;
  predictedL: number;
  inputsThrough: string | null;
  issuedAt: string;
}

export interface FleetShiftFuel {
  method: string;
  asOf: string;
  forecasts: FleetShiftFuelForecast[];
  /** Per shift, the fleet's forecast litres and how many machines that sum is over. */
  totals: { sdate: string; shift: 1 | 2; predictedL: number; machines: number }[];
}

/** How far back the fleet list looks for a machine's newest forecasts; older is not "latest". */
const FLEET_RECENT_DAYS = 7;

/**
 * The shift fuel forecast over HTTP (D50). Reads only: a forecast the pass has not issued
 * is absent here, never computed on request — a second writer beside the pass would be a
 * forecast nobody can say was made in advance.
 */
@Injectable()
export class ShiftFuelApiService {
  constructor(private readonly ds: DataSource) {}

  async machine(scope: RequestScope, ref: EquipmentRef, days: number, at: Date = new Date()): Promise<MachineShiftFuel> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.profile(m, scope, ref);
      const since = addDays(indiaDate(at), -days);
      const where = { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId, sdate: MoreThanOrEqual(since) };
      // One at a time: both share this transaction's connection.
      const forecasts = await m.getRepository(ShiftFuelForecast).find({ where: { ...where, method: shiftFuelMethodFrom(process.env) } });
      const actuals = await m.getRepository(LegacyShiftMetric).find({ where });

      const rows = new Map<string, ShiftFuelRow>();
      const row = (sdate: string, shift: 1 | 2): ShiftFuelRow => {
        const key = `${sdate}|${shift}`;
        const existing = rows.get(key);
        if (existing) return existing;
        const fresh: ShiftFuelRow = {
          sdate, shift,
          startsAt: shiftStart({ sdate, shift }).toISOString(), endsAt: shiftEnd({ sdate, shift }).toISOString(),
          predictedL: null, inputsThrough: null, issuedAt: null, fuelL: null, workHrs: null, syncedAt: null,
        };
        rows.set(key, fresh);
        return fresh;
      };
      for (const f of forecasts) {
        Object.assign(row(f.sdate, f.shift), {
          predictedL: f.predictedL, inputsThrough: f.inputsThrough, issuedAt: f.issuedAt.toISOString(),
        });
      }
      for (const a of actuals) {
        Object.assign(row(a.sdate, a.shift), { fuelL: a.fuelL, workHrs: a.workHrs, syncedAt: a.syncedAt.toISOString() });
      }
      return {
        equipment: { sourceSystem: ref.sourceSystem, externalId: ref.externalId },
        method: shiftFuelMethodFrom(process.env),
        asOf: at.toISOString(),
        days,
        shifts: [...rows.values()].sort(compareShifts),
      };
    });
  }

  /** Each machine's newest two forecasts, and the fleet's sum per shift. */
  async fleet(scope: RequestScope, at: Date = new Date()): Promise<FleetShiftFuel> {
    const empty: FleetShiftFuel = { method: shiftFuelMethodFrom(process.env), asOf: at.toISOString(), forecasts: [], totals: [] };
    if (scope.equipmentIds !== undefined && scope.equipmentIds.length === 0) return empty;

    const rows: {
      source_system: string; external_id: string; name: string | null; sdate: string; shift: 1 | 2;
      predicted_l: number; inputs_through: string | null; issued_at: Date; starts_at: Date; ends_at: Date;
    }[] = await withTenantSession(this.ds, scope, (m) => m.query(
      `SELECT f."source_system", f."external_id", p."name", f."sdate"::text AS sdate, f."shift"::int AS shift,
              f."predicted_l"::float8 AS predicted_l, f."inputs_through"::text AS inputs_through,
              f."issued_at", f."starts_at", f."ends_at"
         FROM (SELECT *, row_number() OVER (PARTITION BY "source_system", "external_id"
                                            ORDER BY "sdate" DESC, "shift" DESC) AS newest
                 FROM "shift_fuel_forecast"
                WHERE "tenant_id" = $1 AND "method" = $2 AND "sdate" >= $3::date) f
         JOIN "equipment_profile" p
           ON p."tenant_id" = f."tenant_id" AND p."source_system" = f."source_system" AND p."external_id" = f."external_id"
        WHERE f.newest <= 2
          AND ($4::text[] IS NULL OR f."external_id" = ANY($4::text[]))
        ORDER BY f."sdate", f."shift", f."external_id"`,
      [scope.tenantId, shiftFuelMethodFrom(process.env), addDays(indiaDate(at), -FLEET_RECENT_DAYS), scope.equipmentIds ? [...scope.equipmentIds] : null],
    ));

    const forecasts = rows.map((r): FleetShiftFuelForecast => ({
      sourceSystem: r.source_system, externalId: r.external_id, name: r.name, sdate: r.sdate, shift: r.shift,
      startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
      predictedL: r.predicted_l, inputsThrough: r.inputs_through, issuedAt: new Date(r.issued_at).toISOString(),
    }));
    const totals = new Map<string, { sdate: string; shift: 1 | 2; predictedL: number; machines: number }>();
    for (const f of forecasts) {
      const t = totals.get(`${f.sdate}|${f.shift}`) ?? { sdate: f.sdate, shift: f.shift, predictedL: 0, machines: 0 };
      t.predictedL = Math.round((t.predictedL + f.predictedL) * 100) / 100;
      t.machines += 1;
      totals.set(`${f.sdate}|${f.shift}`, t);
    }
    return { ...empty, forecasts, totals: [...totals.values()] };
  }

  /** Out of scope answers exactly like absent: the same 404 any equipment route gives. */
  private async profile(m: EntityManager, scope: RequestScope, ref: EquipmentRef): Promise<EquipmentProfile> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    return profile;
  }
}
