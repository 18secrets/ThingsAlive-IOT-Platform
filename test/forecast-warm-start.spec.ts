import { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ForecastWarmStart, WARM_START_DAYS } from '../src/forecast/forecast-warm-start';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ForecastWarmStart1762600000000';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-19T10:20:00.000Z');
const HOUR_END = new Date('2026-10-19T10:00:00.000Z');
const FIRST_ORIGIN = new Date(HOUR_END.getTime() - WARM_START_DAYS * DAY);
/** Every hour the replay can judge: from its first forecast up to the last finished hour. */
const REPLAYED_HOURS = (HOUR_END.getTime() - FIRST_ORIGIN.getTime()) / HOUR;
const SS = 'ta-2.0';
const STUB = join(__dirname, 'forecast', 'stub-worker.js');

/**
 * The forecast band's history, replayed from a machine's past (the warm start).
 *
 * The band needs fourteen days of steady running residuals, and the live pass makes them
 * only as time passes, so a machine onboarded with months of history waited weeks for
 * forecast-based detection. The warm start replays the pass over the history. What it
 * must not do is pass for live: every residual it writes says `backtest`, under a
 * `warm_start` run, and anything a pass had already measured is kept. The model is the
 * stub (`test/forecast/stub-worker.js`); everything around it is real.
 */
