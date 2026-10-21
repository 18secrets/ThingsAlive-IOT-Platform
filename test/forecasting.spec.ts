import { INestApplication } from '@nestjs/common';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import {
  BAND_QUANTILES, BASELINE_DAYS, buildContext, FORECAST_PASS_LOCK_KEY, learnBand, MIN_INPUT_COVERAGE, quantile,
} from '../src/forecast/forecast-band';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ForecastService } from '../src/forecast/forecast.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { MIN_COVERAGE_RATIO } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { tryTakePassLock } from '../src/shift/services/pass-lock';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'Forecasting1761100000000';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-19T10:20:00.000Z');
const HOUR_END = new Date('2026-10-19T10:00:00.000Z');
const CONTEXT_FROM = new Date(HOUR_END.getTime() - 512 * HOUR);
const SS = 'ta-2.0';
const STUB = join(__dirname, 'forecast', 'stub-worker.js');
const RECORD = join(tmpdir(), `qml1-stub-${process.pid}.json`);
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * Forecasting (task QML1). The model is the stub (`test/forecast/stub-worker.js`), which
 * speaks the worker's contract with no torch; everything around it is real — what the
 * library declares, freshness, the rollup, the lock, the ledger, the band and the page —
 * because that is where a forecast becomes trustworthy or does not.
 */
