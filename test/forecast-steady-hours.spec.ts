import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { learnBand, ResidualPoint, runStartHours } from '../src/forecast/forecast-band';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { createApp } from '../src/main';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIDNIGHT = Date.UTC(2026, 9, 19);

/**
 * A working day as the uploaded excavator history showed it (hours UTC): parked until 08,
 * the first running hour missing by about +18, steady running after missing by about ±0.5,
 * parked again from 17. Twenty such days before MIDNIGHT.
 */
const day = (d: number, startMiss = 18): ResidualPoint[] => {
  const out: ResidualPoint[] = [];
  for (let h = 6; h <= 18; h++) {
    const operating = h >= 8 && h < 17;
    const residual = !operating ? 0 : h === 8 ? startMiss : ((d * 7 + h * 3) % 11) / 10 - 0.5;
    out.push({ stepAt: new Date(MIDNIGHT - d * DAY + h * HOUR), lead: 1, residual, operating });
  }
  return out;
};
const days = (n: number) => Array.from({ length: n }, (_, i) => day(n - i)).flat();

describe('the forecast band learns from steady running only', () => {
  it('a run\'s first hour is the operating hour after a parked one; an hour after a gap is not', () => {
    const at = (h: number) => new Date(MIDNIGHT + h * HOUR);
    const points: ResidualPoint[] = [
      { stepAt: at(7), lead: 1, residual: 0, operating: false },
      { stepAt: at(8), lead: 1, residual: 18, operating: true },
      { stepAt: at(9), lead: 1, residual: 1, operating: true },
      { stepAt: at(12), lead: 1, residual: 1, operating: true }, // 11 has no residual
    ];
    expect([...runStartHours(points)]).toEqual([at(8).getTime()]);
  });

  it('the first hour\'s +18 does not widen the band: it stays the steady ±0.5', () => {
    const band = learnBand(days(20), []);
    expect(band.established).toBe(true);
    if (!band.established) return;
    expect(band.hi).toBeLessThanOrEqual(0.5);
    expect(band.lo).toBeGreaterThanOrEqual(-0.5);
    // Twenty days, steady hours 09–16: eight a day, the first hour of each left out.
    expect(band.n).toBe(20 * 8);
  });

  it('fourteen days still means fourteen days of steady hours, not of any operating hour', () => {
    expect(learnBand(days(13), [])).toMatchObject({ established: false, reason: 'baseline_not_established', cleanDays: 13 });
  });
});

/**
 * The verdict the chart, the forecast routes and the recommendations read: the newest
 * steady running hour, never a parked or first hour, against the band from before it.
 */
describeDb('forecast anomaly: the newest steady hour is judged', () => {
  let owner: DataSource;
  let app: INestApplication;
  let reader: ForecastReader;
  let modelId: string;
  let runId: string;
  const SS = 'ta-2.0';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-steady';
    process.env.AUTH_JWT_ISSUER = 'things-alive-steady-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    reader = app.get(ForecastReader);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
    await runTenantSpanning(owner, 'fixture', (m) => m.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: SS, externalId: 'X-1', equipmentClassSlug: null, classVersion: null, plantId: null,
      tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: 'X-1',
    }));
    [{ id: runId }] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES (now(), now(), 3600, $1, 'completed') RETURNING id`, [modelId]);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => { await owner.query(`DELETE FROM forecast_residual`); });

  const store = (points: ResidualPoint[]) => owner.query(
    `INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
       lead_steps, predicted, actual, residual, operating)
     SELECT 'acme', $1, 'X-1', 'coolant', $2, $3, t, 1, 80, 80 + r, r, o
       FROM unnest($4::timestamptz[], $5::double precision[], $6::boolean[]) AS p(t, r, o)`,
    [SS, modelId, runId, points.map((p) => p.stepAt.toISOString()), points.map((p) => p.residual), points.map((p) => p.operating)]);

  const anomaly = async (at: Date) => withTenantId(owner, 'acme', async (m) => {
    const profile = await m.getRepository(EquipmentProfile).findOneByOrFail({ externalId: 'X-1' });
    return reader.anomaly(m, 'acme', profile, 'coolant', modelId, at);
  });

  it('1. the morning\'s first hour, +18 like every morning, is not judged: yesterday\'s last steady hour is, and it is normal', async () => {
    await store([...days(20), ...day(0).filter((p) => p.stepAt.getTime() <= MIDNIGHT + 8 * HOUR)]);
    const a = await anomaly(new Date(MIDNIGHT + 9 * HOUR));
    expect(a).toMatchObject({ state: 'normal', at: new Date(MIDNIGHT - DAY + 16 * HOUR).toISOString() });
  });

  it('2. at night the newest hour is parked and is not judged against the running band', async () => {
    const tonight = { stepAt: new Date(MIDNIGHT + 20 * HOUR), lead: 1, residual: -45, operating: false };
    await store([...days(20), ...day(0), tonight]);
    const a = await anomaly(new Date(MIDNIGHT + 21 * HOUR));
    expect(a).toMatchObject({ state: 'normal', at: new Date(MIDNIGHT + 16 * HOUR).toISOString() });
  });

  it('3. a steady hour well past the band is anomalous, with that hour named', async () => {
    const fault = day(0).map((p) => (p.stepAt.getTime() === MIDNIGHT + 10 * HOUR ? { ...p, residual: 6 } : p))
      .filter((p) => p.stepAt.getTime() <= MIDNIGHT + 10 * HOUR);
    await store([...days(20), ...fault]);
    const a = await anomaly(new Date(MIDNIGHT + 11 * HOUR));
    expect(a).toMatchObject({ state: 'anomalous', at: new Date(MIDNIGHT + 10 * HOUR).toISOString(), residual: 6 });
    expect(a.band!.hi).toBeLessThanOrEqual(0.5);
  });
});
