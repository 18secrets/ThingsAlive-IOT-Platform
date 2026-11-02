import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { LegacyShiftMetricRow, LegacyShiftMetricsReader, ShiftMetricsSource } from '../src/legacy/legacy-shift-metrics.reader';
import { withTenantId } from '../src/scope/tenant-session';
import { ShiftFuelApiService } from '../src/shift-fuel/shift-fuel-api.service';
import { LegacyShiftMetric, ShiftFuelForecast } from '../src/shift-fuel/shift-fuel.entities';
import { shiftEnd, shiftStart } from '../src/shift-fuel/shift-fuel-forecast';
import { ShiftFuelService } from '../src/shift-fuel/shift-fuel.service';
import { createAppDataSource, createTestDataSource, describeDb, TEST_DB, undoMigrationNamed } from './db';

const MIGRATION = 'ShiftFuelForecast1763000000000';
/** A stand-in for the existing platform's shift table, in its own schema of the test database. */
const FIXTURE = 'legacy_shift_fixture';

/** The existing platform, as the sync sees it: whatever rows it holds, filtered as the real read filters. */
class FakeShiftMetrics implements ShiftMetricsSource {
  configured = true;
  rows: LegacyShiftMetricRow[] = [];
  calls: { equnrs: string[]; since: string }[] = [];

  async read(equnrs: readonly string[], since: string): Promise<LegacyShiftMetricRow[]> {
    this.calls.push({ equnrs: [...equnrs], since });
    return this.rows.filter((r) => equnrs.includes(r.equnr) && r.sdate >= since).map((r) => ({ ...r }));
  }

  put(equnr: string, sdate: string, shift: number, fuel: string | null, work: string | null = '10.00', updated = '2026-10-20T03:00:00Z'): void {
    this.rows = this.rows.filter((r) => !(r.equnr === equnr && r.sdate === sdate && r.shift === shift));
    this.rows.push({ equnr, sdate, shift, fuel_consumption: fuel, work_hrs_new: work, updated_at: new Date(updated) });
  }
}

/**
 * Fuel per shift from the existing platform's shift totals (D50): the copy, the forecast,
 * and the rules the database holds about both. The far side is a fake that answers the
 * way the real read does, so the sync can be driven shift by shift; the real reader is
 * run once at the end against a stand-in table with the existing platform's column names.
 *
 * One day in India, driven through in order: the morning sync (10:00), a revision in the
 * afternoon, the evening sync (20:30), and the next morning's.
 */
