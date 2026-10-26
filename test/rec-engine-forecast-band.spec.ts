import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { ForecastModel } from '../src/forecast/forecast.entities';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { ENGINE_VERSION, RecEngineService } from '../src/rec-engine/rec-engine.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIDNIGHT = Date.UTC(2026, 9, 19);
const NOW = new Date(MIDNIGHT + 11 * HOUR + 20 * 60_000);
const SS = 'iot-platform-1';
const SIGNALS = ['coolant_temp', 'oil_pressure'];
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

interface Source { kind: string; readiness?: string; reason?: string; state?: string; at?: string; residual?: number }
interface Bundle {
  outcome: string | null; engineVersion: string;
  detect: { entries: { signal: string; state: string; sources: Source[] }[]; coverage: { sources: { residual: string } } };
  attribute: { modes: { failureModeCode: string; status: string; matchedSignals: string[] }[] };
  candidates: { failureModeCode: string; action: string }[];
}

/**
 * A fault the forecast band sees before any threshold does (D20, D21: Detect is thresholds
 * and TTM residual). Coolant is forecast-declared; twenty days of steady running residuals
 * of about ±0.5 give it a band; no alert is open. What changes between tests is the newest
 * hours of residuals, and what is asserted is what Detect, Attribute and the page's
 * failure-mode widget make of them — which must be the same thing.
 */
