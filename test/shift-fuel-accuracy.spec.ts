import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ShiftFuelAccuracyApiService } from '../src/shift-fuel/shift-fuel-accuracy-api.service';
import { ShiftFuelApiService } from '../src/shift-fuel/shift-fuel-api.service';
import { ShiftFuelNowcastApiService } from '../src/shift-fuel/shift-fuel-nowcast-api.service';
import { ShiftFuelController } from '../src/shift-fuel/shift-fuel.controller';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Forecast accuracy over HTTP (D53): the numbers the page shows, read from 2.0's own
 * tables as the app role reads them, under row-level security and the caller's scope.
 *
 * The arithmetic has its own spec; this one holds the reads to it — that a forecast is
 * matched to its own shift and method, that a checkpoint is the newest snapshot at or
 * before it and nothing later, that a row with no figure and a shift still running are
 * not outcomes, and that nobody reads another account's machines or outside their scope.
 *
 * Scored at 12:00 UTC on 22 October, when the 22nd's day shift (02:30-14:30 UTC) is running.
 */
describeDb('shift fuel accuracy: what the page reads', () => {
  let owner: DataSource;
  let ds: DataSource;
  let api: ShiftFuelAccuracyApiService;

  const AT = new Date('2026-10-22T12:00:00Z');
  const scope = (tenantId: string, extra: Partial<RequestScope> = {}): RequestScope =>
    ({ tenantId, userId: `u-${tenantId}`, roles: ['super admin'], isPlatformRole: false, ...extra });
  const acme = scope('acme');
  const OCT = { from: '2026-10-20', to: '2026-10-21' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    api = new ShiftFuelAccuracyApiService(ds);

    for (const t of ['acme', 'globex', 'initech']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    const machine = (tenant: string, externalId: string, name: string) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, status, name) VALUES ($1, 'ta-2.0', $2, 'active', $3)`,
      [tenant, externalId, name],
    );
    await machine('acme', 'EQ-1', 'Excavator 1');
    await machine('acme', 'EQ-2', 'Dozer 2');
    await machine('acme', 'EQ-3', 'Loader 3');
    await machine('acme', 'EQ-4', 'Grader 4');
    await machine('globex', 'EQ-9', 'Globex 9');
    // The same number in another account: a different machine, never mixed with acme's.
    await machine('globex', 'EQ-1', 'Globex 1');

    const actual = (tenant: string, externalId: string, sdate: string, shift: 1 | 2, fuel: number | null) => owner.query(
      `INSERT INTO legacy_shift_metric (tenant_id, source_system, external_id, sdate, shift, fuel_l) VALUES ($1, 'ta-2.0', $2, $3, $4, $5)`,
      [tenant, externalId, sdate, shift, fuel],
    );
    const forecast = (tenant: string, externalId: string, sdate: string, shift: 1 | 2, litres: number, method = 'ewma-0.5-28d') =>
      owner.query(
        `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, issued_at)
         VALUES ($1, 'ta-2.0', $2, $3, $4, $5, $6, $7)`,
        [tenant, externalId, sdate, shift, litres, method, `${sdate}T00:00:00Z`],
      );
    // A snapshot of `predicted` litres, `hours` into the shift. so_far 0 and a base of the
    // whole figure is a snapshot the table's rules accept; only predicted_l is scored.
    const snapshot = (externalId: string, sdate: string, shift: 1 | 2, hours: number, predicted: number) => {
      const start = new Date(`${sdate}T${shift === 1 ? '08:00' : '20:00'}:00+05:30`);
      const asOf = new Date(start.getTime() + hours * 3_600_000).toISOString();
      return owner.query(
        `INSERT INTO shift_fuel_nowcast (tenant_id, source_system, external_id, sdate, shift, as_of, counter_at,
                                         so_far_l, base_l, base_source, predicted_l, method)
         VALUES ('acme', 'ta-2.0', $1, $2, $3, $4, $4, 0, $5, 'issued', $5, 'so-far+ewma-0.5-28d-share')`,
        [externalId, sdate, shift, asOf, predicted],
      );
    };

    // EQ-1, as in the arithmetic spec's EQ-A.
    await actual('acme', 'EQ-1', '2026-10-20', 1, 100);
    await forecast('acme', 'EQ-1', '2026-10-20', 1, 120);
    await snapshot('EQ-1', '2026-10-20', 1, 1, 130);
    await snapshot('EQ-1', '2026-10-20', 1, 2, 110); // exactly two hours in: the 2h checkpoint
    await snapshot('EQ-1', '2026-10-20', 1, 3.5, 105); // the newest by four hours
    await snapshot('EQ-1', '2026-10-20', 1, 6, 102);
    await snapshot('EQ-1', '2026-10-20', 1, 8, 101); // past every checkpoint
    await actual('acme', 'EQ-1', '2026-10-20', 2, 50);
    await forecast('acme', 'EQ-1', '2026-10-20', 2, 40);
    await snapshot('EQ-1', '2026-10-20', 2, 2, 45); // the feed then stopped: 45 stands at 4h and 6h too
    await actual('acme', 'EQ-1', '2026-10-21', 1, 120);
    await forecast('acme', 'EQ-1', '2026-10-21', 1, 100);
    await snapshot('EQ-1', '2026-10-21', 1, 3, 115); // nothing by two hours
    await actual('acme', 'EQ-1', '2026-10-21', 2, 70);
    // Another method's figure for a shift D50 never forecast is not D50's forecast.
    await forecast('acme', 'EQ-1', '2026-10-21', 2, 70, 'another-method');
    // The 22nd's day shift is running at AT: whatever is on file for it is not an outcome yet.
    await actual('acme', 'EQ-1', '2026-10-22', 1, 999);
    await forecast('acme', 'EQ-1', '2026-10-22', 1, 1);
    await snapshot('EQ-1', '2026-10-22', 1, 2, 1);

    // EQ-2: an idle shift with a forecast, and a row the existing platform has no figure for.
    await actual('acme', 'EQ-2', '2026-10-20', 1, 0);
    await forecast('acme', 'EQ-2', '2026-10-20', 1, 10);
    await actual('acme', 'EQ-2', '2026-10-20', 2, 30);
    await forecast('acme', 'EQ-2', '2026-10-20', 2, 30);
    await actual('acme', 'EQ-2', '2026-10-21', 1, null);
    await forecast('acme', 'EQ-2', '2026-10-21', 1, 30);

    // EQ-3 never ran. EQ-4 has forecasts and nothing the existing platform totalled.
    await actual('acme', 'EQ-3', '2026-10-20', 1, 0);
    await forecast('acme', 'EQ-3', '2026-10-20', 1, 25);
    await forecast('acme', 'EQ-4', '2026-10-20', 1, 50);

    await actual('globex', 'EQ-9', '2026-10-20', 1, 500);
    await forecast('globex', 'EQ-9', '2026-10-20', 1, 0);
    await actual('globex', 'EQ-1', '2026-10-20', 1, 7);
    await forecast('globex', 'EQ-1', '2026-10-20', 1, 7);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await owner?.destroy();
  });

  it('per day: each machine and the fleet, as the arithmetic spec works them', async () => {
    const r = await api.accuracy(acme, { ...OCT, level: 'day' }, AT);
    expect(r).toEqual({
      from: '2026-10-20', to: '2026-10-21', level: 'day', asOf: AT.toISOString(),
      fleet: {
        machines: 2, actualL: 370, forecastL: 300, accuracy: 87,
        // Only EQ-1 has snapshots. 2h: day 20 110 + 45 vs 150 -> 5 / 150 -> 97.
        // 4h: day 20 105 + 45 vs 150 -> 0; day 21 115 vs 120 -> 5; 5 / 270 -> 98.
        // 6h: day 20 102 + 45 vs 150 -> 3; day 21 -> 5; 8 / 270 -> 97.
        checkpoints: { 2: 97, 4: 98, 6: 97 },
        shiftsWithoutForecast: 1,
        shiftsWithoutCheckpoint: { 2: 4, 4: 3, 6: 3 },
      },
      machines: [
        {
          sourceSystem: 'ta-2.0', externalId: 'EQ-1', name: 'Excavator 1', actualL: 340, forecastL: 260, accuracy: 89,
          checkpoints: { 2: 97, 4: 98, 6: 97 }, shifts: 4, ranShifts: 4,
          shiftsWithoutForecast: 1, shiftsWithoutCheckpoint: { 2: 2, 4: 1, 6: 1 },
        },
        {
          // The row with no figure is not a shift here: two shifts, not three.
          sourceSystem: 'ta-2.0', externalId: 'EQ-2', name: 'Dozer 2', actualL: 30, forecastL: 40, accuracy: 67,
          checkpoints: { 2: null, 4: null, 6: null }, shifts: 2, ranShifts: 1,
          shiftsWithoutForecast: 0, shiftsWithoutCheckpoint: { 2: 2, 4: 2, 6: 2 },
        },
        {
          sourceSystem: 'ta-2.0', externalId: 'EQ-3', name: 'Loader 3', actualL: 0, forecastL: 25, accuracy: null,
          checkpoints: { 2: null, 4: null, 6: null }, shifts: 1, ranShifts: 0,
          shiftsWithoutForecast: 0, shiftsWithoutCheckpoint: { 2: 1, 4: 1, 6: 1 },
        },
      ],
      latestDataDate: '2026-10-21',
    });
  });

  it('per shift and over the range, from the same rows', async () => {
    const shift = await api.accuracy(acme, { ...OCT, level: 'shift' }, AT);
    expect(shift.fleet.accuracy).toBe(80);
    // 2h: 10 + 5 over 150 -> 90. 4h: 5 + 5 + 5 over 270 -> 94. 6h: 2 + 5 + 5 over 270 -> 96.
    expect(shift.fleet.checkpoints).toEqual({ 2: 90, 4: 94, 6: 96 });
    expect(shift.machines.map((m) => [m.externalId, m.accuracy])).toEqual([['EQ-1', 81], ['EQ-2', 67], ['EQ-3', null]]);
    const range = await api.accuracy(acme, { ...OCT, level: 'range' }, AT);
    expect(range.fleet.accuracy).toBe(100);
    expect(range.machines.find((m) => m.externalId === 'EQ-1')?.accuracy).toBe(96);
  });

  it('a shift still running is not counted, even inside the range', async () => {
    const r = await api.accuracy(acme, { from: '2026-10-20', to: '2026-10-22', level: 'day' }, AT);
    expect(r.fleet).toMatchObject({ actualL: 370, forecastL: 300, accuracy: 87 });
    // Once it has ended, it is.
    const later = await api.accuracy(acme, { from: '2026-10-20', to: '2026-10-22', level: 'day' }, new Date('2026-10-22T14:30:00Z'));
    expect(later.fleet).toMatchObject({ actualL: 1369, forecastL: 301 });
  });

  it('today with nothing totalled yet: no machines, and the newest day that has one', async () => {
    const r = await api.accuracy(acme, { from: '2026-10-22', to: '2026-10-22', level: 'day' }, AT);
    expect(r.machines).toEqual([]);
    expect(r.fleet).toMatchObject({ machines: 0, actualL: 0, accuracy: null });
    expect(r.latestDataDate).toBe('2026-10-21');
    // Before the 21st's night shift ended (02:30 UTC on the 22nd), the newest day with a
    // completed shift was still the 21st — its day shift — and before that ended, the 20th.
    expect((await api.accuracy(acme, { ...OCT, level: 'day' }, new Date('2026-10-22T02:00:00Z'))).latestDataDate).toBe('2026-10-21');
    expect((await api.accuracy(acme, { ...OCT, level: 'day' }, new Date('2026-10-21T14:00:00Z'))).latestDataDate).toBe('2026-10-20');
  });

  describe('who sees what', () => {
    it('another account sees its own machines and none of acme\'s, its EQ-1 included', async () => {
      const r = await api.accuracy(scope('globex'), { ...OCT, level: 'day' }, AT);
      expect(r.machines.map((m) => [m.externalId, m.name, m.actualL])).toEqual([['EQ-1', 'Globex 1', 7], ['EQ-9', 'Globex 9', 500]]);
      expect(r.fleet).toMatchObject({ machines: 2, actualL: 507, forecastL: 7, checkpoints: { 2: null, 4: null, 6: null } });
      expect(r.latestDataDate).toBe('2026-10-20');
    });

    it('an account with nothing on file sees nothing, and no date to fall back to', async () => {
      const r = await api.accuracy(scope('initech'), { ...OCT, level: 'day' }, AT);
      expect(r.machines).toEqual([]);
      expect(r.fleet).toMatchObject({ machines: 0, actualL: 0, forecastL: 0, accuracy: null });
      expect(r.latestDataDate).toBeNull();
    });

    it('a caller scoped to some machines is scored over those alone', async () => {
      const r = await api.accuracy(scope('acme', { equipmentIds: ['EQ-2'] }), { ...OCT, level: 'day' }, AT);
      expect(r.machines.map((m) => m.externalId)).toEqual(['EQ-2']);
      expect(r.fleet).toMatchObject({ machines: 1, actualL: 30, forecastL: 40, accuracy: 67 });
      expect(r.latestDataDate).toBe('2026-10-20');
    });

    it('a caller scoped to no machines sees none', async () => {
      const r = await api.accuracy(scope('acme', { equipmentIds: [] }), { ...OCT, level: 'day' }, AT);
      expect(r.machines).toEqual([]);
      expect(r.latestDataDate).toBeNull();
    });

    it('the app role, outside any account\'s session, reads none of the rows the page is made of', async () => {
      for (const table of ['legacy_shift_metric', 'shift_fuel_forecast', 'shift_fuel_nowcast']) {
        expect(await ds.query(`SELECT count(*)::int AS n FROM "${table}"`)).toEqual([{ n: 0 }]);
      }
    });
  });

  describe('the route', () => {
    const controller = () => new ShiftFuelController(new ShiftFuelApiService(ds), new ShiftFuelNowcastApiService(ds), api);

    it('refuses a range over 92 days, a reversed range, a malformed date and an unknown level', async () => {
      const c = controller();
      await expect(c.accuracy(acme, '2026-08-01', '2026-11-01')).rejects.toThrow(BadRequestException);
      await expect(c.accuracy(acme, '2026-08-01', '2026-11-01')).rejects.toThrow(/93 days/);
      await expect(c.accuracy(acme, '2026-10-21', '2026-10-20')).rejects.toThrow(BadRequestException);
      await expect(c.accuracy(acme, '2026-10-32', '2026-10-21')).rejects.toThrow(/from must be a date/);
      await expect(c.accuracy(acme, '2026-10-20', '2026-10-21', 'week')).rejects.toThrow(/level must be one of/);
    });

    it('answers with the query it ran, per day unless told otherwise', async () => {
      const r = await controller().accuracy(acme, '2026-10-20', '2026-10-21');
      expect({ from: r.from, to: r.to, level: r.level }).toEqual({ from: '2026-10-20', to: '2026-10-21', level: 'day' });
    });
  });
});