describeDb('forecast warm start: the band from history', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let reader: ForecastReader;
  let kpi: KpiEvaluatorService;
  let modelId: string;

  const warm = (mode = 'ok') => new ForecastWarmStart(ds, kpi, {
    command: process.execPath, args: [STUB], env: { STUB_MODE: mode },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-warm';
    process.env.AUTH_JWT_ISSUER = 'things-alive-warm-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    reader = app.get(ForecastReader);
    kpi = app.get(KpiEvaluatorService);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  /** On shift 08:00–18:00 UTC every day; the engine runs exactly then. */
  const inShift = (t: number) => { const h = new Date(t).getUTCHours(); return h >= 8 && h < 18; };

  const machine = async (ext: string, historyFrom: Date) => {
    await runTenantSpanning(owner, 'fixture', (m) => m.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: SS, externalId: ext, equipmentClassSlug: 'genset', classVersion: 1, plantId: null,
      tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: ext,
    }));
    for (const signal of ['coolant_temp_c', 'engine_running_status']) {
      await owner.query(`INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
          component_id, origin, imei, canonical_unit, valid_from, valid_to, is_primary, status)
        VALUES ('acme', $1, $2, $3, $3, '', 'physical', $4, 'u', '2026-01-01', NULL, true, 'active')`,
      [SS, ext, signal, `${ext}-${signal}`]);
    }
    await owner.query(`INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone, status)
      VALUES ('acme', $1, $2, 'Day', 480, 1080, '{0,1,2,3,4,5,6}', 'UTC', 'active')`, [SS, ext]);
    const times: string[] = [];
    const coolant: number[] = [];
    const running: number[] = [];
    for (let t = historyFrom.getTime(); t <= NOW.getTime(); t += 30 * 60_000) {
      const on = inShift(t);
      times.push(new Date(t).toISOString());
      coolant.push(on ? 84 + 3 * Math.sin((t / HOUR) * 2 * Math.PI / 10) : 34);
      running.push(on ? 1 : 0);
    }
    for (const [signal, values] of [['coolant_temp_c', coolant], ['engine_running_status', running]] as const) {
      await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
        SELECT 'acme', $1, $2, v, 'u', t, t, 'replayed' FROM unnest($3::timestamptz[], $4::double precision[]) AS r(t, v)`,
      [`${ext}-${signal}`, signal, times, values]);
    }
  };

  /** G-1: the replay window and its 512-hour context, and more. G-2: five days, too few to replay. */
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "forecast_run", "telemetry_reading", "signal_binding_version", "equipment_shift",
      "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile" CASCADE`);
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('genset', 1, 'published', 'Genset', ('[{"signal":"coolant_temp_c","unit":"degC","required":true},'
        || '{"signal":"engine_running_status","unit":"state","required":true}]')::jsonb)`);
    await owner.query(`INSERT INTO equipment_class_sensor_requirement
        (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled, forecast_horizon_hours, stale_after_seconds)
      VALUES ('genset', 1, 'coolant_temp_c', 'degC', true, 24, 3600), ('genset', 1, 'engine_running_status', 'state', false, NULL, 3600)`);
    await machine('G-1', new Date(FIRST_ORIGIN.getTime() - 520 * HOUR));
    await machine('G-2', new Date(NOW.getTime() - 5 * DAY));
  }, 120_000);

  const residuals = (ext: string) => owner.query(
    `SELECT step_at, lead_steps, origin, operating, actual, predicted FROM forecast_residual
      WHERE external_id = $1 ORDER BY step_at`, [ext]);
  const band = (ext: string) => withTenantId(ds, 'acme', async (m) => {
    const profile = await m.getRepository(EquipmentProfile).findOneByOrFail({ tenantId: 'acme', externalId: ext });
    return reader.band(m, 'acme', profile, 'coolant_temp_c', modelId, NOW);
  });

  it('1. three weeks of history become a band at once, every residual marked backtest, one per hour, leads 1–4', async () => {
    expect((await band('G-1')).established).toBe(false);

    const s = await warm().run(NOW);
    expect(s).toMatchObject({ outcome: 'completed', warmed: 1, noHistory: 1, residuals: REPLAYED_HOURS });

    const rows = await residuals('G-1');
    expect(rows).toHaveLength(REPLAYED_HOURS);
    expect(new Set(rows.map((r: { origin: string }) => r.origin))).toEqual(new Set(['backtest']));
    expect(new Set(rows.map((r: { lead_steps: number }) => r.lead_steps))).toEqual(new Set([1, 2, 3, 4]));
    // The same operating gate as the pass: on in shift, parked out of it.
    for (const r of rows as { step_at: Date; operating: boolean }[]) {
      expect(r.operating).toBe(inShift(new Date(r.step_at).getTime() + HOUR / 2));
    }
    const [run] = await owner.query(`SELECT kind, outcome, forecast, skipped FROM forecast_run WHERE id = $1`, [s.runId]);
    expect(run).toEqual({ kind: 'warm_start', outcome: 'completed', forecast: 1, skipped: 1 });

    expect(await band('G-1')).toMatchObject({ established: true });
    // It forecasts the past only: today's forecast is still the pass's to make.
    expect(await owner.query(`SELECT 1 FROM forecast_latest`)).toEqual([]);
  });

  it('2. too little history is recorded once and not tried again; a replayed signal is not replayed again', async () => {
    await warm().run(NOW);
    const [skip] = await owner.query(`SELECT external_id, reason FROM forecast_run_skip`);
    expect(skip).toEqual({ external_id: 'G-2', reason: 'warm_start_no_history' });
    expect(await residuals('G-2')).toEqual([]);

    const again = await warm().run(NOW);
    expect(again).toMatchObject({ runId: null, warmed: 0, noHistory: 0 });
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_run WHERE kind = 'warm_start'`)).toEqual([{ n: 1 }]);
  });

  it('3. an hour a pass already measured keeps its live residual; the replay never overwrites it', async () => {
    const [{ id: runId }] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES (now(), now(), 3600, $1, 'completed') RETURNING id`, [modelId]);
    const measured = new Date(HOUR_END.getTime() - 5 * HOUR);
    await owner.query(`INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
        lead_steps, predicted, actual, residual, operating)
      VALUES ('acme', $1, 'G-1', 'coolant_temp_c', $2, $3, $4, 2, 80, 81.5, 1.5, true)`, [SS, modelId, runId, measured]);

    await warm().run(NOW);
    const [kept] = await owner.query(`SELECT origin, predicted, actual FROM forecast_residual WHERE external_id = 'G-1' AND step_at = $1`, [measured]);
    expect(kept).toEqual({ origin: 'live', predicted: 80, actual: 81.5 });
    expect(await residuals('G-1')).toHaveLength(REPLAYED_HOURS);
  });

  it('4. a worker that fails writes nothing: no residual, no skip record, and the run says failed', async () => {
    const s = await warm('crash').run(NOW);
    expect(s.outcome).toBe('failed');
    expect(await owner.query(`SELECT 1 FROM forecast_residual`)).toEqual([]);
    expect(await owner.query(`SELECT 1 FROM forecast_run_skip`)).toEqual([]);
    // Nothing recorded means nothing is skipped next time: both machines are still owed.
    expect(await warm().run(NOW)).toMatchObject({ warmed: 1, noHistory: 1 });
  });

  it('5. two warm starts fired together both settle; one replays, the other holds back, and nothing is doubled', async () => {
    const results = await Promise.allSettled([warm().run(NOW), warm().run(NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome).sort();
    expect(outcomes).toEqual(['completed', 'lock_held']);
    expect(await residuals('G-1')).toHaveLength(REPLAYED_HOURS);
  });

  it(`6. ${MIGRATION} down removes the replay's residuals, runs and skip records with the columns; up runs again`, async () => {
    await warm().run(NOW);
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_residual`)).toEqual([{ n: 0 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_run_skip`)).toEqual([{ n: 0 }]);
    expect(await owner.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('forecast_residual', 'forecast_run') AND column_name IN ('origin', 'kind')`)).toEqual([]);
    // The constraint is back as it was: the warm start's reason is refused again.
    await expect(owner.query(`INSERT INTO forecast_run_skip (tenant_id, run_id, source_system, external_id, signal, reason)
      VALUES ('acme', gen_random_uuid(), $1, 'G-1', 'coolant_temp_c', 'warm_start_no_history')`, [SS]))
      .rejects.toThrow(/ck_forecast_run_skip_reason/);
    await owner.runMigrations({ transaction: 'all' });
    expect(await warm().run(NOW)).toMatchObject({ outcome: 'completed', warmed: 1 });
  });
});
