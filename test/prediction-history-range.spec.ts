import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Prediction history over a date range (test report P3-D4). The history route only
 * took `?take=N`, so a ThingsCare chart of last week on a machine scored every few
 * minutes showed the newest hundred scores and nothing before them.
 */
describeDb('prediction history over a date range', () => {
  let owner: DataSource;
  let ds: DataSource;
  let predictions: PredictionService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const target = { sourceSystem: 'client', externalId: 'PUMP-1', clientScenarioSlug: 'pump-dry-run' };
  // Fixed days, with their partitions built below, so the spec does not depend on when it runs.
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ta_ensure_prediction_partition('2026-10-01'::date)`);
    ds = await createAppDataSource();
    predictions = new PredictionService(ds);
    for (let d = 1; d <= 10; d++) {
      await owner.query(
        `INSERT INTO prediction (occurred_at, tenant_id, source_system, external_id, client_scenario_slug,
                                 severity, risk_score, abnormal_count, confidence, window_days, computed_at)
         VALUES ($1, 'acme', $2, $3, $4, 'none', $5, 0, 'high', 30, $1)`,
        [day(d), target.sourceSystem, target.externalId, target.clientScenarioSlug, d],
      );
    }
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const days = (rows: { riskScore: number }[]) => rows.map((r) => r.riskScore);

  it('returns only the scores inside the range, both ends included, newest first', async () => {
    const rows = await predictions.historyFor(acme, target, 100, { from: day(3), to: day(6) });
    expect(days(rows)).toEqual([6, 5, 4, 3]);
  });

  it('takes an open-ended range from either side', async () => {
    expect(days(await predictions.historyFor(acme, target, 100, { from: day(9) }))).toEqual([10, 9]);
    expect(days(await predictions.historyFor(acme, target, 100, { to: day(2) }))).toEqual([2, 1]);
  });

  it('still caps the count inside a range, keeping the newest', async () => {
    expect(days(await predictions.historyFor(acme, target, 2, { from: day(1), to: day(10) }))).toEqual([10, 9]);
  });

  it('without a range answers exactly as before', async () => {
    expect(days(await predictions.historyFor(acme, target, 3))).toEqual([10, 9, 8]);
  });

  it('refuses a range that ends before it starts, rather than answering with nothing', async () => {
    await expect(predictions.historyFor(acme, target, 100, { from: day(6), to: day(3) }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
