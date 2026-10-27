import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forecast residuals that came from a backtest over history, told apart from live ones.
 *
 * A forecast band needs fourteen days of steady running residuals before it may judge
 * anything (D20), and the live pass makes them at the rate time passes: a machine
 * onboarded with months of history waited weeks for forecast-based detection while that
 * history sat unused. The warm start (`forecast-warm-start.ts`) replays the pass over the
 * history instead — the active model, forecasting from the context each past moment had,
 * judged against what then happened — and writes the residuals the pass would have.
 *
 * They are real forecast errors of the model in use, computed after the fact, which is a
 * different provenance from a live residual even when the numbers would be the same. So
 * each says which it is (`origin`), and so does the run that made it (`kind`): whoever
 * asks why a band looks the way it does can see how much of it was learned in replay.
 * A series with too little history to replay is recorded once
 * (`warm_start_no_history`) rather than tried again on every tick.
 *
 * Down removes what the warm start wrote — its residuals, its skip records, its runs —
 * before the columns that say so, so no backtest residual survives looking live.
 */
export class ForecastWarmStart1762600000000 implements MigrationInterface {
  name = 'ForecastWarmStart1762600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "forecast_residual" ADD COLUMN "origin" text NOT NULL DEFAULT 'live'`);
    await q.query(`ALTER TABLE "forecast_residual"
      ADD CONSTRAINT "ck_forecast_residual_origin" CHECK ("origin" IN ('live', 'backtest'))`);

    await q.query(`ALTER TABLE "forecast_run" ADD COLUMN "kind" text NOT NULL DEFAULT 'pass'`);
    await q.query(`ALTER TABLE "forecast_run"
      ADD CONSTRAINT "ck_forecast_run_kind" CHECK ("kind" IN ('pass', 'warm_start'))`);

    await q.query(`ALTER TABLE "forecast_run_skip" DROP CONSTRAINT "ck_forecast_run_skip_reason"`);
    await q.query(`ALTER TABLE "forecast_run_skip" ADD CONSTRAINT "ck_forecast_run_skip_reason" CHECK ("reason" IN (
      'stale', 'no_readings', 'unbound', 'insufficient_coverage', 'gap_at_edge', 'budget_exhausted', 'refused',
      'warm_start_no_history'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "forecast_residual" WHERE "origin" = 'backtest'`);
    await q.query(`DELETE FROM "forecast_run_skip" WHERE "reason" = 'warm_start_no_history'`);
    await q.query(`DELETE FROM "forecast_run" r WHERE r."kind" = 'warm_start'
      AND NOT EXISTS (SELECT 1 FROM "forecast_residual" x WHERE x."run_id" = r."id")`);

    await q.query(`ALTER TABLE "forecast_run_skip" DROP CONSTRAINT "ck_forecast_run_skip_reason"`);
    await q.query(`ALTER TABLE "forecast_run_skip" ADD CONSTRAINT "ck_forecast_run_skip_reason" CHECK ("reason" IN (
      'stale', 'no_readings', 'unbound', 'insufficient_coverage', 'gap_at_edge', 'budget_exhausted', 'refused'))`);

    await q.query(`ALTER TABLE "forecast_run" DROP CONSTRAINT "ck_forecast_run_kind"`);
    await q.query(`ALTER TABLE "forecast_run" DROP COLUMN "kind"`);
    await q.query(`ALTER TABLE "forecast_residual" DROP CONSTRAINT "ck_forecast_residual_origin"`);
    await q.query(`ALTER TABLE "forecast_residual" DROP COLUMN "origin"`);
  }
}
