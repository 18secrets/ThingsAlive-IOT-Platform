import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassLayout } from '../src/client-catalog/entities/client-equipment-class-layout.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const HOUR = 3_600_000;
const SECRET = 'test-secret-rec-engine';
const ISSUER = 'things-alive-rec-engine-test';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const SS = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
const narrow: RequestScope = { ...acme, userId: 'u-narrow', equipmentIds: ['OTHER'] };

const SIGNALS = ['coolant_temp', 'oil_pressure', 'fuel_level', 'vibration'];

/** What each step returned, typed only as far as the assertions need. */
interface Bundle {
  id: string; status: string; reason: string | null; outcome: string | null; incidentId: string | null;
  detect: { entries: { signal: string; state: string; reason: string | null; sources: { kind: string; ref?: string; reason?: string }[] }[];
    coverage: { expected: string[]; observed: string[]; notObserved: { signal: string; reason: string }[] } };
  attribute: { modes: { failureModeCode: string; status: string; matchedSignals: string[]; orphaned: boolean }[];
    unattributed: { signal: string }[] };
  precedent: { modes: { failureModeCode: string; state: string; workOrders: { id: string; observedHours: number | null }[] }[];
    coverage: { sources: Record<string, { rows: number }> } };
  gap: { noLibraryRecommendation: string[]; unobserved: { failureModeCode: string; signals: string[] }[] };
  cost: { lines: { recommendationId: string; line: string; result: Record<string, unknown> }[]; missingParameters: string[] };
  candidates: { recommendationId: string; failureModeCode: string; estimatedHours: number | null; inHand: boolean; inHandWorkOrderIds: string[] }[];
}

/**
 * The five deterministic recommendation steps (task QREC1, D21). Everything the engine
 * reads is real — bindings, readings, alerts, work orders, parameters, the tenant's
 * library copy — because what is being tested is what each step says it saw, and most
 * of all what it says when it could not see.
 */
