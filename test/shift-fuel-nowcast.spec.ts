import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  FuelCounterProbe, FuelCounterReading, FuelCounterSource, FuelCounterWindow, LegacyShiftMetricRow,
  LegacyShiftMetricsReader, ShiftMetricsSource,
} from '../src/legacy/legacy-shift-metrics.reader';
import { withTenantId } from '../src/scope/tenant-session';
import { ShiftFuelApiService } from '../src/shift-fuel/shift-fuel-api.service';
import { ShiftFuelNowcast } from '../src/shift-fuel/shift-fuel.entities';
import { ShiftFuelNowcastApiService } from '../src/shift-fuel/shift-fuel-nowcast-api.service';
import { ShiftFuelNowcastService } from '../src/shift-fuel/shift-fuel-nowcast.service';
import { ShiftFuelService } from '../src/shift-fuel/shift-fuel.service';
import { createAppDataSource, createTestDataSource, describeDb, TEST_DB, undoMigrationNamed } from './db';

const MIGRATION = 'ShiftFuelNowcast1763100000000';
/** A stand-in for the existing platform's raw logs and their mapping tables, in its own schema. */
const FIXTURE = 'legacy_counter_fixture';

interface Reading {
  equnr: string;
  seriesId: number;
  unit: string;
  at: Date;
  value: number;
  /** When it reached the existing platform; the same instant unless a test says otherwise. */
  createdAt?: Date;
}

/**
 * The existing platform's fuel counters, as the nowcast sees them: whatever readings it
 * holds, probed by the same rules the real read applies — the newest reading since the
 * start, the last in the five minutes before it or else the first after, and nothing
 * that arrived after the tick.
 */
class FakeCounters implements FuelCounterSource {
  configured = true;
  readings: Reading[] = [];
  calls: { equnrs: string[]; window: FuelCounterWindow }[] = [];

  async readFuelCounters(equnrs: readonly string[], window: FuelCounterWindow): Promise<FuelCounterProbe[]> {
    this.calls.push({ equnrs: [...equnrs], window });
    const arrived = this.readings.filter((r) => (r.createdAt ?? r.at) <= window.asOf);
    const series = new Map<number, Reading[]>();
    for (const r of this.readings.filter((x) => equnrs.includes(x.equnr))) {
      series.set(r.seriesId, [...(series.get(r.seriesId) ?? []), ...arrived.filter((a) => a === r)]);
    }
    const pick = (rs: Reading[], from: Date, to: Date, newest: boolean): FuelCounterReading | null => {
      const inside = rs.filter((r) => r.at >= from && r.at <= to).sort((a, b) => a.at.getTime() - b.at.getTime());
      const r = newest ? inside[inside.length - 1] : inside[0];
      return r ? { at: r.at, value: r.value } : null;
    };
    return [...series.entries()].sort(([a], [b]) => a - b).map(([seriesId, rs]): FuelCounterProbe => {
      const one = this.readings.find((r) => r.seriesId === seriesId) as Reading;
      const latest = pick(rs, window.shiftStart, window.asOf, true);
      const opening = latest
        ? pick(rs, window.openingSince, window.shiftStart, true) ?? pick(rs, window.shiftStart, window.asOf, false)
        : null;
      return { equnr: one.equnr, seriesId, unit: one.unit, opening, latest };
    });
  }

  put(equnr: string, seriesId: number, utc: string, value: number, extra: { unit?: string; createdUtc?: string } = {}): void {
    this.readings.push({
      equnr, seriesId, unit: extra.unit ?? 'liter', at: new Date(`2026-10-20T${utc}Z`), value,
      createdAt: extra.createdUtc ? new Date(`2026-10-20T${extra.createdUtc}Z`) : undefined,
    });
  }
}

/** The D50 sync is not exercised here; placement is all the nowcast takes from it. */
class NoShiftMetrics implements ShiftMetricsSource {
  configured = false;
  async read(): Promise<LegacyShiftMetricRow[]> { return []; }
}