describeDb('forecasting: the pass, the band and the chart', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let reader: ForecastReader;
  let kpi: KpiEvaluatorService;
  let pages: PageService;
  let modelId: string;

  const pass = (mode = 'ok', env: Record<string, string> = {}) => new ForecastService(ds, kpi, reader, {
    command: process.execPath, args: [STUB], env: { STUB_MODE: mode, STUB_RECORD: RECORD, ...env },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qml1';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qml1-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    reader = app.get(ForecastReader);
    kpi = app.get(KpiEvaluatorService);
    pages = app.get(PageService);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { rmSync(RECORD, { force: true }); await app?.close(); await owner?.destroy(); });

  const readings = (imei: string, signal: string, from: Date, to: Date, base: number) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT CASE WHEN $1 LIKE 'G2%' THEN 'globex' ELSE 'acme' END, $1, $2,
            $3 + 2 * sin(extract(epoch FROM ts) / 3600 * 2 * pi() / 24), 'u', ts, ts, 'live'
       FROM generate_series($4::timestamptz, $5::timestamptz, interval '30 minutes') ts`,
    [imei, signal, base, from, to]);

  /**
   * acme G-1: coolant and oil declared (24 h horizon), fuel not. globex G-2: the same class,
   * with only coolant bound, so its oil is `unbound`. Stale after an hour.
   * Readings every 30 minutes from before the context window to a day past NOW; a test
   * that needs a dead sensor deletes its tail.
   */
  beforeEach(async () => {
    rmSync(RECORD, { force: true });
    await owner.query(`
      TRUNCATE TABLE "forecast_run", "telemetry_reading", "signal_binding_version", "alert_event", "alert_rule",
        "client_equipment_class_layout", "client_equipment_class", "equipment_profile",
        "equipment_class_sensor_requirement", "equipment_class_profile" CASCADE`);
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('genset', 1, 'published', 'Genset', ('[{"signal":"coolant_temp_c","unit":"degC","required":true},'
        || '{"signal":"oil_pressure_kpa","unit":"kPa","required":true},{"signal":"fuel_level","unit":"%","required":false}]')::jsonb)`);
    await owner.query(`INSERT INTO equipment_class_sensor_requirement
        (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled, forecast_horizon_hours, stale_after_seconds)
      VALUES ('genset', 1, 'coolant_temp_c', 'degC', true, 24, 3600), ('genset', 1, 'oil_pressure_kpa', 'kPa', true, 24, 3600),
             ('genset', 1, 'fuel_level', '%', false, NULL, 3600)`);
    for (const [tenant, ext, signals] of [['acme', 'G-1', ['coolant_temp_c', 'oil_pressure_kpa', 'fuel_level']], ['globex', 'G-2', ['coolant_temp_c']]] as const) {
      await runTenantSpanning(owner, 'fixture', async (m) => {
        await m.getRepository(ClientEquipmentClass).save({
          tenantId: tenant, slug: 'genset', name: 'Genset', description: null, category: null, expectedSignals: [],
          failureModes: [], defaultThresholds: {}, templateSlug: 'genset', templateVersion: 1, templateChecksum: 'c',
          copiedAt: NOW, status: 'active', updatedBy: 'u',
        });
        await m.getRepository(EquipmentProfile).save({
          tenantId: tenant, sourceSystem: SS, externalId: ext, equipmentClassSlug: 'genset', classVersion: 1, plantId: null,
          tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: ext,
        });
        await m.getRepository(ClientEquipmentClassLayout).save({
          tenantId: tenant, clientEquipmentClassSlug: 'genset', widgetType: 'forecast_chart' as never, widgetKey: 'coolant_forecast',
          boundTo: 'coolant_temp_c', title: null, position: 1, size: 'medium' as const, hidden: false, positionCustom: false,
          templateVersion: 1, copiedAt: NOW,
        });
      });
      for (const signal of signals) {
        const imei = `${ext === 'G-1' ? 'G1' : 'G2'}-${signal}`;
        await owner.query(`INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
            component_id, origin, imei, canonical_unit, valid_from, valid_to, is_primary, status)
          VALUES ($1, $2, $3, $4, $4, '', 'physical', $5, 'u', '2026-01-01', NULL, true, 'active')`, [tenant, SS, ext, signal, imei]);
        await readings(imei, signal, new Date(CONTEXT_FROM.getTime() - HOUR), new Date(NOW.getTime() + 26 * HOUR),
          signal === 'fuel_level' ? 555 : signal === 'oil_pressure_kpa' ? 400 : 80);
      }
    }
  }, 60_000);

  const runRow = async (id: string) => (await owner.query(`SELECT * FROM forecast_run WHERE id = $1`, [id]))[0];
  const latest = () => owner.query(`SELECT tenant_id, external_id, signal, generated_at, horizon FROM forecast_latest ORDER BY tenant_id, signal`);
  const sent = () => JSON.parse(readFileSync(RECORD, 'utf8'));
  const profile = async (tenant: string, ext: string) =>
    (await owner.getRepository(EquipmentProfile).findOneByOrFail({ tenantId: tenant, externalId: ext }));

  // -------------------------------------------------------------- the registry, refused

  it('1. a second active model is refused by the database', async () => {
    await expect(owner.query(`INSERT INTO forecast_model (key, revision, runtime, context_length, prediction_length,
        weights_sha256, license, status, approved_by, approved_at)
      VALUES ('other', 'r', 'pytorch-cpu', 512, 96, $1, 'x', 'active', 'x', now())`, ['b'.repeat(64)]))
      .rejects.toThrow(/uq_forecast_model_one_active/);
  });

  it('2. a model version cannot change, or come back from retirement, or be deleted', async () => {
    await expect(owner.query(`UPDATE forecast_model SET revision = 'other' WHERE id = $1`, [modelId])).rejects.toThrow(/immutable/);
    await expect(owner.query(`DELETE FROM forecast_model WHERE id = $1`, [modelId])).rejects.toThrow(/never deleted/);
    const qr = owner.createQueryRunner();
    await qr.startTransaction();
    try {
      await qr.query(`UPDATE forecast_model SET status = 'retired' WHERE id = $1`, [modelId]);
      await expect(qr.query(`UPDATE forecast_model SET status = 'active' WHERE id = $1`, [modelId])).rejects.toThrow(/active -> retired only/);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('the seeded model is the pinned revision, Apache-2.0, approved, with the weights QML1-SIZE measured', async () => {
    expect(await owner.getRepository(ForecastModel).findOneByOrFail({ id: modelId })).toMatchObject({
      key: 'granite-timeseries-ttm-r2', revision: 'd6a79570cac0f33d526601cd3a0fc7c80a8f9a2f', contextLength: 512,
      predictionLength: 96, license: 'apache-2.0', weightsSha256: 'a706726a7eb01bbcb42994b7dcb3c06ea9557898dbae8d480eb04fe8ccb89710',
    });
  });

  it('3 and 4. one latest row per (account, machine, signal), and only for a model that exists', async () => {
    await pass().runPass(NOW);
    await expect(owner.query(`INSERT INTO forecast_latest (tenant_id, source_system, external_id, signal, model_id, run_id,
        generated_at, step_seconds, context_from, context_to, input_coverage, imputed_steps, horizon)
      SELECT tenant_id, source_system, external_id, signal, model_id, run_id, generated_at, step_seconds, context_from,
             context_to, input_coverage, imputed_steps, horizon FROM forecast_latest LIMIT 1`)).rejects.toThrow(/uq_forecast_latest/);
    await expect(owner.query(`UPDATE forecast_latest SET model_id = gen_random_uuid()`)).rejects.toThrow(/foreign key/);
  });

  it('5. one account cannot read another\'s forecasts, residuals or skip records; the ledger holds counts, not machines', async () => {
    await owner.query(`DELETE FROM telemetry_reading WHERE imei = 'G1-oil_pressure_kpa' AND source_timestamp > $1`, [new Date(NOW.getTime() - HOUR)]);
    await pass().runPass(NOW);
    const asGlobex = (sql: string) => withTenantId(ds, 'globex', (m) => m.query(sql));
    expect((await asGlobex(`SELECT DISTINCT tenant_id FROM forecast_latest`)).map((r: { tenant_id: string }) => r.tenant_id)).toEqual(['globex']);
    expect(await asGlobex(`SELECT tenant_id, reason FROM forecast_run_skip`)).toEqual([{ tenant_id: 'globex', reason: 'unbound' }]);
    expect(await asGlobex(`SELECT * FROM forecast_residual WHERE tenant_id = 'acme'`)).toEqual([]);
    expect((await withTenantId(ds, 'acme', (m) => m.query(`SELECT tenant_id, reason FROM forecast_run_skip`))))
      .toEqual([{ tenant_id: 'acme', reason: 'stale' }]);
    const columns = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'forecast_run'`))
      .map((r: { column_name: string }) => r.column_name);
    expect(columns).not.toEqual(expect.arrayContaining(['tenant_id']));
    expect(columns).not.toEqual(expect.arrayContaining(['skipped_list']));
  });

  // -------------------------------------------------------------- the worker, refused

  it.each([
    ['mismatch', /is not granite-timeseries-ttm-r2@d6a79570/],
    ['weights', /worker loaded weights f{64}, the registry names a706726a/],
    ['malformed', /not JSON/],
    ['nan', /non-finite value/],
    ['short', /has 95 values/],
    ['crash', /worker exited 3: Segmentation fault in the stub/],
  ])('6–8. a worker answer that is %s fails the pass, writes nothing, and leaves the previous forecast alone', async (mode, error) => {
    await pass().runPass(NOW);
    const before = await latest();
    const s = await pass(mode).runPass(new Date(NOW.getTime() + 5 * HOUR));
    expect(s.outcome).toBe('failed');
    expect((await runRow(s.runId)).error).toMatch(error);
    expect(await latest()).toEqual(before);
    expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_residual`)).toEqual([{ n: 0 }]);
  });

  // -------------------------------------------------------------- what is forecast

  it('9. a signal the library does not declare is never sent to the worker', async () => {
    const s = await pass().runPass(NOW);
    expect(s).toMatchObject({ outcome: 'completed', considered: 4, forecast: 3, skipped: 1 });
    const req = sent();
    expect(req.series).toHaveLength(3);
    // Fuel's readings sit around 555; nothing near it was sent.
    expect(req.series.every((x: { values: number[] }) => x.values.every((v) => v < 500))).toBe(true);
    expect(req.series.every((x: { values: number[] }) => x.values.length === 512)).toBe(true);
    expect(req.series[0].start).toBe(CONTEXT_FROM.toISOString());
  });

  it('10. a stale signal is skipped and the ledger and skip list say so', async () => {
    await owner.query(`DELETE FROM telemetry_reading WHERE imei = 'G1-oil_pressure_kpa' AND source_timestamp > $1`, [new Date(NOW.getTime() - HOUR)]);
    const s = await pass().runPass(NOW);
    expect(s).toMatchObject({ forecast: 2, skipped: 2 });
    expect((await runRow(s.runId)).skipped).toBe(2);
    expect(await owner.query(`SELECT external_id, signal, reason FROM forecast_run_skip ORDER BY external_id`)).toEqual([
      { external_id: 'G-1', signal: 'oil_pressure_kpa', reason: 'stale' },
      { external_id: 'G-2', signal: 'oil_pressure_kpa', reason: 'unbound' },
    ]);
  });

  it('11. a forecast younger than the cadence is not made again', async () => {
    await pass().runPass(NOW);
    rmSync(RECORD, { force: true });
    const s = await pass().runPass(new Date(NOW.getTime() + HOUR));
    expect(s).toMatchObject({ outcome: 'completed', considered: 4, forecast: 0 });
    expect(() => readFileSync(RECORD)).toThrow();
  });

  it('12. an alert on a signal re-forecasts it on the next pass, despite the cadence', async () => {
    await pass().runPass(NOW);
    const [rule] = await owner.query(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, source_system, external_id)
      VALUES ('acme', 'hot', 'Hot', 'signal-threshold', '{"signal":"coolant_temp_c","max":90}'::jsonb, 'equipment', $1, 'G-1') RETURNING id`, [SS]);
    await owner.query(`INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
      VALUES ('acme', $1, 'Hot', $2, 'G-1', 'high', 'hot', '{}'::jsonb, 'open', $3)`, [rule.id, SS, new Date(NOW.getTime() + 30 * 60_000)]);
    const s = await pass().runPass(new Date(NOW.getTime() + HOUR));
    expect(s.forecast).toBe(1);
    expect((await latest()).filter((r: { generated_at: Date }) => r.generated_at.getTime() === NOW.getTime() + HOUR)
      .map((r: { signal: string; external_id: string }) => `${r.external_id}/${r.signal}`)).toEqual(['G-1/coolant_temp_c']);
  });

  it('13. out of budget: alerted signals first, the rest recorded as budget_exhausted', async () => {
    const [rule] = await owner.query(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to)
      VALUES ('acme', 'hot', 'Hot', 'signal-threshold', '{"signal":"oil_pressure_kpa","max":900}'::jsonb, 'account') RETURNING id`);
    await owner.query(`INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
      VALUES ('acme', $1, 'Hot', $2, 'G-1', 'high', 'hot', '{}'::jsonb, 'open', $3)`, [rule.id, SS, new Date(NOW.getTime() - HOUR)]);
    let t = 0;
    const s = await pass().runPass(NOW, { budgetMs: 1, clock: () => (t += 1) });
    expect(s).toMatchObject({ outcome: 'budget_exhausted', forecast: 1, skipped: 3 });
    expect((await latest()).map((r: { signal: string }) => r.signal)).toEqual(['oil_pressure_kpa']);
    expect((await owner.query(`SELECT reason FROM forecast_run_skip`)).map((r: { reason: string }) => r.reason))
      .toEqual(['budget_exhausted', 'budget_exhausted', 'budget_exhausted']);
  });

  it('14. residuals are recorded from the previous forecast before it is replaced', async () => {
    await pass().runPass(NOW);
    const [old] = await owner.query(`SELECT horizon FROM forecast_latest WHERE tenant_id = 'acme' AND signal = 'coolant_temp_c'`);
    await pass().runPass(new Date(NOW.getTime() + 5 * HOUR));
    const rows = await owner.query(`SELECT step_at, lead_steps, predicted, actual, residual FROM forecast_residual
      WHERE tenant_id = 'acme' AND signal = 'coolant_temp_c' ORDER BY step_at`);
    expect(rows.map((r: { lead_steps: number }) => r.lead_steps)).toEqual([1, 2, 3, 4, 5]);
    rows.forEach((r: { step_at: Date; predicted: number; actual: number; residual: number }, i: number) => {
      expect(r.step_at.toISOString()).toBe(old.horizon[i].t);
      expect(r.predicted).toBeCloseTo(old.horizon[i].v, 9);
      expect(r.residual).toBeCloseTo(r.actual - r.predicted, 9);
    });
  });

  // -------------------------------------------------------------- the band (D20)

  const seedResiduals = async (days: number, opts: { newest?: number } = {}) => {
    const [run] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES ($1, $1, 3600, $2, 'completed') RETURNING id`, [NOW, modelId]);
    const values: unknown[] = [];
    const rows: string[] = [];
    // Each day's residuals inside one UTC date, so "days" counts what it says.
    const midnight = Date.UTC(2026, 9, 19);
    for (let d = days; d >= 1; d--) {
      for (let h = 0; h < 6; h++) {
        const at = new Date(midnight - d * DAY + h * 3 * HOUR);
        const residual = ((d * 7 + h * 3) % 11) / 10 - 0.5; // −0.5 … +0.5
        const i = values.length;
        rows.push(`('acme', '${SS}', 'G-1', 'coolant_temp_c', $${i + 1}, $${i + 2}, $${i + 3}, 1, 80, $${i + 4}, $${i + 5}, true)`);
        values.push(modelId, run.id, at, 80 + residual, residual);
      }
    }
    await owner.query(`INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
      lead_steps, predicted, actual, residual, operating) VALUES ${rows.join(', ')}`, values);
    if (opts.newest !== undefined) {
      await owner.query(`INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
        lead_steps, predicted, actual, residual, operating) VALUES ('acme', $1, 'G-1', 'coolant_temp_c', $2, $3, $4, 1, 80, $5, $6, true)`,
      [SS, modelId, run.id, new Date(HOUR_END.getTime() - HOUR), 80 + opts.newest, opts.newest]);
    }
  };
  const anomaly = async () => withTenantId(ds, 'acme', async (m) =>
    reader.anomaly(m, 'acme', await profile('acme', 'G-1'), 'coolant_temp_c', modelId, NOW));

  it('15. thirteen days of clean residuals is not a band: baseline_not_established, never normal', async () => {
    await seedResiduals(BASELINE_DAYS - 1, { newest: 0 });
    expect(await anomaly()).toMatchObject({ state: 'baseline_not_established', band: null, residual: 0 });
  });

  it('16. twenty days with an alert across seven of them is still not a band: the dirty days are excluded', async () => {
    await seedResiduals(20, { newest: 0 });
    const [rule] = await owner.query(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, source_system, external_id)
      VALUES ('acme', 'hot', 'Hot', 'signal-threshold', '{"signal":"coolant_temp_c","max":90}'::jsonb, 'equipment', $1, 'G-1') RETURNING id`, [SS]);
    await owner.query(`INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at, resolved_at, resolution_note)
      VALUES ('acme', $1, 'Hot', $2, 'G-1', 'high', 'hot', '{}'::jsonb, 'resolved', $3, $4, 'Thermostat replaced')`,
    [rule.id, SS, new Date(Date.UTC(2026, 9, 2)), new Date(Date.UTC(2026, 9, 9))]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM forecast_residual`))[0].n).toBe(20 * 6 + 1);
    expect(await anomaly()).toMatchObject({ state: 'baseline_not_established', baselineReason: 'baseline_not_established' });
  });

  it('17. an established band and a residual outside it: anomalous, with actual, predicted and band', async () => {
    await seedResiduals(20, { newest: 5 });
    const a = await anomaly();
    expect(a).toMatchObject({ state: 'anomalous', actual: 85, predicted: 80, residual: 5 });
    expect(a.band!.lo).toBeLessThan(0);
    expect(a.band!.hi).toBeGreaterThan(0);
    expect(a.band!.hi).toBeLessThanOrEqual(0.5);
    await owner.query(`UPDATE forecast_residual SET actual = 80.1, residual = 0.1 WHERE step_at = $1`, [new Date(HOUR_END.getTime() - HOUR)]);
    expect((await anomaly()).state).toBe('normal');
  });

  // -------------------------------------------------------------- the chart

  const widget = async (at = NOW) =>
    (await pages.machinePage(acme, { sourceSystem: SS, externalId: 'G-1' }, at)).widgets.find((w) => w.widgetKey === 'coolant_forecast')!;

  it('18. the chart: no forecast yet, then no band yet, then ready with intervals; stale input blocks it; page and reader agree', async () => {
    expect(await widget()).toMatchObject({ readiness: 'not_available', reason: 'no_forecast_model' });

    await pass().runPass(NOW);
    expect(await widget()).toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established', data: null });

    await owner.query(`DELETE FROM forecast_latest`);
    await seedResiduals(20, { newest: 0.1 });
    await pass().runPass(NOW);
    const w = await widget();
    expect(w.readiness).toBe('ready');
    const data = w.data as { horizon: { t: string; v: number; lo: number; hi: number }[]; anomaly: { state: string }; model: { key: string } };
    expect(data.horizon).toHaveLength(24);
    expect(data.horizon[0].t).toBe(HOUR_END.toISOString());
    expect(data.horizon.every((p) => p.lo < p.v && p.v < p.hi)).toBe(true);
    expect(data.anomaly.state).toBe('normal');
    expect(data.model.key).toBe('granite-timeseries-ttm-r2');
    const direct = await withTenantId(ds, 'acme', async (m) => reader.chart(m, 'acme', await profile('acme', 'G-1'), 'coolant_temp_c', NOW));
    expect(direct).toEqual({ readiness: 'ready', data: w.data });

    await owner.query(`DELETE FROM telemetry_reading WHERE imei = 'G1-coolant_temp_c' AND source_timestamp > $1`, [new Date(NOW.getTime() - HOUR)]);
    expect(await widget()).toMatchObject({ readiness: 'blocked', reason: 'stale', data: null });
  });

  it('a forecast the pass has missed past the cadence plus a tick is stale on the chart', async () => {
    await seedResiduals(20, { newest: 0.1 });
    await pass().runPass(NOW);
    expect((await widget(new Date(NOW.getTime() + 4 * HOUR + 4 * 60_000))).readiness).toBe('ready');
    expect(await widget(new Date(NOW.getTime() + 4 * HOUR + 6 * 60_000))).toMatchObject({ readiness: 'blocked', reason: 'stale' });
  });

  it('19. one daily sample per (machine, signal) per UTC day, across passes', async () => {
    await pass().runPass(NOW);
    await pass().runPass(new Date(NOW.getTime() + 5 * HOUR));
    expect((await owner.query(`SELECT count(*)::int AS n FROM forecast_daily_sample`))[0].n).toBe(3);
    await pass().runPass(new Date(NOW.getTime() + 24 * HOUR));
    expect(await owner.query(`SELECT day::text, count(*)::int AS n FROM forecast_daily_sample GROUP BY day ORDER BY day`))
      .toEqual([{ day: '2026-10-19', n: 3 }, { day: '2026-10-20', n: 3 }]);
    const [sample] = await owner.query(`SELECT horizon FROM forecast_daily_sample LIMIT 1`);
    expect(sample.horizon).toHaveLength(96);
  });

  // -------------------------------------------------------------- concurrency (idempotent pass)

  it('20. two passes at once both settle: one runs, one records lock_held, nothing is doubled', async () => {
    await pass().runPass(NOW);
    const later = new Date(NOW.getTime() + 5 * HOUR);
    const results = await Promise.allSettled([pass().runPass(later), pass().runPass(later)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome).sort();
    expect(outcomes).toEqual(['completed', 'lock_held']);
    expect((await owner.query(`SELECT count(*)::int AS n FROM forecast_latest`))[0].n).toBe(3);
    expect(await owner.query(`SELECT count(*)::int AS n, count(DISTINCT (tenant_id, external_id, signal, step_at))::int AS d FROM forecast_residual`))
      .toEqual([{ n: 15, d: 15 }]);
  });

  it('21. the lock held elsewhere: the pass records lock_held and writes nothing', async () => {
    const held = await tryTakePassLock(owner, FORECAST_PASS_LOCK_KEY);
    try {
      const s = await pass().runPass(NOW);
      expect(s.outcome).toBe('lock_held');
      expect(await runRow(s.runId)).toMatchObject({ outcome: 'lock_held', model_id: null });
      expect(await owner.query(`SELECT count(*)::int AS n FROM forecast_latest`)).toEqual([{ n: 0 }]);
    } finally {
      await held!.release();
    }
  });

  // -------------------------------------------------------------- down path

  it(`22. ${MIGRATION} down removes its tables and nothing it did not add; up runs again`, async () => {
    await owner.query(`DELETE FROM telemetry_reading WHERE imei = 'G1-oil_pressure_kpa' AND source_timestamp > $1`, [new Date(NOW.getTime() - HOUR)]);
    await pass().runPass(NOW);
    await seedResiduals(1);
    for (const t of ['forecast_model', 'forecast_run', 'forecast_run_skip', 'forecast_input_bucket', 'forecast_latest', 'forecast_residual', 'forecast_daily_sample']) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM "${t}"`))[0].n).toBeGreaterThan(0);
    }
    await undoMigrationNamed(owner, MIGRATION);
    const left = await owner.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'forecast%'`);
    expect(left).toEqual([]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM equipment_class_sensor_requirement WHERE forecast_enabled`))[0].n).toBe(2);
    expect(await owner.query(`SELECT to_regclass('client_equipment_class_layout')::text AS t`)).toEqual([{ t: 'client_equipment_class_layout' }]);
    await owner.runMigrations({ transaction: 'all' });
    expect((await owner.query(`SELECT count(*)::int AS n FROM forecast_model WHERE status = 'active'`))[0].n).toBe(1);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  });
});

