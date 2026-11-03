import { DataSource } from 'typeorm';
import { addDays, forecastShift, HISTORY_DAYS, SHIFT_FUEL_METHOD, shiftEnd, ShiftNo, ShiftObservation } from './shift-fuel-forecast';

export interface BackfillSummary {
  /** Completed shifts in the range the existing platform totalled and nothing had forecast. */
  targets: number;
  written: number;
}

/**
 * Back-calculate D50's forecast for every completed shift in `from`..`to` that has a synced
 * total and no forecast yet (D54). Each is `forecastShift` over the same machine's synced
 * shifts — which only ever reads earlier days of the same shift, so nothing the live pass
 * could not have seen before the shift started. Written as `backfilled`, with the true
 * `issued_at`, and never over a forecast already there: a live one always wins.
 *
 * Needs the owner's connection: the app role cannot write `backfilled`. Every account's
 * machines are covered in one pass, each machine's history read inside its own account.
 */
export async function backfillShiftFuelForecasts(
  owner: DataSource, range: { from: string; to: string }, now: Date = new Date(),
): Promise<BackfillSummary> {
  return owner.transaction(async (m) => {
    await m.query(`SELECT set_config('ta.bypass', 'on', true)`);
    const targets: { tenant_id: string; source_system: string; external_id: string; sdate: string; shift: ShiftNo }[] = await m.query(
      `SELECT a."tenant_id", a."source_system", a."external_id", a."sdate"::text AS sdate, a."shift"::int AS shift
         FROM "legacy_shift_metric" a
        WHERE a."sdate" BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM "shift_fuel_forecast" f
                           WHERE f."tenant_id" = a."tenant_id" AND f."source_system" = a."source_system"
                             AND f."external_id" = a."external_id" AND f."sdate" = a."sdate"
                             AND f."shift" = a."shift" AND f."method" = $3)`,
      [range.from, range.to, SHIFT_FUEL_METHOD],
    );
    // A shift still running has no total to be scored against yet; the live pass has it.
    const due = targets.filter((t) => shiftEnd({ sdate: t.sdate, shift: t.shift }) <= now);
    if (due.length === 0) return { targets: 0, written: 0 };

    const history: (ShiftObservation & { key: string })[] = (await m.query(
      `SELECT "tenant_id", "source_system", "external_id", "sdate"::text AS sdate, "shift"::int AS shift, "fuel_l"::float8 AS fuel_l
         FROM "legacy_shift_metric"
        WHERE "sdate" >= $1::date AND "sdate" < $2::date`,
      [addDays(range.from, -HISTORY_DAYS), range.to],
    )).map((r: { tenant_id: string; source_system: string; external_id: string; sdate: string; shift: ShiftNo; fuel_l: number | null }) => ({
      key: `${r.tenant_id}|${r.source_system}|${r.external_id}`, sdate: r.sdate, shift: r.shift, fuelL: r.fuel_l,
    }));
    const byMachine = new Map<string, ShiftObservation[]>();
    for (const h of history) {
      const list = byMachine.get(h.key);
      if (list) list.push(h);
      else byMachine.set(h.key, [h]);
    }

    const rows = due.map((t) => ({
      ...t, ...forecastShift(byMachine.get(`${t.tenant_id}|${t.source_system}|${t.external_id}`) ?? [], t),
    }));
    const written: unknown[] = await m.query(
      `INSERT INTO "shift_fuel_forecast"
         ("tenant_id", "source_system", "external_id", "sdate", "shift", "predicted_l", "method", "inputs_through", "issued_at", "backfilled")
       SELECT x.tenant_id, x.source_system, x.external_id, x.sdate, x.shift, x.predicted_l, $1, x.inputs_through, $2, true
         FROM unnest($3::text[], $4::text[], $5::text[], $6::date[], $7::smallint[], $8::numeric[], $9::date[])
           AS x(tenant_id, source_system, external_id, sdate, shift, predicted_l, inputs_through)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "sdate", "shift", "method") DO NOTHING
       RETURNING 1`,
      [
        SHIFT_FUEL_METHOD, now,
        rows.map((r) => r.tenant_id), rows.map((r) => r.source_system), rows.map((r) => r.external_id),
        rows.map((r) => r.sdate), rows.map((r) => r.shift), rows.map((r) => r.predictedL), rows.map((r) => r.inputsThrough),
      ],
    );
    return { targets: due.length, written: written.length };
  });
}
