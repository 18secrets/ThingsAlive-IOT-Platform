import { DataSource } from 'typeorm';
import { FORECAST_RETENTION_DAYS } from '../src/forecast/forecast-band';
import { WARM_START_DAYS } from '../src/forecast/forecast-warm-start';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ForecastWarmStartNinetyDays1762700000000';
const SS = 'ta-2.0';

/**
 * The warm start's window grew from twenty-one days to the band's ninety, and a signal is
 * replayed once. So what the shorter replay wrote is cleared, and every signal is owed
 * again; what a live pass measured is not the replay's to clear.
 */
describeDb(`${MIGRATION}: every signal replays again, over ninety days`, () => {
  let owner: DataSource;
  let modelId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { await owner?.destroy(); });

  it('replays the band\'s whole window: residuals older than it are purged and never read', () => {
    expect(WARM_START_DAYS).toBe(FORECAST_RETENTION_DAYS);
  });

  it('clears the replay\'s residuals and "too little history" records; live residuals and other skips stay; down keeps it', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ id: pass }] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES (now(), now(), 3600, $1, 'completed') RETURNING id`, [modelId]);
    const [{ id: warm }] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome, kind)
      VALUES (now(), now(), 3600, $1, 'completed', 'warm_start') RETURNING id`, [modelId]);
    const residual = (runId: string, at: string, origin: string) => owner.query(
      `INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
         lead_steps, predicted, actual, residual, operating, origin)
       VALUES ('acme', $1, 'G-1', 'fuel_consumption', $2, $3, $4, 1, 10, 11, 1, true, $5)`,
      [SS, modelId, runId, at, origin]);
    await residual(pass, '2026-10-26T10:00:00Z', 'live');
    await residual(warm, '2026-10-20T10:00:00Z', 'backtest');
    await residual(warm, '2026-10-21T10:00:00Z', 'backtest');
    const skip = (runId: string, ext: string, reason: string) => owner.query(
      `INSERT INTO forecast_run_skip (tenant_id, run_id, source_system, external_id, signal, reason)
       VALUES ('acme', $1, $2, $3, 'fuel_consumption', $4)`, [runId, SS, ext, reason]);
    await skip(warm, 'G-2', 'warm_start_no_history');
    await skip(pass, 'G-3', 'stale');

    await owner.runMigrations({ transaction: 'all' });

    expect(await owner.query(`SELECT origin, step_at FROM forecast_residual ORDER BY step_at`))
      .toEqual([{ origin: 'live', step_at: new Date('2026-10-26T10:00:00Z') }]);
    expect(await owner.query(`SELECT external_id, reason FROM forecast_run_skip`)).toEqual([{ external_id: 'G-3', reason: 'stale' }]);
    // The runs are the ledger: they stay, so a band's history says a replay once happened.
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_run`)).toEqual([{ n: 2 }]);

    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_residual`)).toEqual([{ n: 1 }]);
    await owner.runMigrations({ transaction: 'all' });
  });
});
