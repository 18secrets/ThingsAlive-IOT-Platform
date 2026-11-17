import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { withTenantId } from '../src/scope/tenant-session';
import { ShiftFuelAccuracyApiService } from '../src/shift-fuel/shift-fuel-accuracy-api.service';
import { backfillShiftFuelForecasts } from '../src/shift-fuel/shift-fuel-backfill';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ShiftFuelForecastBackfill1763200000000';

/**
 * Back-calculated forecasts (D54): the accuracy page had weeks of synced shift totals and
 * nothing to score them against, because D50 forecasts only from the day it went live.
 * Each past shift gets what D50's method gives from the shifts before it, marked as
 * back-calculated, with the true time it was written; a live forecast always wins.
 *
 * Run at 04:00 UTC on 22 October: the 22nd's day shift (02:30-14:30 UTC) is running.
 */
describeDb('shift fuel forecast: back-calculated for past shifts', () => {
  let owner: DataSource;
  let ds: DataSource;

  const NOW = new Date('2026-10-22T04:00:00Z');
  const RANGE = { from: '2026-10-20', to: '2026-10-22' };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

  const forecasts = (tenantId: string, externalId: string) => withTenantId(ds, tenantId, (m) => m.query(
    `SELECT "sdate"::text AS sdate, "shift"::int AS shift, "predicted_l"::float8 AS predicted, "inputs_through"::text AS inputs,
            "backfilled", "issued_at"
       FROM "shift_fuel_forecast" WHERE "external_id" = $1 ORDER BY "sdate", "shift"`,
    [externalId],
  ));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    for (const t of ['acme', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    const machine = (tenant: string, externalId: string) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, status, name) VALUES ($1, 'ta-2.0', $2, 'active', $2)`,
      [tenant, externalId],
    );
    await machine('acme', 'EQ-1');
    await machine('acme', 'EQ-2');
    // The same number in another account: its own history, never acme's.
    await machine('globex', 'EQ-1');

    const actual = (tenant: string, externalId: string, sdate: string, shift: 1 | 2, fuel: number) => owner.query(
      `INSERT INTO legacy_shift_metric (tenant_id, source_system, external_id, sdate, shift, fuel_l) VALUES ($1, 'ta-2.0', $2, $3, $4, $5)`,
      [tenant, externalId, sdate, shift, fuel],
    );
    await actual('acme', 'EQ-1', '2026-10-18', 1, 100);
    await actual('acme', 'EQ-1', '2026-10-19', 1, 200);
    await actual('acme', 'EQ-1', '2026-10-19', 2, 40);
    await actual('acme', 'EQ-1', '2026-10-20', 1, 120);
    await actual('acme', 'EQ-1', '2026-10-20', 2, 60);
    await actual('acme', 'EQ-1', '2026-10-21', 1, 180);
    await actual('acme', 'EQ-1', '2026-10-21', 2, 50);
    await actual('acme', 'EQ-1', '2026-10-22', 1, 5); // running at NOW
    // EQ-2 went live in time for the 21st's day shift: that one is the live pass's.
    await actual('acme', 'EQ-2', '2026-10-20', 1, 30);
    await actual('acme', 'EQ-2', '2026-10-21', 1, 35);
    await owner.query(
      `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, inputs_through, issued_at)
       VALUES ('acme', 'ta-2.0', 'EQ-2', '2026-10-21', 1, 31, 'ewma-0.5-28d', '2026-10-20', '2026-10-21T00:00:00Z')`,
    );
    await actual('globex', 'EQ-1', '2026-10-19', 1, 900);
    await actual('globex', 'EQ-1', '2026-10-20', 1, 1000);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await owner?.destroy();
  });

  it('forecasts each completed shift with none from the shifts before it, and marks it', async () => {
    expect(await backfillShiftFuelForecasts(owner, RANGE, NOW)).toEqual({ targets: 6, written: 6 });

    const rows = await forecasts('acme', 'EQ-1');
    expect(rows.map(({ sdate, shift, predicted, inputs, backfilled }) => ({ sdate, shift, predicted, inputs, backfilled }))).toEqual([
      // Day shifts: 100, 200 -> 150; then 100, 200, 120 -> 135.
      { sdate: '2026-10-20', shift: 1, predicted: 150, inputs: '2026-10-19', backfilled: true },
      // Night shifts: 40; then 40, 60 -> 50.
      { sdate: '2026-10-20', shift: 2, predicted: 40, inputs: '2026-10-19', backfilled: true },
      { sdate: '2026-10-21', shift: 1, predicted: 135, inputs: '2026-10-20', backfilled: true },
      { sdate: '2026-10-21', shift: 2, predicted: 50, inputs: '2026-10-20', backfilled: true },
    ]);
    // Written when it was written, after the shifts it is for had ended — not dated back.
    expect(new Set(rows.map((r: { issued_at: Date }) => r.issued_at.toISOString()))).toEqual(new Set([NOW.toISOString()]));
  });

  it('leaves a live forecast alone, and the shift still running to the live pass', async () => {
    const eq2 = await forecasts('acme', 'EQ-2');
    expect(eq2.map(({ sdate, predicted, backfilled }: { sdate: string; predicted: number; backfilled: boolean }) => ({ sdate, predicted, backfilled })))
      .toEqual([
        { sdate: '2026-10-20', predicted: 0, backfilled: true }, // nothing before it: no evidence of burn
        { sdate: '2026-10-21', predicted: 31, backfilled: false },
      ]);
    expect((await forecasts('acme', 'EQ-1')).find((r: { sdate: string }) => r.sdate === '2026-10-22')).toBeUndefined();
  });

  it('reads each account\'s machine from its own history', async () => {
    const rows = await forecasts('globex', 'EQ-1');
    expect(rows.map(({ sdate, predicted }: { sdate: string; predicted: number }) => ({ sdate, predicted }))).toEqual([
      { sdate: '2026-10-20', predicted: 900 },
    ]);
  });

  it('a second run, and two at once, write nothing more', async () => {
    const [a, b] = await Promise.allSettled([
      backfillShiftFuelForecasts(owner, RANGE, NOW), backfillShiftFuelForecasts(owner, RANGE, NOW),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM shift_fuel_forecast WHERE backfilled`);
    expect(n).toBe(6);
  });

  it('the page scores them like any forecast', async () => {
    const r = await new ShiftFuelAccuracyApiService(ds).accuracy(acme, { from: '2026-10-20', to: '2026-10-21', level: 'range' }, NOW);
    // EQ-1: 150 + 40 + 135 + 50 = 375 against 410. EQ-2: 0 + 31 against 65.
    expect(r.fleet).toMatchObject({ actualL: 475, forecastL: 406, shiftsWithoutForecast: 0 });
  });

  describe('what the database refuses', () => {
    it('the app role writing the backfilled column at all, even as false', async () => {
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, issued_at, backfilled)
         VALUES ('acme', 'ta-2.0', 'EQ-2', '2026-10-25', 1, 1, 'ewma-0.5-28d', '2026-10-24T00:00:00Z', false)`,
      ))).rejects.toThrow(/permission denied/);
    });

    it('but still lets it write a live forecast as the hourly pass does', async () => {
      await withTenantId(ds, 'acme', (m) => m.query(
        `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, inputs_through, issued_at)
         VALUES ('acme', 'ta-2.0', 'EQ-2', '2026-10-25', 1, 1, 'ewma-0.5-28d', '2026-10-21', '2026-10-24T00:00:00Z')`,
      ));
      await owner.query(`DELETE FROM shift_fuel_forecast WHERE sdate = '2026-10-25'`);
    });

    it('a live forecast written after its shift ended, even by the owner', async () => {
      await expect(owner.query(
        `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, issued_at)
         VALUES ('acme', 'ta-2.0', 'EQ-2', '2026-10-19', 1, 1, 'ewma-0.5-28d', '2026-10-22T00:00:00Z')`,
      )).rejects.toThrow(/ck_shift_fuel_forecast_in_time/);
    });
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    // Down takes the back-calculated rows with it; the live one stays.
    expect(await owner.query(`SELECT count(*)::int AS n FROM shift_fuel_forecast`)).toEqual([{ n: 1 }]);
    expect(await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'shift_fuel_forecast' AND column_name = 'backfilled'`,
    )).toEqual([{ n: 0 }]);
    await owner.runMigrations({ transaction: 'all' });
  }, 60_000);
});