describeDb('rec engine: detect, attribute, precedent, gap, cost', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let engine: RecEngineService;
  let pages: PageService;

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
    engine = app.get(RecEngineService);
    pages = app.get(PageService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "rec_evidence_bundle", "telemetry_reading", "signal_binding_version", "alert_event", "alert_rule",
        "work_order", "equipment_service_record", "tenant_parameter", "incident", "client_equipment_class_layout",
        "client_equipment_class_recommendation", "client_equipment_class_failure_mode", "client_equipment_class",
        "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile", "plant"
      RESTART IDENTITY CASCADE`);
  });

  // ============================================================== fixtures
  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  const seedClass = async (tenant = 'acme', slug = 'dg', opts: { forecast?: string[] } = {}) => {
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ($1, 1, 'published', $1, $2::jsonb) ON CONFLICT DO NOTHING`,
    [slug, JSON.stringify(SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })))]);
    for (const s of SIGNALS) {
      await owner.query(`INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled, forecast_horizon_hours)
        VALUES ($1, 1, $2, 'u', $3, $4) ON CONFLICT DO NOTHING`,
      [slug, s, !!opts.forecast?.includes(s), opts.forecast?.includes(s) ? 24 : null]);
    }
    await fixture((m) => m.getRepository(ClientEquipmentClass).save({
      tenantId: tenant, slug, name: slug, description: null, category: null,
      expectedSignals: SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })),
      failureModes: [], defaultThresholds: {}, templateSlug: slug, templateVersion: 1, templateChecksum: 'c',
      copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    }));
  };

  /** Bound and fresh unless named otherwise: `stale` reads 2 h old, `unbound` has no binding. */
  const seedMachine = async (
    externalId = 'DG-1', opts: { tenant?: string; slug?: string | null; stale?: string[]; unbound?: string[]; silent?: string[] } = {},
  ) => {
    const tenant = opts.tenant ?? 'acme';
    const slug = opts.slug === undefined ? 'dg' : opts.slug;
    const imei = `imei-${tenant}-${externalId}`;
    let id = '';
    await fixture(async (m) => {
      const p = await m.getRepository(EquipmentProfile).save({
        tenantId: tenant, sourceSystem: SS, externalId, equipmentClassSlug: slug, classVersion: slug ? 1 : null,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: `Machine ${externalId}`,
      });
      id = p.id;
      for (const s of SIGNALS) {
        if (opts.unbound?.includes(s)) continue;
        await m.getRepository(SignalBindingVersion).save({
          tenantId: tenant, sourceSystem: SS, externalId, signalKey: s, measurementRole: s, componentId: '', origin: 'physical',
          imei, channel: s, sensorInstanceId: null, canonicalUnit: 'u', sourceUnit: null, validFrom: new Date('2026-01-01'),
          validTo: null, expectedPeriodSeconds: 60, isPrimary: true, status: 'active', discoveredFrom: null,
          discoveredBy: 'manual', approvedBy: 'u', approvedAt: NOW,
        });
        if (opts.silent?.includes(s)) continue;
        const ago = opts.stale?.includes(s) ? 2 * HOUR : 0.05 * HOUR;
        await m.getRepository(TelemetryReading).save({
          tenantId: tenant, imei, signal: s, value: 50, unit: 'u', sourceTimestamp: new Date(NOW.getTime() - ago),
          receivedAt: NOW, source: 'live' as const,
        });
      }
    });
    return { ref: { sourceSystem: SS, externalId }, id };
  };

  const seedMode = (code: string, signals: string[], severity: Severity | null = null, extra: Partial<ClientEquipmentClassFailureMode> = {}) =>
    fixture((m) => m.getRepository(ClientEquipmentClassFailureMode).save({
      tenantId: 'acme', clientEquipmentClassSlug: 'dg', code, name: code, symptom: '', severity, signals,
      templateVersion: 1, copiedAt: NOW, ...extra,
    }));

  const seedRec = async (code: string, action: string, urgency: string, hours: number | null) => {
    const r = await fixture((m) => m.getRepository(ClientEquipmentClassRecommendation).save({
      tenantId: 'acme', clientEquipmentClassSlug: 'dg', failureModeCode: code, action, urgency: urgency as never,
      estimatedHours: hours, requiredParts: [{ part: 'gasket' }], templateVersion: 1, copiedAt: NOW,
    })) as ClientEquipmentClassRecommendation;
    return r.id;
  };

  const seedAlert = async (
    externalId: string, params: Record<string, unknown>, trigger = 'signal-threshold',
    opts: { state?: string; firedAt?: Date; tenant?: string } = {},
  ) => {
    const tenant = opts.tenant ?? 'acme';
    const [rule] = await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
         VALUES ($1, $2, 'Rule', $3, $4::jsonb, 'account', 'high', true) RETURNING id`,
      [tenant, `rule-${Math.random().toString(36).slice(2)}`, trigger, JSON.stringify(params)]);
    const state = opts.state ?? 'open';
    const [ev] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at,
         acknowledged_at, acknowledged_by, resolved_at, resolved_by, resolution_note)
       VALUES ($1, $2, 'Rule', $3, $4, 'high', 'x', '{}'::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tenant, rule.id, SS, externalId, state, opts.firedAt ?? NOW,
        state !== 'open' ? NOW : null, state !== 'open' ? 'u' : null,
        state === 'resolved' ? NOW : null, state === 'resolved' ? 'u' : null, state === 'resolved' ? 'fixed' : null]);
    return ev.id as string;
  };

  const seedWork = async (externalId: string, alertId: string | null, status: string, tenant = 'acme') => {
    const started = new Date(NOW.getTime() - 5 * HOUR);
    const ended = status === 'completed' ? new Date(NOW.getTime() - 2.5 * HOUR) : null;
    const [w] = await owner.query(
      `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, origin, raised_by, alert_id, started_at, ended_at, resolution)
       VALUES ($1, $2, $3, $4, 'Job', $5, 'normal', 'manual', 'u', $6, $7, $8, $9) RETURNING id`,
      [tenant, `WO-${Math.random().toString(36).slice(2, 8)}`, SS, externalId, status, alertId,
        status === 'created' ? null : started, ended, status === 'completed' ? 'done' : null]);
    return w.id as string;
  };

  const setParam = (scope: string, scopeRef: string | null, name: string, value: unknown, effectiveFrom = new Date('2026-01-01')) =>
    owner.query(`INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
      VALUES ('acme', $1, $2, $3, $4::jsonb, NULL, $5, 'u')`, [scope, scopeRef, name, JSON.stringify(value), effectiveFrom]);

  const run = async (ref: { sourceSystem: string; externalId: string }, at = NOW) =>
    (await engine.evaluate(acme, ref, at)).bundle as unknown as Bundle;
  const entry = (b: Bundle, signal: string) => b.detect.entries.find((e) => e.signal === signal)!;
  const mode = (b: Bundle, code: string) => b.attribute.modes.find((x) => x.failureModeCode === code)!;

  /** The usual library: overheat on coolant+oil, low_fuel on fuel_level. */
  const library = async () => {
    await seedMode('overheat', ['coolant_temp', 'oil_pressure'], Severity.High);
    await seedMode('low_fuel', ['fuel_level'], Severity.Low);
  };

  // ================================================================ Detect
  it('1. an open threshold alert on a signal → anomalous, with its alert as the evidence ref', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const alertId = await seedAlert('DG-1', { signal: 'coolant_temp', max: 105, lookbackReadings: 10, requiredBreaches: 6 });
    const b = await run(ref);
    expect(entry(b, 'coolant_temp')).toMatchObject({ state: 'anomalous', sources: [{ kind: 'alert', ref: `alert_event:${alertId}` }] });
  });

  it('2. a bound, fresh signal with no alert → normal', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    expect(entry(await run(ref), 'oil_pressure')).toMatchObject({ state: 'normal', reason: null });
  });

  it('3. a stale signal with no alert → not_observed / stale, and deliberately not normal', async () => {
    await seedClass(); const { ref } = await seedMachine('DG-1', { stale: ['fuel_level'] }); await library();
    const e = entry(await run(ref), 'fuel_level');
    expect(e.state).not.toBe('normal');
    expect(e).toMatchObject({ state: 'not_observed', reason: 'stale' });
  });

  it('4. an unbound signal → not_observed / unbound', async () => {
    await seedClass(); const { ref } = await seedMachine('DG-1', { unbound: ['fuel_level'] }); await library();
    expect(entry(await run(ref), 'fuel_level')).toMatchObject({ state: 'not_observed', reason: 'unbound' });
  });

  it('5. a no-telemetry alert → not_observed, not anomalous', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedAlert('DG-1', {}, 'no-telemetry');
    const b = await run(ref);
    expect(entry(b, 'coolant_temp')).toMatchObject({ state: 'not_observed', reason: 'no_telemetry' });
    expect(b.detect.entries.some((e) => e.state === 'anomalous')).toBe(false);
  });

  it('6. a forecast-declared signal before QML1 → residual source not_available / no_forecast_model', async () => {
    await seedClass('acme', 'dg', { forecast: ['coolant_temp'] }); const { ref } = await seedMachine(); await library();
    const b = await run(ref);
    expect(entry(b, 'coolant_temp').sources).toEqual([{ kind: 'residual', readiness: 'not_available', reason: 'no_forecast_model' }]);
    expect(entry(b, 'oil_pressure').sources).toEqual([]);
  });

  // ============================================================= Attribute
  it('7. two active modes: the one matching two signals first, and a re-run orders them byte-identically', async () => {
    await seedClass(); const { ref } = await seedMachine();
    await seedMode('a_one', ['coolant_temp'], Severity.Critical);
    await seedMode('b_two', ['coolant_temp', 'oil_pressure'], Severity.Low);
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    await seedAlert('DG-1', { signal: 'oil_pressure', max: 1 });
    const first = await run(ref);
    expect(first.attribute.modes.map((x) => x.failureModeCode)).toEqual(['b_two', 'a_one']);
    const replay = await run(ref, new Date(NOW.getTime() + 1000));
    expect(JSON.stringify(replay.attribute)).toBe(JSON.stringify(first.attribute));
  });

  it('8. equal matches: a declared severity before an undeclared one', async () => {
    await seedClass(); const { ref } = await seedMachine();
    await seedMode('a_null', ['coolant_temp'], null);
    await seedMode('z_low', ['coolant_temp'], Severity.Low);
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    expect((await run(ref)).attribute.modes.map((x) => x.failureModeCode)).toEqual(['z_low', 'a_null']);
  });

  it('9. a mode whose only signal is stale → unknown, never clear', async () => {
    await seedClass(); const { ref } = await seedMachine('DG-1', { stale: ['fuel_level'] }); await library();
    expect(mode(await run(ref), 'low_fuel').status).toBe('unknown');
  });

  it('10. an anomalous signal no mode names → unattributed, and nowhere else', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedAlert('DG-1', { signal: 'vibration', max: 1 });
    const b = await run(ref);
    expect(b.attribute.unattributed.map((u) => u.signal)).toEqual(['vibration']);
    expect(b.attribute.modes.every((x) => x.status !== 'active')).toBe(true);
    expect(b.outcome).toBe('unattributed');
  });

  it('11. an orphaned client mode is included, marked orphaned', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedMode('gone', ['oil_pressure'], null, { orphanedAt: NOW });
    expect(mode(await run(ref), 'gone')).toMatchObject({ orphaned: true });
  });

  it('12. the page\'s failure_modes widget and Attribute agree, mode by mode', async () => {
    await seedClass(); const { ref } = await seedMachine('DG-1', { stale: ['fuel_level'] }); await library();
    await seedMode('vib', ['vibration']);
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    await fixture((m) => m.getRepository(ClientEquipmentClassLayout).save({
      tenantId: 'acme', clientEquipmentClassSlug: 'dg', widgetType: 'failure_modes' as never, widgetKey: 'modes', boundTo: null,
      title: null, position: 1, size: 'medium' as const, hidden: false, positionCustom: false, templateVersion: 1, copiedAt: NOW,
    }));
    const page = (await pages.machinePage(acme, ref, NOW)).widgets[0].data as { code: string; status: string }[];
    const b = await run(ref);
    const fromPage = Object.fromEntries(page.map((x) => [x.code, x.status]));
    const fromEngine = Object.fromEntries(b.attribute.modes.map((x) => [x.failureModeCode, x.status]));
    expect(fromPage).toEqual(fromEngine);
    expect(fromEngine).toEqual({ overheat: 'active', low_fuel: 'unknown', vib: 'clear' });
  });

  // ============================================================= Precedent
  it('13. a machine with no alerts, work orders or service records → no_history, not none_found', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const b = await run(ref);
    for (const p of b.precedent.modes) {
      expect(p.state).toBe('no_history');
      expect(p.state).not.toBe('none_found');
    }
  });

  it('14. history, but none on the mode\'s signals → none_found', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedAlert('DG-1', { signal: 'vibration', max: 1 }, 'signal-threshold', { state: 'resolved', firedAt: new Date('2026-09-01') });
    expect((await run(ref)).precedent.modes.find((p) => p.failureModeCode === 'low_fuel')!.state).toBe('none_found');
  });

  it('15. a closed work order through an alert on the mode\'s signal → found, with observed hours; the estimate is untouched', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedRec('overheat', 'Flush coolant', 'next_shift', 3);
    const past = await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 }, 'signal-threshold', { state: 'resolved', firedAt: new Date('2026-08-01') });
    const wo = await seedWork('DG-1', past, 'completed');
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    const b = await run(ref);
    const p = b.precedent.modes.find((x) => x.failureModeCode === 'overheat')!;
    expect(p.state).toBe('found');
    expect(p.workOrders).toEqual([expect.objectContaining({ id: wo, observedHours: 2.5 })]);
    expect(b.candidates[0].estimatedHours).toBe(3);
  });

  it('16. another tenant\'s matching work order is not counted', async () => {
    await seedClass(); await seedClass('globex'); const { ref } = await seedMachine(); await library();
    await seedMachine('DG-1', { tenant: 'globex' });
    const theirs = await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 }, 'signal-threshold', { tenant: 'globex', state: 'resolved' });
    await seedWork('DG-1', theirs, 'completed', 'globex');
    const b = await run(ref);
    expect(b.precedent.coverage.sources.workOrders.rows).toBe(0);
    expect(b.precedent.modes.every((p) => p.state === 'no_history')).toBe(true);
  });

  // =================================================================== Gap
  it('17. an active mode with no client recommendation → no_library_recommendation', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    expect((await run(ref)).gap.noLibraryRecommendation).toEqual(['overheat']);
  });

  it('18. an open work order on the mode\'s alert → the candidate is inHand, and still listed', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedRec('overheat', 'Flush coolant', 'next_shift', 3);
    const alertId = await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    const wo = await seedWork('DG-1', alertId, 'in-progress');
    const b = await run(ref);
    expect(b.candidates).toEqual([expect.objectContaining({ failureModeCode: 'overheat', inHand: true, inHandWorkOrderIds: [wo] })]);
  });

  // ================================================================== Cost
  const costCase = async (hours: number | null) => {
    await seedClass(); const m = await seedMachine(); await library();
    const rec = await seedRec('overheat', 'Flush coolant', 'next_shift', hours);
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    return { ...m, rec };
  };
  const labour = (b: Bundle) => b.cost.lines.find((l) => l.line === 'labour')!.result;

  it('19. labour = hours × the most specific rate: equipment over site, named in parameter_set_version', async () => {
    const [plant] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'N', 'North') RETURNING id`);
    const { ref, id } = await costCase(3);
    await owner.query(`UPDATE equipment_profile SET plant_id = $1 WHERE id = $2`, [plant.id, id]);
    await setParam('client', null, 'currency', 'INR');
    await setParam('site', plant.id, 'labour_rate_per_hour', 500);
    await setParam('equipment', id, 'labour_rate_per_hour', 650);
    const l = labour(await run(ref));
    expect(l).toMatchObject({ status: 'ready', value: 1950, unit: 'INR', parameter_set_version: `equipment:${id}@2026-01-01T00:00:00.000Z` });
  });

  it('20. no labour rate at any scope → null, blocked, the parameter named; never 0', async () => {
    const { ref } = await costCase(3);
    await setParam('client', null, 'currency', 'INR');
    const b = await run(ref);
    expect(labour(b)).toMatchObject({ value: null, status: 'blocked', reasons: ['parameters_required'], limitations: ['labour_rate_per_hour not set'] });
    expect(labour(b).value).not.toBe(0);
    expect(b.cost.missingParameters).toEqual(['labour_rate_per_hour']);
  });

  it('21. no estimate on the recommendation → blocked, validation_required, the recommendation named', async () => {
    const { ref, rec } = await costCase(null);
    await setParam('client', null, 'currency', 'INR');
    await setParam('client', null, 'labour_rate_per_hour', 500);
    const l = labour(await run(ref));
    expect(l).toMatchObject({ value: null, status: 'blocked', reasons: ['validation_required'] });
    expect((l.limitations as string[])[0]).toContain(rec);
  });

  it('22. every cost line validates against calculation-result.v1', async () => {
    const { ref } = await costCase(3);
    await setParam('client', null, 'currency', 'INR');
    await setParam('client', null, 'labour_rate_per_hour', 500);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(__dirname, '../docs/ai/contracts/calculation-result.v1.schema.json'), 'utf8')));
    const b = await run(ref);
    expect(b.cost.lines.map((l) => l.line)).toEqual(['labour', 'downtime', 'parts', 'fuel']);
    for (const l of b.cost.lines) {
      expect({ line: l.line, ok: validate(l.result), errors: validate.errors ?? null }).toEqual({ line: l.line, ok: true, errors: null });
    }
  });

  it('23. a rate that takes effect after as_of is not used: the bundle reads at its own instant', async () => {
    const { ref } = await costCase(2);
    await setParam('client', null, 'currency', 'INR');
    await setParam('client', null, 'labour_rate_per_hour', 500);
    await setParam('client', null, 'labour_rate_per_hour', 900, new Date(NOW.getTime() + HOUR));
    expect(labour(await run(ref)).value).toBe(1000);
  });

  // ================================================================ Bundle
  it('24. an unclassified machine → not_configured / unclassified, every step\'s coverage present', async () => {
    const { ref } = await seedMachine('DG-9', { slug: null });
    const b = await run(ref);
    expect(b).toMatchObject({ status: 'not_configured', reason: 'unclassified', outcome: null });
    expect(b.detect.coverage).toBeDefined();
    expect(b.precedent.coverage.sources).toBeDefined();
  });

  it('25. every named signal dead → blocked / insufficient_coverage, not nothing_detected', async () => {
    await seedClass(); const { ref } = await seedMachine('DG-1', { stale: ['coolant_temp', 'oil_pressure'], unbound: ['fuel_level'] });
    await library();
    const b = await run(ref);
    expect(b).toMatchObject({ status: 'blocked', reason: 'insufficient_coverage', outcome: null });
  });

  it('25b. every named signal seen and normal → ready / nothing_detected', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    expect(await run(ref)).toMatchObject({ status: 'ready', outcome: 'nothing_detected' });
  });

  it('26. two POSTs over unchanged data at once: both settle, one id, one row', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    const results = await Promise.allSettled([engine.evaluate(acme, ref, NOW), engine.evaluate(acme, ref, NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<{ bundle: { id: string }; created: boolean }>).value);
    expect(a.bundle.id).toBe(b.bundle.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM rec_evidence_bundle`))[0].n).toBe(1);
  });

  it('27. a new alert between two POSTs → a second bundle', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const first = await run(ref);
    await seedAlert('DG-1', { signal: 'coolant_temp', max: 1 });
    const second = await run(ref, new Date(NOW.getTime() + 1000));
    expect(second.id).not.toBe(first.id);
    expect(second.outcome).toBe('attributed');
  });

  it('28. the database refuses UPDATE and DELETE of a bundle, from the application role', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const b = await run(ref);
    await expect(withTenantId(ds, 'acme', (m) => m.query(`UPDATE rec_evidence_bundle SET status = 'blocked' WHERE id = $1`, [b.id])))
      .rejects.toThrow(/permission denied|append-only/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(`DELETE FROM rec_evidence_bundle WHERE id = $1`, [b.id])))
      .rejects.toThrow(/permission denied|append-only/);
    // And the trigger holds even for a role the grant would let through.
    await expect(owner.query(`UPDATE rec_evidence_bundle SET status = 'blocked' WHERE id = $1`, [b.id])).rejects.toThrow(/append-only/);
    await expect(owner.query(`DELETE FROM rec_evidence_bundle WHERE id = $1`, [b.id])).rejects.toThrow(/append-only/);
  });

  it('29. a status outside the closed set, inserted directly → refused by the CHECK', async () => {
    await expect(owner.query(`INSERT INTO rec_evidence_bundle (tenant_id, source_system, external_id, as_of, engine_version, inputs_hash,
        status, reason, outcome, detect, attribute, precedent, gap, cost, candidates)
      VALUES ('acme', 's', 'x', now(), 'v', 'h', 'maybe', 'unclassified', NULL, '{}', '{}', '{}', '{}', '{}', '[]')`))
      .rejects.toThrow(/ck_rec_evidence_bundle_status/);
    await expect(owner.query(`INSERT INTO rec_evidence_bundle (tenant_id, source_system, external_id, as_of, engine_version, inputs_hash,
        status, reason, outcome, detect, attribute, precedent, gap, cost, candidates)
      VALUES ('acme', 's', 'x', now(), 'v', 'h', 'ready', NULL, NULL, '{}', '{}', '{}', '{}', '{}', '[]')`))
      .rejects.toThrow(/ck_rec_evidence_bundle_ready_outcome/);
  });

  it('30. a caller whose scope excludes the machine → 404 on all three routes', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const b = await run(ref);
    await expect(engine.evaluate(narrow, ref, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(engine.latest(narrow, ref)).rejects.toMatchObject({ status: 404 });
    await expect(engine.byId(narrow, b.id)).rejects.toMatchObject({ status: 404 });
  });

  it('31. another tenant cannot read a bundle by id, and row-level security answers the same', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const b = await run(ref);
    await expect(engine.byId(globex, b.id)).rejects.toMatchObject({ status: 404 });
    expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT id FROM rec_evidence_bundle WHERE id = $1`, [b.id]))).toEqual([]);
  });

  it('a live incident on the machine is linked; the latest bundle is what GET returns', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    const [inc] = await owner.query(`INSERT INTO incident (tenant_id, source_system, external_id, severity, status, opened_at)
      VALUES ('acme', $1, 'DG-1', 'high', 'open', $2) RETURNING id`, [SS, NOW]);
    const b = await run(ref);
    expect(b.incidentId).toBe(inc.id);
    expect(((await engine.latest(acme, ref)) as unknown as Bundle).id).toBe(b.id);
  });

  describe('over HTTP', () => {
    const auth = async () => `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000c1', client_id: 'acme', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER })}`;

    it('POST answers 201 for new evidence and 200 for unchanged; GET returns it; a non-id is refused', async () => {
      await seedClass(); await seedMachine(); await library();
      const url = `/api/v1/equipment/${SS}/DG-1/rec-evidence`;
      const first = await request(app.getHttpServer()).post(url).set('Authorization', await auth());
      expect(first.status).toBe(201);
      const again = await request(app.getHttpServer()).post(url).set('Authorization', await auth());
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect((await request(app.getHttpServer()).get(url).set('Authorization', await auth())).body.id).toBe(first.body.id);
      expect((await request(app.getHttpServer()).get(`/api/v1/rec-evidence/${first.body.id}`).set('Authorization', await auth())).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/api/v1/rec-evidence/not-an-id').set('Authorization', await auth())).status).toBe(400);
    });

    it('GET for a machine never evaluated → 404', async () => {
      await seedClass(); await seedMachine(); await library();
      expect((await request(app.getHttpServer()).get(`/api/v1/equipment/${SS}/DG-1/rec-evidence`).set('Authorization', await auth())).status).toBe(404);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it('33. RecEvidenceBundle1761000000000 down drops the table and its trigger with a real row in it, and up restores them', async () => {
    await seedClass(); const { ref } = await seedMachine(); await library();
    await run(ref);
    await undoMigrationNamed(owner, 'RecEvidenceBundle1761000000000');
    expect(await owner.query(`SELECT to_regclass('rec_evidence_bundle') AS t, to_regproc('rec_evidence_bundle_append_only') AS f`))
      .toEqual([{ t: null, f: null }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('rec_evidence_bundle')::text AS t`)).toEqual([{ t: 'rec_evidence_bundle' }]);
  });
});