describeDb('shift fuel forecast: legacy shift totals in, a forecast per shift out', () => {
  let owner: DataSource;
  let ds: DataSource;
  let legacy: FakeShiftMetrics;
  let fuel: ShiftFuelService;
  let api: ShiftFuelApiService;

  const MORNING = new Date('2026-10-20T04:30:00Z');
  const AFTERNOON = new Date('2026-10-20T10:00:00Z');
  const EVENING = new Date('2026-10-20T15:00:00Z');
  const NEXT_MORNING = new Date('2026-10-21T04:30:00Z');

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };

  const forecastsOf = (tenantId: string, externalId: string) =>
    withTenantId(ds, tenantId, (m) => m.getRepository(ShiftFuelForecast).find({
      where: { externalId }, order: { sdate: 'ASC', shift: 'ASC' },
    }));
  const pick = (rows: ShiftFuelForecast[]) =>
    rows.map((r) => ({ sdate: r.sdate, shift: r.shift, predictedL: r.predictedL, inputsThrough: r.inputsThrough }));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    for (const t of ['acme', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    const machine = (tenant: string, externalId: string, sourceSystem = 'ta-2.0', status = 'active') => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, status, name) VALUES ($1, $2, $3, $4, $3)`,
      [tenant, sourceSystem, externalId, status],
    );
    await machine('acme', 'EQ-100');
    await machine('acme', 'EQ-200');
    await machine('acme', 'EQ-300', 'ta-2.0', 'retired');
    // Mirrored from 1.0, keyed by 1.0's own id: not an equipment number, never matched.
    await machine('acme', 'EQ-777', 'iot-platform-1');
    await machine('globex', 'EQ-900');
    // Both accounts call a machine this. Neither gets the existing platform's rows for it.
    await machine('acme', 'EQ-555');
    await machine('globex', 'EQ-555');

    legacy = new FakeShiftMetrics();
    legacy.put('EQ-100', '2026-09-01', 1, '500.00'); // before the sync's look-back: never read
    legacy.put('EQ-100', '2026-09-21', 1, '1000.00'); // synced, but 29 days before the 20th
    legacy.put('EQ-100', '2026-09-22', 1, '40.00');
    legacy.put('EQ-100', '2026-10-15', 3, '12.00'); // no such shift
    legacy.put('EQ-100', '2026-10-16', 1, '100.00');
    legacy.put('EQ-100', '2026-10-17', 2, null, '3.50'); // a row with no figure
    legacy.put('EQ-100', '2026-10-18', 1, '120.00');
    legacy.put('EQ-100', '2026-10-18', 2, '60.00');
    legacy.put('EQ-100', '2026-10-19', 1, '80.00');
    legacy.put('EQ-100', '2026-10-19', 2, '30.00');
    legacy.put('EQ-200', '2026-10-18', 1, '-5.00'); // a fault upstream
    legacy.put('EQ-200', '2026-10-19', 1, '50.00'); // day shifts only
    legacy.put('EQ-300', '2026-10-19', 1, '70.00');
    legacy.put('EQ-900', '2026-10-19', 1, '10.00');
    legacy.put('EQ-900', '2026-10-19', 2, '20.00');
    legacy.put('EQ-555', '2026-10-19', 1, '999.00');
    legacy.put('EQ-777', '2026-10-19', 1, '777.00');

    fuel = new ShiftFuelService(ds, legacy);
    api = new ShiftFuelApiService(ds);
  }, 60_000);

  afterAll(async () => {
    await owner?.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await ds?.destroy();
    await owner?.destroy();
  });

  describe('the morning sync', () => {
    it('reads the 35 days before today for every machine it can place, and only those', async () => {
      const s = await fuel.run(MORNING);
      expect(s).toMatchObject({
        machines: 4, ambiguous: ['EQ-555'], synced: true, read: 14, invalid: 2, inserted: 12, revised: 0, forecastsIssued: 6,
      });
      expect(legacy.calls).toEqual([{ equnrs: ['EQ-100', 'EQ-200', 'EQ-300', 'EQ-900'], since: '2026-09-15' }]);
    });

    it('files each row under the account that owns the machine', async () => {
      const acmeRows = await withTenantId(ds, 'acme', (m) => m.getRepository(LegacyShiftMetric).find());
      const globexRows = await withTenantId(ds, 'globex', (m) => m.getRepository(LegacyShiftMetric).find());
      expect(acmeRows.map((r) => r.externalId).sort()).toEqual([
        ...Array(8).fill('EQ-100'), 'EQ-200', 'EQ-300',
      ]);
      expect(globexRows.map((r) => `${r.externalId} ${r.sdate} ${r.shift} ${r.fuelL}`).sort())
        .toEqual(['EQ-900 2026-10-19 1 10', 'EQ-900 2026-10-19 2 20']);
      const blank = acmeRows.find((r) => r.sdate === '2026-10-17');
      expect(blank).toMatchObject({ shift: 2, fuelL: null, workHrs: 3.5 });
    });

    it('forecasts today\'s two shifts from the same shift\'s last 28 days, gaps skipped', async () => {
      // Day shift: 40 (22 Sep), 100, 120, 80 -> 87.5. Night: 60, 30 -> 45; the null on the 17th is skipped.
      expect(pick(await forecastsOf('acme', 'EQ-100'))).toEqual([
        { sdate: '2026-10-20', shift: 1, predictedL: 87.5, inputsThrough: '2026-10-19' },
        { sdate: '2026-10-20', shift: 2, predictedL: 45, inputsThrough: '2026-10-19' },
      ]);
      // No night shifts on record: forecast 0, and it says it used nothing.
      expect(pick(await forecastsOf('acme', 'EQ-200'))).toEqual([
        { sdate: '2026-10-20', shift: 1, predictedL: 50, inputsThrough: '2026-10-19' },
        { sdate: '2026-10-20', shift: 2, predictedL: 0, inputsThrough: null },
      ]);
      // Retired: its rows are kept, and nothing is forecast for it.
      expect(await forecastsOf('acme', 'EQ-300')).toEqual([]);
      expect(await forecastsOf('acme', 'EQ-555')).toEqual([]);
    });

    it('generates the same shift boundaries in the database as the code computes', async () => {
      const [f] = await forecastsOf('acme', 'EQ-100');
      expect(f.startsAt.toISOString()).toBe(shiftStart(f).toISOString());
      expect(f.endsAt.toISOString()).toBe(shiftEnd(f).toISOString());
      const [night] = (await forecastsOf('acme', 'EQ-100')).filter((r) => r.shift === 2);
      expect(night.startsAt.toISOString()).toBe('2026-10-20T14:30:00.000Z');
      expect(night.endsAt.toISOString()).toBe('2026-10-21T02:30:00.000Z');
    });
  });

  describe('late data', () => {
    it('rewrites a row the existing platform revised, and leaves the rest alone', async () => {
      const before = await withTenantId(ds, 'acme', (m) => m.getRepository(LegacyShiftMetric).find({ where: { externalId: 'EQ-100' } }));
      legacy.put('EQ-100', '2026-10-19', 1, '200.00', '10.00', '2026-10-20T09:00:00Z');

      const s = await fuel.run(AFTERNOON);
      expect(s).toMatchObject({ read: 14, inserted: 0, revised: 1, forecastsIssued: 0 });

      const after = await withTenantId(ds, 'acme', (m) => m.getRepository(LegacyShiftMetric).find({ where: { externalId: 'EQ-100' } }));
      const revised = after.find((r) => r.sdate === '2026-10-19' && r.shift === 1)!;
      expect(revised.fuelL).toBe(200);
      expect(revised.syncedAt.toISOString()).toBe(AFTERNOON.toISOString());
      // Unchanged rows were not touched: their synced_at is still the morning's.
      const untouched = after.filter((r) => r !== revised).map((r) => r.syncedAt.toISOString());
      expect(new Set(untouched)).toEqual(new Set([MORNING.toISOString()]));
      expect(after).toHaveLength(before.length);
    });

    it('a forecast for a started shift is never rewritten, even when its inputs are', async () => {
      // The 19th's day shift went from 80 to 200, which would make today's forecast 147.5.
      // Today's day shift started at 08:00, so the forecast made at 10:00 stands.
      const [day] = await forecastsOf('acme', 'EQ-100');
      expect(day).toMatchObject({ sdate: '2026-10-20', shift: 1, predictedL: 87.5 });
      expect(day.issuedAt.toISOString()).toBe(MORNING.toISOString());
    });

    it('and the database refuses to rewrite it, whoever asks', async () => {
      const [day] = await forecastsOf('acme', 'EQ-100');
      // The app role cannot update a forecast at all.
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `UPDATE shift_fuel_forecast SET predicted_l = 147.5 WHERE id = $1`, [day.id],
      ))).rejects.toThrow(/permission denied/);
      // The owner can reach the table, and the trigger refuses it once the shift has started.
      await expect(owner.query(`UPDATE shift_fuel_forecast SET predicted_l = 147.5 WHERE id = $1`, [day.id]))
        .rejects.toThrow(/has started, so its forecast is final/);
    });

    it('a forecast for a shift that has not started can still be corrected by the owner', async () => {
      // So the trigger is about starting, not about forecasts in general.
      const [row] = await owner.query(
        `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method)
         VALUES ('acme', 'ta-2.0', 'EQ-100', '2099-01-01', 1, 10, 'manual-check') RETURNING id`,
      );
      await owner.query(`UPDATE shift_fuel_forecast SET predicted_l = 11 WHERE id = $1`, [row.id]);
      await owner.query(`DELETE FROM shift_fuel_forecast WHERE id = $1`, [row.id]);
    });
  });

  describe('what the database refuses outright', () => {
    const forecast = (over: Record<string, unknown>) => {
      const row = {
        tenant_id: 'acme', source_system: 'ta-2.0', external_id: 'EQ-100', sdate: '2026-10-25', shift: 1,
        predicted_l: 10, method: 'refusal-check', inputs_through: null, issued_at: '2026-10-24T00:00:00Z', ...over,
      } as Record<string, unknown>;
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO shift_fuel_forecast (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      );
    };
    const metric = (over: Record<string, unknown>) => {
      const row = {
        tenant_id: 'acme', source_system: 'ta-2.0', external_id: 'EQ-100', sdate: '2026-10-01', shift: 1,
        fuel_l: 10, work_hrs: 5, ...over,
      } as Record<string, unknown>;
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO legacy_shift_metric (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      );
    };

    it('a forecast that saw its own day', async () => {
      await expect(forecast({ inputs_through: '2026-10-25' })).rejects.toThrow(/ck_shift_fuel_forecast_inputs/);
    });

    it('a forecast issued after its shift ended', async () => {
      // The 25th's day shift ends 14:30 UTC.
      await expect(forecast({ issued_at: '2026-10-25T14:30:00Z' })).rejects.toThrow(/ck_shift_fuel_forecast_in_time/);
    });

    it('a negative forecast, or a third shift', async () => {
      await expect(forecast({ predicted_l: -1 })).rejects.toThrow(/ck_shift_fuel_forecast_predicted/);
      await expect(forecast({ shift: 3 })).rejects.toThrow(/ck_shift_fuel_forecast_shift/);
    });

    it('a second answer to the same shift by the same method', async () => {
      await expect(forecast({ sdate: '2026-10-20', shift: 1, method: 'ewma-0.5-28d', issued_at: '2026-10-20T03:00:00Z' }))
        .rejects.toThrow(/uq_shift_fuel_forecast_target/);
    });

    it('a negative litre or hour count, a third shift, or a second row for one shift', async () => {
      await expect(metric({ fuel_l: -0.01 })).rejects.toThrow(/ck_legacy_shift_metric_fuel/);
      await expect(metric({ work_hrs: -1 })).rejects.toThrow(/ck_legacy_shift_metric_work_hrs/);
      await expect(metric({ shift: 0 })).rejects.toThrow(/ck_legacy_shift_metric_shift/);
      await expect(metric({ sdate: '2026-10-19' })).rejects.toThrow(/uq_legacy_shift_metric_shift/);
    });

    it('a row for a machine 2.0 does not have', async () => {
      await expect(metric({ external_id: 'NOPE' })).rejects.toThrow(/fk_legacy_shift_metric_equipment/);
    });
  });

  describe('one account cannot see another\'s', () => {
    it('reads nothing of acme\'s from globex, by filter or without one', async () => {
      const rows = await withTenantId(ds, 'globex', (m) => m.getRepository(LegacyShiftMetric).find({ where: { tenantId: 'acme' } }));
      expect(rows).toEqual([]);
      const forecasts = await withTenantId(ds, 'globex', (m) => m.query(`SELECT * FROM shift_fuel_forecast WHERE tenant_id = 'acme'`));
      expect(forecasts).toEqual([]);
    });

    it('reads nothing at all with no account in the session', async () => {
      expect(await ds.query(`SELECT count(*)::int AS n FROM legacy_shift_metric`)).toEqual([{ n: 0 }]);
      expect(await ds.query(`SELECT count(*)::int AS n FROM shift_fuel_forecast`)).toEqual([{ n: 0 }]);
    });

    it('cannot write a row into acme from globex\'s session', async () => {
      await expect(withTenantId(ds, 'globex', (m) => m.query(
        `INSERT INTO legacy_shift_metric (tenant_id, source_system, external_id, sdate, shift, fuel_l)
         VALUES ('acme', 'ta-2.0', 'EQ-100', '2026-10-02', 1, 1)`,
      ))).rejects.toThrow(/row-level security/);
    });

    it('answers globex\'s request for acme\'s machine with the same 404 as a machine that does not exist', async () => {
      await expect(api.machine(globex, { sourceSystem: 'ta-2.0', externalId: 'EQ-100' }, 14, AFTERNOON))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('the evening sync', () => {
    it('forecasts tonight and tomorrow\'s day shift, and keeps tonight\'s forecast from the morning', async () => {
      legacy.put('EQ-100', '2026-10-20', 1, '90.00', '11.00', '2026-10-20T14:45:00Z');
      const s = await fuel.run(EVENING);
      expect(s).toMatchObject({ inserted: 1, revised: 0, forecastsIssued: 3 });

      // Tomorrow's day shift, from 28 days before the 21st: 100, 120, 200 (revised), 90 -> 122.5.
      // 22 Sep has left the window.
      expect(pick(await forecastsOf('acme', 'EQ-100'))).toEqual([
        { sdate: '2026-10-20', shift: 1, predictedL: 87.5, inputsThrough: '2026-10-19' },
        { sdate: '2026-10-20', shift: 2, predictedL: 45, inputsThrough: '2026-10-19' },
        { sdate: '2026-10-21', shift: 1, predictedL: 122.5, inputsThrough: '2026-10-20' },
      ]);
    });
  });

  describe('over HTTP', () => {
    it('one machine: each recent shift with its forecast and, where synced, what happened', async () => {
      const r = await api.machine(acme, { sourceSystem: 'ta-2.0', externalId: 'EQ-100' }, 7, EVENING);
      expect(r.method).toBe('ewma-0.5-28d');
      expect(r.shifts.map((s) => [s.sdate, s.shift, s.predictedL, s.fuelL, s.workHrs])).toEqual([
        ['2026-10-16', 1, null, 100, 10],
        ['2026-10-17', 2, null, null, 3.5],
        ['2026-10-18', 1, null, 120, 10],
        ['2026-10-18', 2, null, 60, 10],
        ['2026-10-19', 1, null, 200, 10],
        ['2026-10-19', 2, null, 30, 10],
        ['2026-10-20', 1, 87.5, 90, 11],
        ['2026-10-20', 2, 45, null, null],
        ['2026-10-21', 1, 122.5, null, null],
      ]);
      expect(r.shifts[6]).toMatchObject({
        startsAt: '2026-10-20T02:30:00.000Z', endsAt: '2026-10-20T14:30:00.000Z',
        inputsThrough: '2026-10-19', issuedAt: MORNING.toISOString(),
      });
    });

    it('a machine outside the caller\'s scope is a 404', async () => {
      const siteUser: RequestScope = { ...acme, equipmentIds: ['EQ-200'] };
      await expect(api.machine(siteUser, { sourceSystem: 'ta-2.0', externalId: 'EQ-100' }, 7, EVENING))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('the fleet: each machine\'s newest two forecasts and the total per shift', async () => {
      const r = await api.fleet(acme, EVENING);
      expect(r.forecasts.map((f) => [f.externalId, f.sdate, f.shift, f.predictedL])).toEqual([
        ['EQ-100', '2026-10-20', 2, 45],
        ['EQ-200', '2026-10-20', 2, 0],
        ['EQ-100', '2026-10-21', 1, 122.5],
        ['EQ-200', '2026-10-21', 1, 50],
      ]);
      expect(r.totals).toEqual([
        { sdate: '2026-10-20', shift: 2, predictedL: 45, machines: 2 },
        { sdate: '2026-10-21', shift: 1, predictedL: 172.5, machines: 2 },
      ]);
      expect((await api.fleet(globex, EVENING)).forecasts.map((f) => f.externalId)).toEqual(['EQ-900', 'EQ-900']);
      expect((await api.fleet({ ...acme, equipmentIds: ['EQ-200'] }, EVENING)).forecasts.map((f) => f.externalId))
        .toEqual(['EQ-200', 'EQ-200']);
      expect((await api.fleet({ ...acme, equipmentIds: [] }, EVENING)).forecasts).toEqual([]);
    });
  });

  describe('two passes at once', () => {
    it('both settle, and each shift is forecast once', async () => {
      const results = await Promise.allSettled([fuel.run(NEXT_MORNING), fuel.run(NEXT_MORNING)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // One pass did the work; the other found the lock held (null) or nothing left to do.
      const issued = results.map((r) => (r as PromiseFulfilledResult<{ forecastsIssued: number } | null>).value?.forecastsIssued ?? 0);
      expect(issued.reduce((a, b) => a + b, 0)).toBe(3);

      const [{ n, distinct }] = await owner.query(
        `SELECT count(*)::int AS n,
                count(DISTINCT (tenant_id, external_id, sdate, shift, method))::int AS distinct
           FROM shift_fuel_forecast WHERE sdate = '2026-10-21' AND shift = 2`,
      );
      expect({ n, distinct }).toEqual({ n: 3, distinct: 3 });
    });
  });

  describe('the real read, against the existing platform\'s column names', () => {
    beforeAll(async () => {
      await owner.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
      // The columns the sync reads, with the existing platform's names and types, and one
      // it does not, so a column ignored is told apart from a column missing.
      await owner.query(`
        CREATE SCHEMA ${FIXTURE};
        CREATE TABLE ${FIXTURE}.equipment_shift_metrics (
          id serial PRIMARY KEY, equnr varchar(64) NOT NULL, sdate date NOT NULL, shift smallint NOT NULL,
          fuel_consumption numeric(12,2), work_hrs_new numeric(10,2), idle_hrs numeric(10,2),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (equnr, sdate, shift));
        INSERT INTO ${FIXTURE}.equipment_shift_metrics (equnr, sdate, shift, fuel_consumption, work_hrs_new, updated_at)
          VALUES ('EQ-100', '2026-10-19', 2, 30.5, 9.25, '2026-10-20T03:00:00Z'),
                 ('EQ-100', '2026-10-01', 1, 10, 1, '2026-10-02T03:00:00Z'),
                 ('EQ-900', '2026-10-19', 1, NULL, 0, '2026-10-20T03:00:00Z'),
                 ('EQ-404', '2026-10-19', 1, 5, 1, '2026-10-20T03:00:00Z');`);
    });

    const config = (schema = FIXTURE) => ({
      host: TEST_DB.DB_HOST, port: Number(TEST_DB.DB_PORT), username: TEST_DB.DB_USERNAME,
      password: TEST_DB.DB_PASSWORD, database: TEST_DB.DB_DATABASE, schema, ssl: false,
    });

    it('reads the asked-for machines since the given day, dates and figures as text', async () => {
      const reader = new LegacyShiftMetricsReader(config());
      try {
        expect(reader.configured).toBe(true);
        const rows = await reader.read(['EQ-100', 'EQ-900'], '2026-10-15');
        expect(rows).toEqual([
          { equnr: 'EQ-100', sdate: '2026-10-19', shift: 2, fuel_consumption: '30.50', work_hrs_new: '9.25', updated_at: new Date('2026-10-20T03:00:00Z') },
          { equnr: 'EQ-900', sdate: '2026-10-19', shift: 1, fuel_consumption: null, work_hrs_new: '0.00', updated_at: new Date('2026-10-20T03:00:00Z') },
        ]);
      } finally {
        await reader.onModuleDestroy();
      }
    });

    it('is not configured without LEGACY_SHIFT_DB_*, and refuses a schema name it would have to trust', () => {
      expect(new LegacyShiftMetricsReader(null).configured).toBe(false);
      expect(() => new LegacyShiftMetricsReader(config('public; select 1'))).toThrow(/not a plain identifier/);
    });
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const left = await owner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
          AND table_name IN ('legacy_shift_metric', 'shift_fuel_forecast')
       UNION ALL SELECT proname::text FROM pg_proc WHERE proname = 'shift_fuel_forecast_frozen'`,
    );
    expect(left).toEqual([]);
    await owner.runMigrations({ transaction: 'all' });
  }, 60_000);
});