describeDb('rec engine: a forecast band breach is a fault, as an open alert is', () => {
  let owner: DataSource;
  let app: INestApplication;
  let engine: RecEngineService;
  let pages: PageService;
  let modelId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-rec-band';
    process.env.AUTH_JWT_ISSUER = 'things-alive-rec-band-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    engine = app.get(RecEngineService);
    pages = app.get(PageService);
    modelId = (await owner.getRepository(ForecastModel).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "rec_evidence_bundle", "telemetry_reading", "signal_binding_version", "forecast_run",
        "client_equipment_class_layout", "client_equipment_class_recommendation", "client_equipment_class_failure_mode",
        "client_equipment_class", "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile"
      RESTART IDENTITY CASCADE`);
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('dg', 1, 'published', 'dg', $1::jsonb)`, [JSON.stringify(SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })))]);
    await owner.query(`INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled, forecast_horizon_hours)
      VALUES ('dg', 1, 'coolant_temp', 'u', true, 24), ('dg', 1, 'oil_pressure', 'u', false, NULL)`);
    await fixture(async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'dg', name: 'dg', description: null, category: null,
        expectedSignals: SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })),
        failureModes: [], defaultThresholds: {}, templateSlug: 'dg', templateVersion: 1, templateChecksum: 'c',
        copiedAt: NOW, status: 'active', updatedBy: 'u',
      });
      await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: SS, externalId: 'DG-1', equipmentClassSlug: 'dg', classVersion: 1,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: 'DG-1',
      });
      await m.getRepository(ClientEquipmentClassFailureMode).save([
        { tenantId: 'acme', clientEquipmentClassSlug: 'dg', code: 'overheat', name: 'Overheat', symptom: '', severity: Severity.High, signals: ['coolant_temp'], templateVersion: 1, copiedAt: NOW },
        { tenantId: 'acme', clientEquipmentClassSlug: 'dg', code: 'low_oil', name: 'Low oil', symptom: '', severity: Severity.Critical, signals: ['oil_pressure'], templateVersion: 1, copiedAt: NOW },
      ]);
      await m.getRepository(ClientEquipmentClassRecommendation).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'dg', failureModeCode: 'overheat', action: 'Inspect radiator',
        urgency: 'next_shift' as never, estimatedHours: 2, requiredParts: [], templateVersion: 1, copiedAt: NOW,
      });
      await m.getRepository(ClientEquipmentClassLayout).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'dg', widgetType: 'failure_modes' as never, widgetKey: 'failure_modes',
        boundTo: null, title: null, position: 1, size: 'medium' as const, hidden: false, positionCustom: false,
        templateVersion: 1, copiedAt: NOW,
      });
    });
    for (const s of SIGNALS) {
      await owner.query(`INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
          component_id, origin, imei, canonical_unit, valid_from, valid_to, is_primary, status, expected_period_seconds)
        VALUES ('acme', $1, 'DG-1', $2, $2, '', 'physical', 'imei-1', 'u', '2026-01-01T00:00:00Z', NULL, true, 'active', 60)`, [SS, s]);
      await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
        VALUES ('acme', 'imei-1', $1, 50, 'u', $2, $2, 'live')`, [s, new Date(NOW.getTime() - 3 * 60_000)]);
    }
  });

  /** Twenty working days of residuals (08 first hour +18, 09–16 steady ±0.5), then today's hours given. */
  const residuals = async (today: [number, number, boolean][], opts: { forecast?: boolean } = { forecast: true }) => {
    const [run] = await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES ($1, $1, 3600, $2, 'completed') RETURNING id`, [NOW, modelId]);
    const rows: [Date, number, boolean][] = [];
    for (let d = 20; d >= 1; d--) {
      for (let h = 7; h <= 17; h++) {
        const on = h >= 8 && h < 17;
        rows.push([new Date(MIDNIGHT - d * DAY + h * HOUR), !on ? 0 : h === 8 ? 18 : ((d * 7 + h * 3) % 11) / 10 - 0.5, on]);
      }
    }
    for (const [h, r, on] of today) rows.push([new Date(MIDNIGHT + h * HOUR), r, on]);
    await owner.query(`INSERT INTO forecast_residual (tenant_id, source_system, external_id, signal, model_id, run_id, step_at,
        lead_steps, predicted, actual, residual, operating)
      SELECT 'acme', $1, 'DG-1', 'coolant_temp', $2, $3, t, 1, 80, 80 + r, r, o
        FROM unnest($4::timestamptz[], $5::double precision[], $6::boolean[]) AS p(t, r, o)`,
    [SS, modelId, run.id, rows.map((x) => x[0].toISOString()), rows.map((x) => x[1]), rows.map((x) => x[2])]);
    if (opts.forecast) {
      await owner.query(`INSERT INTO forecast_latest (tenant_id, source_system, external_id, signal, model_id, run_id, generated_at,
          step_seconds, context_from, context_to, input_coverage, imputed_steps, horizon)
        VALUES ('acme', $1, 'DG-1', 'coolant_temp', $2, $3, $4, 3600, $4::timestamptz - interval '512 hours', $4, 1, 0,
                '[{"t":"2026-10-19T12:00:00.000Z","v":80,"lo":null,"hi":null}]'::jsonb)`, [SS, modelId, run.id, NOW]);
    }
  };

  const ref = { sourceSystem: SS, externalId: 'DG-1' };
  const run = async () => (await engine.evaluate(acme, ref, NOW)).bundle as unknown as Bundle;
  const coolant = (b: Bundle) => b.detect.entries.find((e) => e.signal === 'coolant_temp')!;
  const residualSource = (b: Bundle) => coolant(b).sources.find((s) => s.kind === 'residual')!;
  const widgetStatus = async () => {
    const w = (await pages.machinePage(acme, ref, NOW)).widgets.find((x) => x.widgetKey === 'failure_modes')!;
    return Object.fromEntries((w.data as { code: string; status: string }[]).map((r) => [r.code, r.status]));
  };

  it('1. a steady hour past the band, no alert open: coolant anomalous, overheat active, its action listed — and the page agrees', async () => {
    await residuals([[7, 0, false], [8, 18, true], [9, 0.2, true], [10, 6, true]]);
    const b = await run();
    expect(b.engineVersion).toBe(ENGINE_VERSION);
    expect(coolant(b).state).toBe('anomalous');
    expect(residualSource(b)).toMatchObject({ readiness: 'ready', state: 'anomalous', at: new Date(MIDNIGHT + 10 * HOUR).toISOString(), residual: 6 });
    expect(b.detect.coverage.sources.residual).toBe('available');
    expect(b.attribute.modes.find((x) => x.failureModeCode === 'overheat')).toMatchObject({ status: 'active', matchedSignals: ['coolant_temp'] });
    expect(b.outcome).toBe('attributed');
    expect(b.candidates.map((c) => c.action)).toEqual(['Inspect radiator']);
    expect(await widgetStatus()).toEqual({ overheat: 'active', low_oil: 'clear' });
  });

  it('2. this morning\'s first hour at +18, like every morning, is not a fault: nothing detected, and the page agrees', async () => {
    await residuals([[7, 0, false], [8, 18, true]]);
    const b = await run();
    expect(coolant(b).state).toBe('normal');
    expect(residualSource(b)).toMatchObject({ readiness: 'ready', state: 'normal' });
    expect(b.outcome).toBe('nothing_detected');
    expect(await widgetStatus()).toEqual({ overheat: 'clear', low_oil: 'clear' });
  });

  it('3. a stale sensor is not observed, whatever its last band verdict said', async () => {
    await residuals([[7, 0, false], [8, 18, true], [9, 0.2, true], [10, 6, true]]);
    await owner.query(`UPDATE telemetry_reading SET source_timestamp = source_timestamp - interval '3 hours' WHERE signal = 'coolant_temp'`);
    const b = await run();
    expect(coolant(b).state).toBe('not_observed');
    expect(b.outcome).not.toBe('attributed');
  });

  it('4. no forecast yet: the residual source says so, exactly as before, and nothing is attributed', async () => {
    await residuals([[9, 6, true]], { forecast: false });
    const b = await run();
    expect(residualSource(b)).toEqual({ kind: 'residual', readiness: 'not_available', reason: 'no_forecast_model' });
    expect(b.detect.coverage.sources.residual).toBe('not_available');
    expect(coolant(b).state).toBe('normal');
  });

  it('5. a band not yet established is not_available with its reason, never normal-by-band', async () => {
    await owner.query(`INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
      VALUES ($1, $1, 3600, $2, 'completed')`, [NOW, modelId]);
    const [r] = await owner.query(`SELECT id FROM forecast_run LIMIT 1`);
    await owner.query(`INSERT INTO forecast_latest (tenant_id, source_system, external_id, signal, model_id, run_id, generated_at,
        step_seconds, context_from, context_to, input_coverage, imputed_steps, horizon)
      VALUES ('acme', $1, 'DG-1', 'coolant_temp', $2, $3, $4, 3600, $4::timestamptz - interval '512 hours', $4, 1, 0,
              '[{"t":"2026-10-19T12:00:00.000Z","v":80,"lo":null,"hi":null}]'::jsonb)`, [SS, modelId, r.id, NOW]);
    const b = await run();
    expect(residualSource(b)).toEqual({ kind: 'residual', readiness: 'not_available', reason: 'baseline_not_established' });
  });

  it('6. a replay of an earlier moment does not see the fault that came after it', async () => {
    await residuals([[7, 0, false], [8, 18, true], [9, 0.2, true], [10, 6, true]]);
    const earlier = new Date(MIDNIGHT + 9 * HOUR + 30 * 60_000);
    const profile = await owner.getRepository(EquipmentProfile).findOneByOrFail({ externalId: 'DG-1' });
    const b = await runTenantSpanning(owner, 'replay', (m) => engine.computeAsOf(m, 'acme', profile, earlier)) as unknown as Bundle;
    expect(b.detect.entries.find((e) => e.signal === 'coolant_temp')!.sources.find((s) => s.kind === 'residual'))
      .toMatchObject({ state: 'normal', at: new Date(MIDNIGHT + 9 * HOUR).toISOString() });
  });
});