describe('forecast input and band, the arithmetic', () => {
  const step = HOUR;
  const at = (i: number) => i * step;
  const buckets = (present: number[], value = (i: number) => i) => new Map(present.map((i) => [at(i), value(i)]));

  it('reuses the KPI coverage floor rather than restating it', () => {
    expect(MIN_INPUT_COVERAGE).toBe(MIN_COVERAGE_RATIO);
  });

  it('refuses input below the coverage floor, and a gap at either end; fills interior gaps on a straight line and counts them', () => {
    expect(buildContext(buckets([0, 9]), 0, 10, step)).toMatchObject({ ok: false, reason: 'insufficient_coverage' });
    expect(buildContext(buckets([1, 2, 3, 4, 5, 6, 7, 8, 9]), 0, 10, step)).toMatchObject({ ok: false, reason: 'gap_at_edge' });
    expect(buildContext(buckets([0, 1, 2, 3, 4, 5, 6, 7, 8]), 0, 10, step)).toMatchObject({ ok: false, reason: 'gap_at_edge' });
    const ok = buildContext(buckets([0, 1, 4, 5, 6, 9], (i) => i * 10), 0, 10, step);
    expect(ok).toEqual({ ok: true, values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], coverage: 0.6, imputed: 4 });
  });

  it('quantiles interpolate between ranks; the band is the 2.5th–97.5th percentile', () => {
    expect(BAND_QUANTILES).toEqual({ lo: 0.025, hi: 0.975 });
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });

  it('a machine with no shift schedule never learns a band, and says why', () => {
    const r = Array.from({ length: 40 }, (_, i) => ({ stepAt: new Date(at(i * 24)), lead: 1, residual: 0, operating: null }));
    expect(learnBand(r, [])).toMatchObject({ established: false, reason: 'no_shift_schedule' });
  });

  it('parked hours do not count towards the fourteen days', () => {
    const r = Array.from({ length: 20 }, (_, d) => ({ stepAt: new Date(at(d * 24)), lead: 1, residual: 0, operating: d < 13 }));
    expect(learnBand(r, [])).toMatchObject({ established: false, reason: 'baseline_not_established', cleanDays: 13 });
  });
});