/**
 * The in-shift nowcast (D52): one snapshot per machine per tick while a shift runs, from
 * the fuel counter and the shift's forecast, and the rules the database holds about them.
 *
 * The day shift of 20 October in India, 02:30-14:30 UTC. The first tick is 04:37 UTC, which
 * rounds to 04:30 — two hours in, ten to go.
 */
describeDb('shift fuel nowcast: litres so far plus the forecast\'s share of the rest', () => {
  let owner: DataSource;
  let ds: DataSource;
  let counters: FakeCounters;
  let nowcast: ShiftFuelNowcastService;
  let nowcastApi: ShiftFuelNowcastApiService;
  let api: ShiftFuelApiService;

  const TICK = new Date('2026-10-20T04:37:00Z');
  const AS_OF = '2026-10-20T04:30:00.000Z';
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };

  const snapshotsOf = (tenantId: string, externalId?: string) =>
    withTenantId(ds, tenantId, (m) => m.getRepository(ShiftFuelNowcast).find({
      where: externalId ? { externalId } : {}, order: { externalId: 'ASC', asOf: 'ASC' },
    }));
  const pick = (r: ShiftFuelNowcast) => ({
    externalId: r.externalId, sdate: r.sdate, shift: r.shift, asOf: r.asOf.toISOString(), counterAt: r.counterAt.toISOString(),
    soFarL: r.soFarL, baseL: r.baseL, baseSource: r.baseSource, predictedL: r.predictedL, method: r.method,
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    for (const t of ['acme', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    const machine = (tenant: string, externalId: string, status = 'active') => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, status, name) VALUES ($1, 'ta-2.0', $2, $3, $2)`,
      [tenant, externalId, status],
    );
    for (const id of ['EQ-100', 'EQ-200', 'EQ-400', 'EQ-500', 'EQ-600', 'EQ-700', 'EQ-800', 'EQ-555']) await machine('acme', id);
    await machine('acme', 'EQ-300', 'retired');
    await machine('globex', 'EQ-900');
    await machine('globex', 'EQ-555');

    // D50's forecasts for today's day shift, issued at the morning sync. EQ-200 has none
    // yet, so its base is computed from its synced history: 40 then 80 -> 60.
    const forecast = (tenant: string, externalId: string, litres: number) => owner.query(
      `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, inputs_through, issued_at)
       VALUES ($1, 'ta-2.0', $2, '2026-10-20', 1, $3, 'ewma-0.5-28d', '2026-10-19', '2026-10-20T04:00:00Z')`,
      [tenant, externalId, litres],
    );
    await forecast('acme', 'EQ-100', 120);
    await forecast('acme', 'EQ-600', 60);
    await forecast('globex', 'EQ-900', 48);
    // Another method's forecast for the same shift is not the base.
    await owner.query(
      `INSERT INTO shift_fuel_forecast (tenant_id, source_system, external_id, sdate, shift, predicted_l, method, issued_at)
       VALUES ('acme', 'ta-2.0', 'EQ-200', '2026-10-20', 1, 999, 'another-method', '2026-10-20T04:00:00Z')`,
    );
    await owner.query(
      `INSERT INTO legacy_shift_metric (tenant_id, source_system, external_id, sdate, shift, fuel_l)
       VALUES ('acme', 'ta-2.0', 'EQ-200', '2026-10-18', 1, 40), ('acme', 'ta-2.0', 'EQ-200', '2026-10-19', 1, 80),
              ('acme', 'ta-2.0', 'EQ-200', '2026-10-19', 2, 500), ('acme', 'ta-2.0', 'EQ-200', '2026-10-20', 1, 7000)`,
    );

    counters = new FakeCounters();
    // EQ-100: 5000 at 02:28, two minutes before the start; 5025 at 04:29. 25 litres so far.
    counters.put('EQ-100', 11, '02:20:00', 4990);
    counters.put('EQ-100', 11, '02:28:00', 5000);
    counters.put('EQ-100', 11, '02:31:00', 5000.5);
    counters.put('EQ-100', 11, '04:29:00', 5025);
    counters.put('EQ-100', 11, '04:29:30', 5026, { createdUtc: '04:35:00' }); // reached the platform after the tick
    counters.put('EQ-100', 11, '04:40:00', 5030); // after the tick
    // EQ-200: device replaced at 03:10. The new series opens at its first reading, 10; 40 now.
    counters.put('EQ-200', 21, '02:29:00', 800);
    counters.put('EQ-200', 21, '03:00:00', 900);
    counters.put('EQ-200', 22, '03:10:00', 10);
    counters.put('EQ-200', 22, '04:25:00', 40);
    // EQ-300 is retired; EQ-555 is held by two accounts. Neither is nowcast.
    counters.put('EQ-300', 31, '02:29:00', 1);
    counters.put('EQ-300', 31, '04:29:00', 50);
    counters.put('EQ-555', 55, '02:29:00', 1);
    counters.put('EQ-555', 55, '04:29:00', 50);
    // EQ-400 has no fuel counter at all. EQ-500's last reading was before the shift.
    counters.put('EQ-500', 51, '02:00:00', 300);
    // EQ-600: the counter fell from 7000 to 12 — reset, or a new device on the same series.
    counters.put('EQ-600', 61, '02:29:00', 7000);
    counters.put('EQ-600', 61, '04:00:00', 12);
    // EQ-700: the feed stopped at 03:00, ninety minutes before the tick.
    counters.put('EQ-700', 71, '02:29:00', 100);
    counters.put('EQ-700', 71, '03:00:00', 110);
    // EQ-800: a fuel counter in millilitres.
    counters.put('EQ-800', 81, '02:29:00', 1000, { unit: 'ml' });
    counters.put('EQ-800', 81, '04:29:00', 9000, { unit: 'ml' });
    counters.put('EQ-900', 91, '02:29:00', 0);
    counters.put('EQ-900', 91, '04:15:00', 12);

    const fuel = new ShiftFuelService(ds, new NoShiftMetrics());
    nowcast = new ShiftFuelNowcastService(ds, counters, fuel);
    nowcastApi = new ShiftFuelNowcastApiService(ds);
    api = new ShiftFuelApiService(ds);
  }, 60_000);

  afterAll(async () => {
    await owner?.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await ds?.destroy();
    await owner?.destroy();
  });

  describe('the first tick', () => {
    it('asks for every active machine it can place, for the shift so far, as of the quarter hour', async () => {
      const s = await nowcast.run(TICK);
      expect(s).toEqual({
        at: TICK.toISOString(), asOf: AS_OF, sdate: '2026-10-20', shift: 1,
        machines: 8, unmapped: 1, wrongUnit: 1, silent: 1, stale: 1, issued: 5,
      });
      expect(counters.calls).toEqual([{
        equnrs: ['EQ-100', 'EQ-200', 'EQ-400', 'EQ-500', 'EQ-600', 'EQ-700', 'EQ-800', 'EQ-900'],
        window: {
          shiftStart: new Date('2026-10-20T02:30:00Z'), asOf: new Date(AS_OF), openingSince: new Date('2026-10-20T02:25:00Z'),
        },
      }]);
    });

    it('so far plus the issued forecast\'s share: 25 + 120 * 10/12 = 125', async () => {
      expect((await snapshotsOf('acme', 'EQ-100')).map(pick)).toEqual([{
        externalId: 'EQ-100', sdate: '2026-10-20', shift: 1, asOf: AS_OF, counterAt: '2026-10-20T04:29:00.000Z',
        soFarL: 25, baseL: 120, baseSource: 'issued', predictedL: 125, method: 'so-far+ewma-0.5-28d-share',
      }]);
    });

    it('with no forecast issued yet, the base is computed from the same history: 30 + 60 * 10/12 = 80', async () => {
      // The live series (22) is read, not the replaced one. History: the day shifts of the
      // 18th and 19th only — not the night shift, not the target's own day.
      expect((await snapshotsOf('acme', 'EQ-200')).map(pick)).toEqual([expect.objectContaining({
        counterAt: '2026-10-20T04:25:00.000Z', soFarL: 30, baseL: 60, baseSource: 'computed', predictedL: 80,
      })]);
    });

    it('a machine with no reading since the start gets no snapshot, rather than a zero', async () => {
      expect(await snapshotsOf('acme', 'EQ-500')).toEqual([]);
      expect(await snapshotsOf('acme', 'EQ-400')).toEqual([]);
      expect(await snapshotsOf('acme', 'EQ-800')).toEqual([]);
      expect(await snapshotsOf('acme', 'EQ-300')).toEqual([]);
      expect(await snapshotsOf('acme', 'EQ-555')).toEqual([]);
    });

    it('a counter that went backwards is clamped to nothing burned: 0 + 60 * 10/12 = 50', async () => {
      expect((await snapshotsOf('acme', 'EQ-600')).map(pick)).toEqual([expect.objectContaining({
        soFarL: 0, baseL: 60, predictedL: 50,
      })]);
    });

    it('a stale feed is still used, and counter_at says how stale', async () => {
      // No history and no forecast: base 0, so the figure is what had burned by 03:00.
      expect((await snapshotsOf('acme', 'EQ-700')).map(pick)).toEqual([expect.objectContaining({
        asOf: AS_OF, counterAt: '2026-10-20T03:00:00.000Z', soFarL: 10, baseL: 0, baseSource: 'computed', predictedL: 10,
      })]);
    });

    it('files each snapshot under the account that owns the machine', async () => {
      expect((await snapshotsOf('globex')).map(pick)).toEqual([expect.objectContaining({
        externalId: 'EQ-900', soFarL: 12, baseL: 48, predictedL: 52,
      })]);
    });
  });

  describe('ticks', () => {
    it('a second pass in the same quarter hour writes nothing', async () => {
      const s = await nowcast.run(new Date('2026-10-20T04:44:59Z'));
      expect(s).toMatchObject({ asOf: AS_OF, issued: 0 });
      expect(await snapshotsOf('acme', 'EQ-100')).toHaveLength(1);
    });

    it('two passes at once both settle, and each machine gets one snapshot of the tick', async () => {
      counters.put('EQ-100', 11, '04:44:00', 5035);
      const tick = new Date('2026-10-20T04:52:00Z');
      const results = await Promise.allSettled([nowcast.run(tick), nowcast.run(tick)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const issued = results.map((r) => (r as PromiseFulfilledResult<{ issued: number } | null>).value?.issued ?? 0);
      expect(issued.reduce((a, b) => a + b, 0)).toBe(5);

      const [{ n, distinct }] = await owner.query(
        `SELECT count(*)::int AS n, count(DISTINCT (tenant_id, external_id))::int AS distinct
           FROM shift_fuel_nowcast WHERE as_of = '2026-10-20T04:45:00Z'`,
      );
      expect({ n, distinct }).toEqual({ n: 5, distinct: 5 });
      // 35 so far; 9.75 hours left: 35 + 120 * 9.75/12 = 132.5
      const latest = (await snapshotsOf('acme', 'EQ-100')).map(pick).pop();
      expect(latest).toMatchObject({ asOf: '2026-10-20T04:45:00.000Z', soFarL: 35, predictedL: 132.5 });
    });

    it('the tick that starts a shift has nothing to read and writes nothing', async () => {
      const calls = counters.calls.length;
      expect(await nowcast.run(new Date('2026-10-20T14:31:00Z'))).toMatchObject({ sdate: '2026-10-20', shift: 2, issued: 0 });
      expect(counters.calls).toHaveLength(calls);
    });
  });

  describe('what the database refuses', () => {
    const snapshot = (over: Record<string, unknown>) => {
      const row = {
        tenant_id: 'acme', source_system: 'ta-2.0', external_id: 'EQ-100', sdate: '2026-10-21', shift: 1,
        as_of: '2026-10-21T04:30:00Z', counter_at: '2026-10-21T04:29:00Z', so_far_l: 10, base_l: 100,
        base_source: 'issued', predicted_l: 90, method: 'refusal-check', ...over,
      } as Record<string, unknown>;
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO shift_fuel_nowcast (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      );
    };

    it('a rewrite, from the app role or the owner', async () => {
      const [row] = await snapshotsOf('acme', 'EQ-100');
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `UPDATE shift_fuel_nowcast SET predicted_l = 140 WHERE id = $1`, [row.id],
      ))).rejects.toThrow(/permission denied/);
      await expect(owner.query(`UPDATE shift_fuel_nowcast SET predicted_l = 140 WHERE id = $1`, [row.id]))
        .rejects.toThrow(/never rewritten/);
      expect((await snapshotsOf('acme', 'EQ-100'))[0].predictedL).toBe(125);
    });

    it('a delete by the app role', async () => {
      await expect(withTenantId(ds, 'acme', (m) => m.query(`DELETE FROM shift_fuel_nowcast WHERE external_id = 'EQ-100'`)))
        .rejects.toThrow(/permission denied/);
    });

    it('a prediction below what has burned, or above it plus the whole base', async () => {
      await expect(snapshot({ predicted_l: 9.99 })).rejects.toThrow(/ck_shift_fuel_nowcast_predicted/);
      await expect(snapshot({ predicted_l: 110.01 })).rejects.toThrow(/ck_shift_fuel_nowcast_predicted/);
    });

    it('negative litres, a third shift, or a base nobody named', async () => {
      await expect(snapshot({ so_far_l: -1, predicted_l: 0 })).rejects.toThrow(/ck_shift_fuel_nowcast_litres/);
      await expect(snapshot({ base_l: -1 })).rejects.toThrow(/ck_shift_fuel_nowcast_litres/);
      // Shift 3's generated window is the night's, so put the snapshot inside it: then the
      // only rule it breaks is the shift number.
      await expect(snapshot({ shift: 3, as_of: '2026-10-21T16:00:00Z', counter_at: '2026-10-21T15:00:00Z' }))
        .rejects.toThrow(/ck_shift_fuel_nowcast_shift/);
      await expect(snapshot({ base_source: 'guessed' })).rejects.toThrow(/ck_shift_fuel_nowcast_base_source/);
    });

    it('a snapshot outside its own shift, at its start, or at its end', async () => {
      // The 21st's day shift: 02:30 to 14:30 UTC.
      await expect(snapshot({ as_of: '2026-10-21T02:30:00Z', counter_at: '2026-10-21T02:30:00Z' }))
        .rejects.toThrow(/ck_shift_fuel_nowcast_in_shift/);
      await expect(snapshot({ as_of: '2026-10-21T14:30:00Z' })).rejects.toThrow(/ck_shift_fuel_nowcast_in_shift/);
      await expect(snapshot({ as_of: '2026-10-21T16:00:00Z' })).rejects.toThrow(/ck_shift_fuel_nowcast_in_shift/);
    });

    it('a counter read before the shift, or after the snapshot\'s own instant', async () => {
      await expect(snapshot({ counter_at: '2026-10-21T02:29:00Z' })).rejects.toThrow(/ck_shift_fuel_nowcast_counter/);
      await expect(snapshot({ counter_at: '2026-10-21T04:31:00Z' })).rejects.toThrow(/ck_shift_fuel_nowcast_counter/);
    });

    it('a second snapshot of the same tick by the same method', async () => {
      await expect(snapshot({ sdate: '2026-10-20', as_of: AS_OF, counter_at: '2026-10-20T04:00:00Z', method: 'so-far+ewma-0.5-28d-share' }))
        .rejects.toThrow(/uq_shift_fuel_nowcast_snapshot/);
    });

    it('a snapshot of a machine 2.0 does not have', async () => {
      await expect(snapshot({ external_id: 'NOPE' })).rejects.toThrow(/fk_shift_fuel_nowcast_equipment/);
    });
  });

  describe('one account cannot see another\'s', () => {
    it('reads nothing of acme\'s from globex, by filter or without one, and nothing with no account', async () => {
      expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT * FROM shift_fuel_nowcast WHERE tenant_id = 'acme'`)))
        .toEqual([]);
      expect(await ds.query(`SELECT count(*)::int AS n FROM shift_fuel_nowcast`)).toEqual([{ n: 0 }]);
    });

    it('cannot write a snapshot into acme from globex\'s session', async () => {
      await expect(withTenantId(ds, 'globex', (m) => m.query(
        `INSERT INTO shift_fuel_nowcast (tenant_id, source_system, external_id, sdate, shift, as_of, counter_at,
                                         so_far_l, base_l, base_source, predicted_l, method)
         VALUES ('acme', 'ta-2.0', 'EQ-100', '2026-10-21', 1, '2026-10-21T04:30:00Z', '2026-10-21T04:00:00Z',
                 1, 1, 'issued', 1, 'rls-check')`,
      ))).rejects.toThrow(/row-level security/);
    });

    it('answers globex\'s question about acme\'s machine with nothing', async () => {
      const at = new Date('2026-10-20T04:50:00Z');
      expect(await nowcastApi.machine(globex, { sourceSystem: 'ta-2.0', externalId: 'EQ-100' }, at)).toBeNull();
      expect((await nowcastApi.fleet(globex, at)).map((n) => n.externalId)).toEqual(['EQ-900']);
    });
  });

  describe('over HTTP, beside the forecast', () => {
    const AT = new Date('2026-10-20T04:50:00Z');
    const ref = { sourceSystem: 'ta-2.0', externalId: 'EQ-100' };

    it('one machine: every field of the forecast unchanged, and the newest snapshot of the running shift', async () => {
      const forecast = await api.machine(acme, ref, 7, AT);
      const r = await nowcastApi.besideMachine(acme, ref, forecast, AT);
      expect(r).toEqual({
        ...forecast,
        nowcast: {
          sdate: '2026-10-20', shift: 1, startsAt: '2026-10-20T02:30:00.000Z', endsAt: '2026-10-20T14:30:00.000Z',
          method: 'so-far+ewma-0.5-28d-share', asOf: '2026-10-20T04:45:00.000Z', counterAt: '2026-10-20T04:44:00.000Z',
          soFarL: 35, baseL: 120, baseSource: 'issued', predictedL: 132.5,
        },
      });
      // Asked as of the earlier tick, the earlier snapshot.
      expect((await nowcastApi.machine(acme, ref, new Date('2026-10-20T04:40:00Z')))?.predictedL).toBe(125);
    });

    it('nothing once the shift has ended, and nothing for a machine out of scope', async () => {
      expect(await nowcastApi.machine(acme, ref, new Date('2026-10-20T15:00:00Z'))).toBeNull();
      await expect(nowcastApi.machine({ ...acme, equipmentIds: ['EQ-200'] }, ref, AT)).rejects.toThrow(/No such equipment/);
    });

    it('the fleet: each machine\'s newest snapshot beside the forecast\'s own fields', async () => {
      const forecast = await api.fleet(acme, AT);
      const r = await nowcastApi.besideFleet(acme, forecast, AT);
      expect({ ...r, nowcasts: undefined }).toEqual({ ...forecast, nowcasts: undefined });
      expect(r.nowcasts.map((n) => [n.externalId, n.name, n.asOf, n.soFarL, n.predictedL])).toEqual([
        ['EQ-100', 'EQ-100', '2026-10-20T04:45:00.000Z', 35, 132.5],
        ['EQ-200', 'EQ-200', '2026-10-20T04:45:00.000Z', 30, 78.75],
        ['EQ-600', 'EQ-600', '2026-10-20T04:45:00.000Z', 0, 48.75],
        ['EQ-700', 'EQ-700', '2026-10-20T04:45:00.000Z', 10, 10],
      ]);
      expect((await nowcastApi.fleet({ ...acme, equipmentIds: ['EQ-200'] }, AT)).map((n) => n.externalId)).toEqual(['EQ-200']);
      expect(await nowcastApi.fleet({ ...acme, equipmentIds: [] }, AT)).toEqual([]);
    });
  });

  describe('the real read, against the existing platform\'s tables', () => {
    beforeAll(async () => {
      await owner.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
      // The tables and columns the probe reads, with the existing platform's names; the
      // log partitioned by created_at, as theirs is, with the index the probes walk.
      await owner.query(`
        CREATE SCHEMA ${FIXTURE};
        CREATE TABLE ${FIXTURE}.equipment_master (id serial PRIMARY KEY, equipment varchar(64) NOT NULL);
        CREATE TABLE ${FIXTURE}.devices (id serial PRIMARY KEY, equipment_id int);
        CREATE TABLE ${FIXTURE}.device_sensors (id serial PRIMARY KEY, device_id int, deleted_at timestamptz);
        CREATE TABLE ${FIXTURE}.sensor_measurements (id serial PRIMARY KEY, name varchar(64), unit varchar(16));
        CREATE TABLE ${FIXTURE}.device_sensor_measurements (
          id int PRIMARY KEY, device_sensor_id int, sensor_measurement_id int, deleted_at timestamptz);
        CREATE TABLE ${FIXTURE}.device_sensor_measurement_logs (
          id bigserial, device_sensor_measurement_id int NOT NULL, "timestamp" timestamptz NOT NULL,
          value double precision, created_at timestamptz NOT NULL, deleted_at timestamptz
        ) PARTITION BY RANGE (created_at);
        CREATE TABLE ${FIXTURE}.dsml_2026_09 PARTITION OF ${FIXTURE}.device_sensor_measurement_logs
          FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
        CREATE TABLE ${FIXTURE}.dsml_2026_10 PARTITION OF ${FIXTURE}.device_sensor_measurement_logs
          FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
        CREATE INDEX ON ${FIXTURE}.device_sensor_measurement_logs (device_sensor_measurement_id, "timestamp");

        INSERT INTO ${FIXTURE}.sensor_measurements (id, name, unit) VALUES (1, 'fuel_consumption', 'liter'), (2, 'engine_hours', 'hour');
        INSERT INTO ${FIXTURE}.equipment_master (id, equipment) VALUES (1, 'EQ-100'), (2, 'EQ-200'), (5, 'EQ-500'), (9, 'EQ-404');
        INSERT INTO ${FIXTURE}.devices (id, equipment_id) VALUES (1, 1), (2, 2), (5, 5), (9, 9);
        INSERT INTO ${FIXTURE}.device_sensors (id, device_id, deleted_at)
          VALUES (1, 1, NULL), (2, 2, NULL), (3, 2, '2026-10-01'), (5, 5, NULL), (9, 9, NULL);
        INSERT INTO ${FIXTURE}.device_sensor_measurements (id, device_sensor_id, sensor_measurement_id, deleted_at)
          VALUES (101, 1, 1, NULL), (102, 1, 2, NULL), (201, 2, 1, NULL), (301, 3, 1, NULL), (501, 5, 1, NULL), (901, 9, 1, NULL);`);
      const log = (series: number, ts: string, value: number, created = ts, deleted: string | null = null) => owner.query(
        `INSERT INTO ${FIXTURE}.device_sensor_measurement_logs (device_sensor_measurement_id, "timestamp", value, created_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [series, `2026-10-20T${ts}Z`, value, `2026-10-20T${created}Z`, deleted],
      );
      await log(101, '02:20:00', 4990); // older than the five minutes before the start
      await log(101, '02:28:00', 5000); // the counter at the start
      await log(101, '02:31:00', 5001);
      await log(101, '04:29:00', 5025); // the newest as of 04:30
      await log(101, '04:29:30', 5026, '04:35:00'); // reached the platform after 04:30
      await log(101, '04:29:45', 9999, '04:29:45', '2026-10-20T05:00:00Z'); // deleted
      await log(101, '04:40:00', 5030); // after 04:30
      await log(102, '04:29:50', 777); // engine hours, not fuel
      await log(201, '03:10:00', 10); // nothing before the start: this opens it
      await log(201, '04:25:00', 40);
      await log(301, '04:00:00', 66); // a deleted sensor's series
      await log(501, '02:00:00', 300); // nothing since the start
      await log(901, '04:00:00', 1); // a machine nobody asked about
    });

    const config = (schema = FIXTURE) => ({
      host: TEST_DB.DB_HOST, port: Number(TEST_DB.DB_PORT), username: TEST_DB.DB_USERNAME,
      password: TEST_DB.DB_PASSWORD, database: TEST_DB.DB_DATABASE, schema, ssl: false,
    });
    const window: FuelCounterWindow = {
      shiftStart: new Date('2026-10-20T02:30:00Z'), asOf: new Date('2026-10-20T04:30:00Z'), openingSince: new Date('2026-10-20T02:25:00Z'),
    };
    const at = (utc: string) => new Date(`2026-10-20T${utc}Z`);

    it('probes each fuel series of the asked-for machines at both ends of the shift so far', async () => {
      const reader = new LegacyShiftMetricsReader(config());
      try {
        expect(await reader.readFuelCounters(['EQ-100', 'EQ-200', 'EQ-500'], window)).toEqual([
          { equnr: 'EQ-100', seriesId: 101, unit: 'liter', opening: { at: at('02:28:00'), value: 5000 }, latest: { at: at('04:29:00'), value: 5025 } },
          { equnr: 'EQ-200', seriesId: 201, unit: 'liter', opening: { at: at('03:10:00'), value: 10 }, latest: { at: at('04:25:00'), value: 40 } },
          { equnr: 'EQ-500', seriesId: 501, unit: 'liter', opening: null, latest: null },
        ]);
        expect(await reader.readFuelCounters([], window)).toEqual([]);
      } finally {
        await reader.onModuleDestroy();
      }
    });

    it('agrees with the fake the service was driven by', async () => {
      const reader = new LegacyShiftMetricsReader(config());
      const fake = new FakeCounters();
      for (const [ts, value, created] of [['02:20:00', 4990], ['02:28:00', 5000], ['02:31:00', 5001], ['04:29:00', 5025],
        ['04:29:30', 5026, '04:35:00'], ['04:40:00', 5030]] as [string, number, string?][]) {
        fake.put('EQ-100', 101, ts, value, { createdUtc: created });
      }
      fake.put('EQ-200', 201, '03:10:00', 10);
      fake.put('EQ-200', 201, '04:25:00', 40);
      fake.put('EQ-500', 501, '02:00:00', 300);
      try {
        expect(await fake.readFuelCounters(['EQ-100', 'EQ-200', 'EQ-500'], window))
          .toEqual(await reader.readFuelCounters(['EQ-100', 'EQ-200', 'EQ-500'], window));
      } finally {
        await reader.onModuleDestroy();
      }
    });

    it('is refused if it ever tries to write, because the connection is read-only', async () => {
      const reader = new LegacyShiftMetricsReader(config());
      try {
        await reader.readFuelCounters(['EQ-100'], window);
        const conn = (reader as unknown as { source: DataSource }).source;
        await expect(conn.query(`DELETE FROM ${FIXTURE}.equipment_master`)).rejects.toThrow(/read-only transaction/);
      } finally {
        await reader.onModuleDestroy();
      }
    });

    it('needs LEGACY_SHIFT_DB_* to read anything', async () => {
      await expect(new LegacyShiftMetricsReader(null).readFuelCounters(['EQ-100'], window)).rejects.toThrow(/LEGACY_SHIFT_DB_/);
    });
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const left = await owner.query(
      `SELECT table_name::text AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shift_fuel_nowcast'
       UNION ALL SELECT proname::text FROM pg_proc WHERE proname = 'shift_fuel_nowcast_append_only'`,
    );
    expect(left).toEqual([]);
    // D50's tables are untouched by going down.
    expect(await owner.query(`SELECT to_regclass('public.shift_fuel_forecast')::text AS t`)).toEqual([{ t: 'shift_fuel_forecast' }]);
    await owner.runMigrations({ transaction: 'all' });
  }, 60_000);
});
