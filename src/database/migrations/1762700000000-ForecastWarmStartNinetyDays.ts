import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The warm start replays ninety days now, not twenty-one, so what it replayed before is
 * cleared and every signal is owed again.
 *
 * A band needs fourteen days of steady running, and machines that run on some days and
 * not others did not find fourteen in three weeks: on dev's fleet, 21 days gave 9
 * machines a fuel band and 90 gave 29. The warm start replays a signal once — a signal
 * with any backtest residual is done — so without this, every signal already replayed
 * would keep its three weeks for good. Its "too little history" records go too: some of
 * those signals have enough over ninety days.
 *
 * Only what the warm start wrote: live residuals, the pass's own skip records and the
 * runs themselves stay. Down leaves it as it is — what was deleted is replay output,
 * rewritten by the next run, and there is nothing true to restore.
 */
export class ForecastWarmStartNinetyDays1762700000000 implements MigrationInterface {
  name = 'ForecastWarmStartNinetyDays1762700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "forecast_residual" WHERE "origin" = 'backtest'`);
    await q.query(`DELETE FROM "forecast_run_skip" WHERE "reason" = 'warm_start_no_history'`);
  }

  public async down(): Promise<void> {
    // Intentionally empty: see the class comment.
  }
}
