import { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { naiveScale, scoreSeries, seasonalAt } from '../src/evaluation/backtest-scoring';
import { EvalResult } from '../src/evaluation/evaluation.entities';
import { EvaluationService } from '../src/evaluation/evaluation.service';
import { ForecastLatest, ForecastModel } from '../src/forecast/forecast.entities';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { createApp } from '../src/main';
import { runTenantSpanning, withEvalSession, withTenantId } from '../src/scope/tenant-session';
import { WorkOrder } from '../src/work/entities/work-order.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'Evaluation1761300000000';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SS = 'ta-2.0';
const STUB = join(__dirname, 'forecast', 'stub-worker.js');
/** The origin of the hand-worked forecast: its first step is this hour. */
const O = Date.parse('2026-10-10T00:00:00.000Z');
const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-15T00:00:00.000Z');

/**
 * The evaluation namespace and the TTM backtest (task QEVAL1a). The model is QML1's stub
 * worker, which forecasts the last context value — so through the replay it is
 * persistence by construction, and its error must equal persistence's exactly. Every
 * forecast, actual and residual is planted, so every number asserted is worked by hand.
 */
describeDb('evaluation: the run namespace and the TTM backtest', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let evals: EvaluationService;
  let modelId: string;
  let forecastRunId: string;

  const service = () => new EvaluationService(ds, app.get(ForecastReader), {
    command: process.execPath, args: [STUB], env: { STUB_MODE: 'ok' },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qeval1a';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qeval1a-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    evals = service();
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  // Evaluation rows are append-only by trigger, so each test starts from an emptied
  // namespace the only way the database allows: TRUNCATE, which no trigger here covers.
  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "eval_result", "eval_run", "forecast_run", "forecast_input_bucket", "telemetry_reading", "alert_event", "work_order",
        "alert_rule", "equipment_profile", "client_equipment_class", "equipment_class_profile" CASCADE`);
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('genset', 1, 'published', 'Genset', '[]'::jsonb)`);
    for (const [tenant, ext] of [['acme', 'G-1'], ['globex', 'G-2']] as const) {
      await runTenantSpanning(owner, 'fixture', async (m) => {
        await m.getRepository(ClientEquipmentClass).save({
          tenantId: tenant, slug: 'genset', name: 'Genset', description: null, category: null, expectedSignals: [],
          failureModes: [], defaultThresholds: {}, templateSlug: 'genset', templateVersion: 1, templateChecksum: 'c',
          copiedAt: new Date(O), status: 'active', updatedBy: 'u',
        });
        await m.getRepository(EquipmentProfile).save({
          tenantId: tenant, sourceSystem: SS, externalId: ext, equipmentClassSlug: 'genset', classVersion: 1, plantId: null,
          tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: ext,
        });
      });
    }
    [{ id: forecastRunId }] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES (now(), now(), 60, $1, 'completed') RETURNING id`, [modelId]);
  });

  const bucket = (tenant: string, ext: string, signal: string, at: number, value: number) => owner.query(
    `INSERT INTO forecast_input_bucket (tenant_id, source_system, external_id, signal, bucket_at, value, readings)
     VALUES ($1, $2, $3, $4, $5, $6, 2)`, [tenant, SS, ext, signal, new Date(at), value]);

  const sample = (tenant: string, ext: string, signal: string, horizon: { t: number; v: number }[], stepSeconds = 3600) => owner.query(
    `INSERT INTO forecast_daily_sample (tenant_id, source_system, external_id, signal, day, model_id, run_id, generated_at, step_seconds, horizon)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10::jsonb)`,
    [tenant, SS, ext, signal, new Date(horizon[0].t).toISOString().slice(0, 10), modelId, forecastRunId, new Date(horizon[0].t),
      stepSeconds, JSON.stringify(horizon.map((p) => ({ t: new Date(p.t).toISOString(), v: p.v, lo: null, hi: null })))]);

  /**
   * The hand-worked series, acme G-1 coolant. Forecast 11, 12, 13, 14 for O … O+3h; actuals
   * 12, 11, 15 and none at O+3h. Persistence origin (O−1h) 10. Same hour a day earlier 9, 10, 14.
   *   model errors 1, 1, 2 · persistence 2, 1, 5 · seasonal 3, 1, 1
   *   naive scale: consecutive actual changes 1, 4 (day before) and 2, 1, 4 → 12 / 5 = 2.4
   */
  const plantHandWorked = async () => {
    const actuals: [number, number][] = [[O - DAY, 9], [O - DAY + HOUR, 10], [O - DAY + 2 * HOUR, 14],
      [O - HOUR, 10], [O, 12], [O + HOUR, 11], [O + 2 * HOUR, 15]];
    for (const [at, v] of actuals) await bucket('acme', 'G-1', 'coolant_temp_c', at, v);
    await sample('acme', 'G-1', 'coolant_temp_c', [11, 12, 13, 14].map((v, i) => ({ t: O + i * HOUR, v })));
  };

  const run = (id: string) => owner.query(`SELECT * FROM eval_run WHERE id = $1`, [id]).then((r) => r[0]);
  const results = (runId: string) => owner.query(
    `SELECT tenant_id, external_id, subject, variant, metrics FROM eval_result WHERE run_id = $1 ORDER BY tenant_id, subject, variant`, [runId]);

  // ------------------------------------------------------------- G10, attempted

  it('1. an eval session cannot write a forecast, raise an alert, open a work order or move a model; the live tables are unchanged', async () => {
    const before = await owner.query(`SELECT (SELECT count(*) FROM forecast_latest)::int AS f, (SELECT count(*) FROM alert_event)::int AS a,
      (SELECT count(*) FROM work_order)::int AS w`);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.getRepository(ForecastLatest).insert({
      tenantId: 'acme', sourceSystem: SS, externalId: 'G-1', signal: 'coolant_temp_c', modelId, runId: forecastRunId,
      generatedAt: new Date(O), stepSeconds: 3600, contextFrom: new Date(O - DAY), contextTo: new Date(O),
      inputCoverage: 1, imputedSteps: 0, horizon: [{ t: new Date(O).toISOString(), v: 1, lo: null, hi: null }],
    }))).rejects.toThrow(/permission denied for table forecast_latest/);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
       VALUES ('acme', gen_random_uuid(), 'Overheat', $1, 'G-1', 'high', 'hot', '{}'::jsonb, 'open', now())`, [SS],
    ))).rejects.toThrow(/permission denied for table alert_event/);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.getRepository(WorkOrder).insert({
      tenantId: 'acme', reference: 'WO-EVAL', sourceSystem: SS, externalId: 'G-1', title: 'from an eval', raisedBy: 'eval',
    } as Partial<WorkOrder>))).rejects.toThrow(/permission denied for table work_order/);
    await expect(withEvalSession(ds, 'platform', (m) => m.query(
      `UPDATE forecast_model SET status = 'retired' WHERE id = $1`, [modelId],
    ))).rejects.toThrow(/permission denied for table forecast_model/);

    expect(await owner.query(`SELECT (SELECT count(*) FROM forecast_latest)::int AS f, (SELECT count(*) FROM alert_event)::int AS a,
      (SELECT count(*) FROM work_order)::int AS w`)).toEqual(before);
    expect((await owner.getRepository(ForecastModel).findOneByOrFail({ id: modelId })).status).toBe('active');
  });

  it('2. a finished run and its results cannot be changed or removed, and take no new result — by anyone', async () => {
    await plantHandWorked();
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    expect(s.status).toBe('completed');
    await expect(owner.query(`UPDATE eval_result SET metrics = '{}'::jsonb WHERE run_id = $1`, [s.runId]))
      .rejects.toThrow(/never changed or removed/);
    await expect(owner.query(`DELETE FROM eval_result WHERE run_id = $1`, [s.runId])).rejects.toThrow(/never changed or removed/);
    await expect(owner.query(`UPDATE eval_run SET summary = '{}'::jsonb WHERE id = $1`, [s.runId])).rejects.toThrow(/finished run is immutable/);
    await expect(owner.query(`DELETE FROM eval_run WHERE id = $1`, [s.runId])).rejects.toThrow(/never deleted/);
    await expect(owner.query(`INSERT INTO eval_result (tenant_id, run_id, source_system, external_id, subject, variant, metrics)
      VALUES ('acme', $1, $2, 'G-1', 'late', 'daily_sample', '{}'::jsonb)`, [s.runId, SS])).rejects.toThrow(/takes no more results/);
  });

  it('3. the eval role reads only what it is granted: an unlisted table is refused', async () => {
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(`SELECT 1 FROM app_user LIMIT 1`)))
      .rejects.toThrow(/permission denied for table app_user/);
  });

  it('4. results are the account\'s own: tenant B reads none of tenant A\'s, tenant A reads its own', async () => {
    await plantHandWorked();
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    const own = await withTenantId(ds, 'acme', (m) => m.getRepository(EvalResult).find({ where: { runId: s.runId } }));
    const other = await withTenantId(ds, 'globex', (m) => m.getRepository(EvalResult).find({ where: { runId: s.runId } }));
    expect(own.length).toBeGreaterThan(0);
    expect(other).toEqual([]);
    await expect(withTenantId(ds, 'acme', (m) => m.query(`UPDATE eval_result SET subject = 'x'`))).rejects.toThrow(/permission denied/);
  });

  it('4b. the run row holds aggregates only: no machine identifier appears in it', async () => {
    await plantHandWorked();
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    expect(JSON.stringify(await run(s.runId))).not.toMatch(/G-1/);
  });

  // ------------------------------------------------------------- behaviour

  it('6. MAE, the two naive baselines and their scaled forms equal the hand-worked numbers', async () => {
    await plantHandWorked();
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    expect(s.status).toBe('completed');
    const [row] = (await results(s.runId)).filter((r: { variant: string }) => r.variant === 'daily_sample');
    const m = row.metrics;
    expect(m.scale).toBeCloseTo(2.4, 12);
    expect(m.excluded).toEqual({ no_actual: 1 });
    expect(m.byLead.map((l: { lead: number; n: number }) => [l.lead, l.n])).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect(m.byLead[0].model.mae).toBe(1);
    expect(m.byLead[0].persistence.mae).toBe(2);
    expect(m.byLead[0].seasonal.mae).toBe(3);
    expect(m.byLead[2].model.mae).toBe(2);
    expect(m.byLead[2].persistence.mae).toBe(5);
    expect(m.byLead[2].seasonal.mae).toBe(1);
    expect(m.byLead[0].model.maeScaled).toBeCloseTo(1 / 2.4, 12);
    expect(m.overall.n).toBe(3);
    expect(m.overall.model.mae).toBeCloseTo(4 / 3, 12);
    expect(m.overall.persistence.mae).toBeCloseTo(8 / 3, 12);
    expect(m.overall.seasonal.mae).toBeCloseTo(5 / 3, 12);
    expect(m.overall.model.maeScaled).toBeCloseTo(4 / 3 / 2.4, 12);
    // The daily sample carries no interval, so coverage is null with the reason, not 0.
    expect(m.overall.interval).toEqual({ n: 0, covered: 0, coverage: null, reason: 'no_interval_on_forecast' });
    // The same numbers pooled into the run's summary, by signal role.
    const summary = (await run(s.runId)).summary;
    expect(summary.dailySample.bySignal.coolant_temp_c.overall.model.mae).toBeCloseTo(4 / 3, 12);
    expect(summary.dailySample.bySignal.coolant_temp_c.series).toBe(1);
  });

  it('6b. the seasonal baseline never reads an actual from after the origin', () => {
    expect(seasonalAt(O + 23 * HOUR, 24, HOUR)).toBe(O - HOUR);
    expect(seasonalAt(O + 24 * HOUR, 25, HOUR)).toBe(O - 24 * HOUR);
    expect(naiveScale(new Map([[0, 5], [HOUR, 5]]), HOUR)).toBeNull();
    // A forecast at a step the actuals are not at is not scored, and says why.
    const s = scoreSeries(new Map([[0, 1]]), [{ stepMs: 2 * HOUR, points: [{ t: 0, v: 1, lo: null, hi: null }] }], HOUR);
    expect(s.excluded).toEqual({ step_mismatch: 1 });
  });

  it('7. a backtest over nothing scorable reports null with a reason, never 0', async () => {
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    expect(s.status).toBe('completed');
    const o = (await run(s.runId)).summary.dailySample.overall;
    expect(o.n).toBe(0);
    expect(o.model.mae).toBeNull();
    expect(o.persistence.mae).toBeNull();
    expect(o.reason).toBe('no_scorable_steps');
  });

  it('7b. the replay goes through the worker; the stub forecasts the last value, so its error is persistence\'s exactly', async () => {
    const start = TO.getTime() - 30 * DAY;
    await owner.query(`
      INSERT INTO forecast_input_bucket (tenant_id, source_system, external_id, signal, bucket_at, value, readings)
      SELECT 'acme', $1, 'G-1', 'oil_pressure_kpa', ts, 400 + 2 * sin(extract(epoch FROM ts) / 3600 * 2 * pi() / 24), 2
        FROM generate_series($2::timestamptz, $3::timestamptz, interval '1 hour') ts`, [SS, new Date(start), new Date(TO.getTime() - HOUR)]);
    const s = await evals.runBacktest({ dataset: 'real', from: new Date(start), to: TO, replayDays: 2 });
    expect(s.status).toBe('completed');
    const [row] = (await results(s.runId)).filter((r: { variant: string }) => r.variant === 'replay');
    expect(row.subject).toBe('oil_pressure_kpa');
    expect(row.metrics.traces).toBe(2);
    expect(row.metrics.byLead).toHaveLength(96);
    for (const l of row.metrics.byLead) expect(l.model.mae).toBeCloseTo(l.persistence.mae, 9);
    expect((await run(s.runId)).summary.replay).toMatchObject({ ran: true, origins: 2, refusedByWorker: 0 });
  });

  it('7c. anomaly states are counted day by day against a band from the days before; overlap with a later alert is counted as overlap', async () => {
    const start = Date.parse('2026-09-20T00:00:00.000Z');
    // 16 days of operating residuals alternating ±1, and one of +50 on the last day.
    await owner.query(`
      INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at, lead_steps,
                                     predicted, actual, residual, operating)
      SELECT 'acme', $1, 'G-1', 'coolant_temp_c', $2, $3, ts, 1, 80,
             80 + CASE WHEN ts = $5::timestamptz THEN 50 WHEN extract(hour FROM ts AT TIME ZONE 'UTC')::int % 2 = 0 THEN 1 ELSE -1 END,
             CASE WHEN ts = $5::timestamptz THEN 50 WHEN extract(hour FROM ts AT TIME ZONE 'UTC')::int % 2 = 0 THEN 1 ELSE -1 END, true
        FROM generate_series($4::timestamptz, $4::timestamptz + interval '16 days' - interval '1 hour', interval '1 hour') ts`,
    [SS, modelId, forecastRunId, new Date(start), new Date(start + 15 * DAY + 5 * HOUR)]);
    // Account-wide, as the KPI baseline reads rules: it is the alert's signal that ties it here.
    const [{ id: ruleId }] = await owner.query(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
      VALUES ('acme', 'hot', 'Hot', 'signal-threshold', '{"signal":"coolant_temp_c","op":"gt","value":100}'::jsonb, 'account', 'high', true)
      RETURNING id`);
    await owner.query(`INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
      VALUES ('acme', $2, 'Hot', $1, 'G-1', 'high', 'hot', '{}'::jsonb, 'open', $3)`,
    [SS, ruleId, new Date(start + 15 * DAY + 9 * HOUR)]);

    const s = await evals.runBacktest({ dataset: 'real', from: new Date(start), to: new Date(start + 16 * DAY) });
    const [row] = (await results(s.runId)).filter((r: { variant: string }) => r.variant === 'anomaly_states');
    // Days 1–14 have fewer than 14 clean days before them; days 15 and 16 have a band.
    expect(row.metrics).toMatchObject({ baseline_not_established: 14 * 24, normal: 47, anomalous: 1, stretches: 1 });
    expect(row.metrics.stretchesWithAlert).toBe(1);
    expect((await run(s.runId)).summary.anomalyStates.note).toMatch(/not precision/);
  });

  it('11. a run that exhausts its budget says so, and lists what it did not reach', async () => {
    await plantHandWorked();
    await sample('globex', 'G-2', 'coolant_temp_c', [{ t: O, v: 1 }]);
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO, budgetSeries: 1 });
    expect(s.status).toBe('budget_exhausted');
    expect((await run(s.runId)).unreached).toBe(1);
    const unreached = (await results(s.runId)).filter((r: { variant: string }) => r.variant === 'unreached');
    expect(unreached).toEqual([expect.objectContaining({ tenant_id: 'globex', external_id: 'G-2', metrics: { reason: 'budget_exhausted' } })]);
    // The time budget too: a clock that has already run past it reaches nothing.
    let t = 0;
    const late = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO, budgetSeconds: 1, clock: () => (t += 5_000) });
    expect(late.status).toBe('budget_exhausted');
    expect((await run(late.runId)).unreached).toBe(2);
  });

  it('12. a run over simulated telemetry is labelled seeded, even when asked to be real', async () => {
    await plantHandWorked();
    await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      VALUES ('acme', 'G1', 'coolant_temp_c', 1, 'u', $1, $1, 'simulated')`, [new Date(O)]);
    const s = await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    const r = await run(s.runId);
    expect(r.dataset).toBe('seeded');
    expect(r.dataset_note).toMatch(/simulated telemetry/);
    expect(r.summary.claim).toMatch(/smoke test/);
    const asked = await evals.runBacktest({ dataset: 'seeded', from: FROM, to: TO });
    expect((await run(asked.runId)).dataset).toBe('seeded');
  });

  // ------------------------------------------------------------- concurrency

  it('13. two runs of one kind fired together: both settle, one runs, one reports the lock held, results written once', async () => {
    await plantHandWorked();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const a = evals.runBacktest({ dataset: 'real', from: FROM, to: TO, onLocked: () => gate });
    const b = evals.runBacktest({ dataset: 'real', from: FROM, to: TO, onLocked: () => gate });
    void Promise.race([a, b]).then(() => open());
    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    const statuses = settled.map((x) => (x as PromiseFulfilledResult<{ status: string }>).value.status).sort();
    expect(statuses).toEqual(['completed', 'lock_held']);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM eval_result WHERE variant = 'daily_sample'`);
    expect(n).toBe(1);
  });

  // ------------------------------------------------------------- migration

  it('14. the down path removes the namespace and leaves QML1\'s tables and rows alone', async () => {
    await plantHandWorked();
    await evals.runBacktest({ dataset: 'real', from: FROM, to: TO });
    expect((await owner.query(`SELECT count(*)::int AS n FROM eval_result`))[0].n).toBeGreaterThan(0);
    const samples = (await owner.query(`SELECT count(*)::int AS n FROM forecast_daily_sample`))[0].n;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('eval_run')::text AS r, to_regclass('eval_result')::text AS s`)).toEqual([{ r: null, s: null }]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM forecast_daily_sample`))[0].n).toBe(samples);
    expect(await owner.query(`SELECT has_table_privilege('ta_eval', 'forecast_daily_sample', 'SELECT') AS g`)).toEqual([{ g: false }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('eval_run')::text AS r`)).toEqual([{ r: 'eval_run' }]);
  });
});
