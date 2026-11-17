import { DataSource } from 'typeorm';
import { LegacyShiftMetricRow, ShiftMetricsSource } from '../src/legacy/legacy-shift-metrics.reader';
import { withTenantId } from '../src/scope/tenant-session';
import { ShiftFuelForecast } from '../src/shift-fuel/shift-fuel.entities';
import { ShiftFuelService } from '../src/shift-fuel/shift-fuel.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

class FakeShiftMetrics implements ShiftMetricsSource {
  configured = true;
  rows: LegacyShiftMetricRow[] = [];

  async read(equnrs: readonly string[], since: string): Promise<LegacyShiftMetricRow[]> {
    return this.rows.filter((r) => equnrs.includes(r.equnr) && r.sdate >= since).map((r) => ({ ...r }));
  }

  put(equnr: string, sdate: string, shift: number, fuel: string, updated: string): void {
    this.rows = this.rows.filter((r) => !(r.equnr === equnr && r.sdate === sdate && r.shift === shift));
    this.rows.push({ equnr, sdate, shift, fuel_consumption: fuel, work_hrs_new: '1.00', updated_at: new Date(updated) });
  }
}

/**
 * The existing platform opens a shift's row the moment the shift starts and fills it as the
 * shift runs. Found on Development on 3 Nov 2026: the first pass after a shift started read
 * that row as history, so the next day's forecast for the same shift had a nearly empty
 * shift as its newest input, at half the weight, and came out at about half.
 */
describeDb('shift fuel forecast: a shift still running is not history', () => {
  let owner: DataSource;
  let ds: DataSource;
  let legacy: FakeShiftMetrics;
  let fuel: ShiftFuelService;

  // 08:16 in India: the day shift is sixteen minutes old.
  const JUST_STARTED = new Date('2026-10-20T02:46:00Z');
  // 20:16 in India: the day shift has ended, the night shift is sixteen minutes old.
  const DAY_ENDED = new Date('2026-10-20T14:46:00Z');

  const forecastsOf = (externalId: string) =>
    withTenantId(ds, 'acme', (m) => m.getRepository(ShiftFuelForecast).find({
      where: { externalId }, order: { sdate: 'ASC', shift: 'ASC' },
    })).then((rows) => rows.map((r) => ({ sdate: r.sdate, shift: r.shift, predictedL: r.predictedL, inputsThrough: r.inputsThrough })));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('acme', 'acme') ON CONFLICT DO NOTHING`);
    for (const id of ['EQ-100', 'EQ-200']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, status, name) VALUES ('acme', 'ta-2.0', $1, 'active', $1)`,
        [id],
      );
    }

    legacy = new FakeShiftMetrics();
    legacy.put('EQ-100', '2026-10-18', 1, '100.00', '2026-10-18T15:00:00Z');
    legacy.put('EQ-100', '2026-10-19', 1, '100.00', '2026-10-19T15:00:00Z');
    legacy.put('EQ-100', '2026-10-19', 2, '40.00', '2026-10-20T02:31:00Z');
    // Sixteen minutes into today's day shift.
    legacy.put('EQ-100', '2026-10-20', 1, '2.00', '2026-10-20T02:45:00Z');
    // Ran only nights; tonight's started sixteen minutes ago when the evening pass reads it.
    legacy.put('EQ-200', '2026-10-18', 2, '60.00', '2026-10-19T02:31:00Z');
    legacy.put('EQ-200', '2026-10-19', 2, '60.00', '2026-10-20T02:31:00Z');
    fuel = new ShiftFuelService(ds, legacy);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await owner?.destroy();
  });

  it('forecasts tomorrow\'s day shift from the day shifts that ended, not the one under way', async () => {
    await fuel.run(JUST_STARTED);
    // 100 and 100. With the running shift's 2 L as the newest, it would have been 51.
    expect(await forecastsOf('EQ-100')).toEqual([
      { sdate: '2026-10-20', shift: 2, predictedL: 40, inputsThrough: '2026-10-19' },
      { sdate: '2026-10-21', shift: 1, predictedL: 100, inputsThrough: '2026-10-19' },
    ]);
  });

  it('and the same for a night shift, read the evening it starts', async () => {
    legacy.put('EQ-200', '2026-10-20', 2, '3.00', '2026-10-20T14:45:00Z');
    await fuel.run(DAY_ENDED);
    // Tonight is running, so tomorrow night's forecast is 60 and 60, not 60, 60 and 3.
    // (An ended shift still counts the moment it ends: the evening sync in
    // shift-fuel-forecast.spec.ts reads the day shift that closed half an hour before.)
    expect((await forecastsOf('EQ-200')).filter((f) => f.sdate === '2026-10-21')).toEqual([
      { sdate: '2026-10-21', shift: 1, predictedL: 0, inputsThrough: null },
      { sdate: '2026-10-21', shift: 2, predictedL: 60, inputsThrough: '2026-10-19' },
    ]);
  });
});
