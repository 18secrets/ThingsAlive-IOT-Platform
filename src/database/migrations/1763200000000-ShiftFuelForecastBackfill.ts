import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Back-calculated shift fuel forecasts (D54). D50 forecasts a shift before it ends, and
 * only from the day it went live, so the accuracy page had nothing to score for the weeks
 * of shift history already synced. A back-calculated forecast is what D50's method gives
 * for a past shift from the shifts that had ended before it started — the same inputs the
 * live pass would have had, so it scores the method, not hindsight.
 *
 * It is never passed off as one issued live. `backfilled` says so, and `issued_at` stays
 * the true moment it was written, which for a past shift is after the shift ended: the
 * rule that a forecast is issued before its shift ends now holds for every row that is not
 * back-calculated, and only for those. The app role cannot write the column at all — its
 * INSERT is narrowed to the columns the hourly pass writes — so a live forecast cannot be
 * marked back-calculated to slip past that rule, nor the reverse; back-calculating is an
 * owner's job, run once by hand.
 */
export class ShiftFuelForecastBackfill1763200000000 implements MigrationInterface {
  name = 'ShiftFuelForecastBackfill1763200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "shift_fuel_forecast" ADD COLUMN "backfilled" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "shift_fuel_forecast" DROP CONSTRAINT "ck_shift_fuel_forecast_in_time"`);
    await q.query(`ALTER TABLE "shift_fuel_forecast" ADD CONSTRAINT "ck_shift_fuel_forecast_in_time"
      CHECK ("backfilled" OR "issued_at" < "ends_at")`);
    await q.query(`REVOKE INSERT ON "shift_fuel_forecast" FROM "ta_app"`);
    await q.query(`GRANT INSERT ("id", "tenant_id", "source_system", "external_id", "sdate", "shift", "predicted_l",
      "method", "inputs_through", "issued_at") ON "shift_fuel_forecast" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The old rule cannot hold a back-calculated row, and nothing else can tell one apart.
    await q.query(`DELETE FROM "shift_fuel_forecast" WHERE "backfilled"`);
    await q.query(`REVOKE INSERT ("id", "tenant_id", "source_system", "external_id", "sdate", "shift", "predicted_l",
      "method", "inputs_through", "issued_at") ON "shift_fuel_forecast" FROM "ta_app"`);
    await q.query(`GRANT INSERT ON "shift_fuel_forecast" TO "ta_app"`);
    await q.query(`ALTER TABLE "shift_fuel_forecast" DROP CONSTRAINT "ck_shift_fuel_forecast_in_time"`);
    await q.query(`ALTER TABLE "shift_fuel_forecast" ADD CONSTRAINT "ck_shift_fuel_forecast_in_time" CHECK ("issued_at" < "ends_at")`);
    await q.query(`ALTER TABLE "shift_fuel_forecast" DROP COLUMN "backfilled"`);
  }
}
