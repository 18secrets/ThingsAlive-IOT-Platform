import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { ForecastApiService } from '../src/forecast/forecast-api.service';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ForecastService } from '../src/forecast/forecast.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-19T10:20:00.000Z');
const HOUR_END = new Date('2026-10-19T10:00:00.000Z');
const CONTEXT_FROM = new Date(HOUR_END.getTime() - 512 * HOUR);
const SS = 'ta-2.0';
const STUB = join(__dirname, 'forecast', 'stub-worker.js');
const RECORD = join(tmpdir(), `forecast-api-stub-${process.pid}.json`);
const SECRET = 'test-secret-forecast-api';
const ISSUER = 'things-alive-forecast-api-test';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const narrow: RequestScope = { ...acme, userId: 'u-narrow', equipmentIds: ['OTHER'] };
const G1 = { sourceSystem: SS, externalId: 'G-1' };

/**
 * The forecast routes. They add no forecasting of their own — QML1's reader answers —
 * so what is tested here is what the routes decide: which signals a machine is asked
 * about, that the answer is the page's answer, who may ask, and that asking never makes
 * a forecast. The fixture is `forecasting.spec.ts`'s, cut to what these questions need.
 */
describeDb('forecast routes: every declared signal, the page\'s answer, scoped', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let api: ForecastApiService;
  let pages: PageService;
  let modelId: string;

  const pass = () => new ForecastService(ds, app.get(KpiEvaluatorService), app.get(ForecastReader), {
    command: process.execPath, args: [STUB], env: { STUB_MODE: 'ok', STUB_RECORD: RECORD },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    api = app.get(ForecastApiService);
    pages = app.get(PageService);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { rmSync(RECORD, { force: true }); await app?.close(); await owner?.destroy(); });

  /**
   * acme G-1: coolant and oil declared, fuel not; all three bound and reading. globex G-2:
   * the same class with only coolant bound. The page lays out a chart for coolant only, so
   * oil is the signal the page cannot show and the route must.
   */
  beforeEach(async () => {
    rmSync(RECORD, { force: true });
    await owner.query(`
      TRUNCATE TABLE "forecast_run", "telemetry_reading", "signal_binding_version",
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
        await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
          SELECT $1, $2, $3, $4 + 2 * sin(extract(epoch FROM ts) / 3600 * 2 * pi() / 24), 'u', ts, ts, 'live'
            FROM generate_series($5::timestamptz, $6::timestamptz, interval '30 minutes') ts`,
        [tenant, imei, signal, signal === 'oil_pressure_kpa' ? 400 : 80,
          new Date(CONTEXT_FROM.getTime() - HOUR), new Date(NOW.getTime() + 26 * HOUR)]);
      }
    }
  }, 60_000);

  /** Twenty clean days of coolant residuals on G-1, so its band is established; oil gets none. */
  const coolantBand = async () => {
    const [run] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES ($1, $1, 3600, $2, 'completed') RETURNING id`, [NOW, modelId]);
    const midnight = Date.UTC(2026, 9, 19);
    for (let d = 20; d >= 1; d--) {
      for (let h = 0; h < 6; h++) {
        const residual = ((d * 7 + h * 3) % 11) / 10 - 0.5;
        await owner.query(`INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
          lead_steps, predicted, actual, residual, operating) VALUES ('acme', $1, 'G-1', 'coolant_temp_c', $2, $3, $4, 1, 80, $5, $6, true)`,
        [SS, modelId, run.id, new Date(midnight - d * DAY + h * 3 * HOUR), 80 + residual, residual]);
      }
    }
  };

  const count = async (table: string) => (await owner.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  it('1. a machine is asked about every signal its class declares, in name order, and nothing undeclared', async () => {
    const all = await api.machine(acme, G1, NOW);
    expect(all.equipment).toEqual(G1);
    expect(all.asOf).toBe(NOW.toISOString());
    expect(all.forecasts.map((f) => f.signal)).toEqual(['coolant_temp_c', 'oil_pressure_kpa']);
  });

  it('2. reading never makes a forecast: before any pass every signal is no_forecast_model and nothing is written', async () => {
    const all = await api.machine(acme, G1, NOW);
    expect(all.forecasts).toEqual([
      { signal: 'coolant_temp_c', readiness: 'not_available', reason: 'no_forecast_model', data: null },
      { signal: 'oil_pressure_kpa', readiness: 'not_available', reason: 'no_forecast_model', data: null },
    ]);
    expect(await count('forecast_latest')).toBe(0);
    expect(await count('forecast_run')).toBe(0);
  });

  it('3. after a pass: coolant ready with intervals and the same data as the page widget; oil, with no band, says so', async () => {
    await coolantBand();
    await pass().runPass(NOW);
    const [coolant, oil] = (await api.machine(acme, G1, NOW)).forecasts;
    expect(coolant.readiness).toBe('ready');
    expect(coolant.data!.horizon).toHaveLength(24);
    expect(coolant.data!.horizon.every((p) => p.lo !== null && p.lo < p.v && p.v < p.hi!)).toBe(true);
    const widget = (await pages.machinePage(acme, G1, NOW)).widgets.find((w) => w.widgetKey === 'coolant_forecast')!;
    expect(coolant.data).toEqual(widget.data);
    // The page has no chart for oil; the route still answers for it.
    expect(oil).toEqual({ signal: 'oil_pressure_kpa', readiness: 'not_available', reason: 'baseline_not_established', data: null });
    expect(await api.signal(acme, G1, 'coolant_temp_c', NOW)).toEqual(coolant);
  });

  it('4. a signal the class does not declare, or that does not exist, is not_configured rather than a 404', async () => {
    for (const signal of ['fuel_level', 'no_such_signal']) {
      expect(await api.signal(acme, G1, signal, NOW))
        .toEqual({ signal, readiness: 'not_configured', reason: 'forecast_not_declared', data: null });
    }
  });

  // The reader asks "is there a forecast" before "is the sensor bound", so a sensor never
  // bound reads no_forecast_model; unbound is a forecast whose sensor has since gone.
  it('5. a forecast whose sensor is unbound after the pass is not_configured: unbound, not the stale forecast', async () => {
    await pass().runPass(NOW);
    await owner.query(`DELETE FROM signal_binding_version WHERE tenant_id = 'acme' AND signal_key = 'oil_pressure_kpa'`);
    expect(await api.signal(acme, G1, 'oil_pressure_kpa', NOW))
      .toEqual({ signal: 'oil_pressure_kpa', readiness: 'not_configured', reason: 'unbound', data: null });
  });

  it('6. another account\'s machine, a machine outside the caller\'s scope, and no machine at all are the same 404', async () => {
    const g2 = { sourceSystem: SS, externalId: 'G-2' };
    await expect(api.machine(acme, g2, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(api.signal(acme, g2, 'coolant_temp_c', NOW)).rejects.toMatchObject({ status: 404 });
    await expect(api.machine(narrow, G1, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(api.signal(narrow, G1, 'coolant_temp_c', NOW)).rejects.toMatchObject({ status: 404 });
    await expect(api.machine(acme, { sourceSystem: SS, externalId: 'NOPE' }, NOW)).rejects.toMatchObject({ status: 404 });
  });

  describe('over HTTP', () => {
    const auth = async (roles: string[]) => `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000f1', client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER })}`;
    const base = `/api/v1/equipment/${SS}/G-1/forecasts`;

    it('7. both routes answer 200 in the documented shape for a role holding prediction.read', async () => {
      const all = await request(app.getHttpServer()).get(base).set('Authorization', await auth(['operational']));
      expect(all.status).toBe(200);
      expect(all.body.forecasts.map((f: { signal: string }) => f.signal)).toEqual(['coolant_temp_c', 'oil_pressure_kpa']);
      const one = await request(app.getHttpServer()).get(`${base}/coolant_temp_c`).set('Authorization', await auth(['operational']));
      expect(one.status).toBe(200);
      expect(Object.keys(one.body).sort()).toEqual(['data', 'readiness', 'reason', 'signal']);
    });

    it('8. a role without prediction.read is refused, and no token is refused before that', async () => {
      expect((await request(app.getHttpServer()).get(base).set('Authorization', await auth(['viewer']))).status).toBe(403);
      expect((await request(app.getHttpServer()).get(`${base}/coolant_temp_c`).set('Authorization', await auth(['viewer']))).status).toBe(403);
      expect((await request(app.getHttpServer()).get(base)).status).toBe(401);
    });

    it('9. a machine the account does not hold is 404 over HTTP', async () => {
      expect((await request(app.getHttpServer()).get(`/api/v1/equipment/${SS}/G-2/forecasts`)
        .set('Authorization', await auth(['admin']))).status).toBe(404);
    });
  });
});
