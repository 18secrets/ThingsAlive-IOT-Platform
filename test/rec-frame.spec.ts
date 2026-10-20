import { INestApplication, Logger } from '@nestjs/common';
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
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';
import { CHECK, critic } from '../src/rec-frame/critic';
import { FrameModel } from '../src/rec-frame/frame-model';
import { BundleView, bundleView, GroundedAnswer } from '../src/rec-frame/grounded-answer';
import { RecFrameService } from '../src/rec-frame/rec-frame.service';
import { renderTemplateFrame } from '../src/rec-frame/render';
import { BUNDLE_STATE_KEYS, NOT_PHRASED, TEMPLATES } from '../src/rec-frame/templates';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const HOUR = 3_600_000;
const SECRET = 'test-secret-rec-frame';
const ISSUER = 'things-alive-rec-frame-test';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const SS = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
const narrow: RequestScope = { ...acme, userId: 'u-narrow', equipmentIds: ['OTHER'] };

const SIGNALS = ['coolant_temp', 'oil_pressure', 'fuel_level', 'vibration'];

/** Every sentence a frame holds, for the assertions that must hold of all of them. */
const strings = (f: GroundedAnswer) => [
  f.summary, ...f.observations.map((o) => o.claim), ...f.hypotheses.flatMap((h) => [h.claim, ...h.limitations]),
  ...f.next_steps.flatMap((s) => [s.aim, s.expected_outcome]), ...f.missing_inputs, ...f.limitations,
];

class FakeModel implements FrameModel {
  readonly id = 'fake-model';
  readonly version = '1';
  calls = 0;
  constructor(private readonly reply: (i: { bundle: BundleView; templateFrame: GroundedAnswer }) => unknown) {}
  async frame(i: { bundle: BundleView; templateFrame: GroundedAnswer }) { this.calls++; return this.reply(i); }
}

/**
 * The frame (task QREC2, D21, D36): the evidence bundle in sentences, by templates,
 * with a model seam behind a flag and one critic for both. What is tested is what a
 * site manager would read — above all what it says when the bundle could not see — and
 * that the critic refuses, by attempting it, every way a frame could claim more than
 * the bundle holds.
 */
describeDb('rec frame: templates, critic, model seam', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let engine: RecEngineService;
  let frames: RecFrameService;
  let validate: ReturnType<Ajv2020['compile']>;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    delete process.env.REC_FRAME_MODEL_ENABLED;
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    engine = app.get(RecEngineService);
    frames = app.get(RecFrameService);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const contracts = join(__dirname, '../docs/ai/contracts');
    ajv.addSchema(JSON.parse(readFileSync(join(contracts, 'retrieval-hit.v1.schema.json'), 'utf8')));
    validate = ajv.compile(JSON.parse(readFileSync(join(contracts, 'grounded-answer.v1.schema.json'), 'utf8')));
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "rec_frame", "rec_evidence_bundle", "telemetry_reading", "signal_binding_version", "alert_event", "alert_rule",
        "work_order", "equipment_service_record", "tenant_parameter", "incident",
        "client_equipment_class_recommendation", "client_equipment_class_failure_mode", "client_equipment_class",
        "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile", "plant"
      RESTART IDENTITY CASCADE`);
  });

  // ============================================================== fixtures
  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  const seedProfile = (slug: string) => owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ($1, 1, 'published', $1, $2::jsonb) ON CONFLICT DO NOTHING`,
  [slug, JSON.stringify(SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })))]);

  const seedClass = async (tenant = 'acme', slug = 'dg') => {
    await seedProfile(slug);
    for (const s of SIGNALS) {
      await owner.query(`INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled, forecast_horizon_hours)
        VALUES ($1, 1, $2, 'u', false, null) ON CONFLICT DO NOTHING`, [slug, s]);
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
    externalId = 'DG-1', opts: { tenant?: string; slug?: string | null; stale?: string[]; unbound?: string[] } = {},
  ) => {
    const tenant = opts.tenant ?? 'acme';
    const slug = opts.slug === undefined ? 'dg' : opts.slug;
    const imei = `imei-${tenant}-${externalId}`;
    await fixture(async (m) => {
      await m.getRepository(EquipmentProfile).save({
        tenantId: tenant, sourceSystem: SS, externalId, equipmentClassSlug: slug, classVersion: slug ? 1 : null,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: `Machine ${externalId}`,
      });
      for (const s of SIGNALS) {
        if (opts.unbound?.includes(s)) continue;
        await m.getRepository(SignalBindingVersion).save({
          tenantId: tenant, sourceSystem: SS, externalId, signalKey: s, measurementRole: s, componentId: '', origin: 'physical',
          imei, channel: s, sensorInstanceId: null, canonicalUnit: 'u', sourceUnit: null, validFrom: new Date('2026-01-01'),
          validTo: null, expectedPeriodSeconds: 60, isPrimary: true, status: 'active', discoveredFrom: null,
          discoveredBy: 'manual', approvedBy: 'u', approvedAt: NOW,
        });
        const ago = opts.stale?.includes(s) ? 2 * HOUR : 0.05 * HOUR;
        await m.getRepository(TelemetryReading).save({
          tenantId: tenant, imei, signal: s, value: 50, unit: 'u', sourceTimestamp: new Date(NOW.getTime() - ago),
          receivedAt: NOW, source: 'live' as const,
        });
      }
    });
    return { sourceSystem: SS, externalId };
  };

  const seedMode = (code: string, signals: string[], severity: Severity | null = null, slug = 'dg') =>
    fixture((m) => m.getRepository(ClientEquipmentClassFailureMode).save({
      tenantId: 'acme', clientEquipmentClassSlug: slug, code, name: `${code} mode`, symptom: '', severity, signals,
      templateVersion: 1, copiedAt: NOW,
    }));

  const seedRec = async (code: string, action: string, urgency: string, hours: number | null) =>
    ((await fixture((m) => m.getRepository(ClientEquipmentClassRecommendation).save({
      tenantId: 'acme', clientEquipmentClassSlug: 'dg', failureModeCode: code, action, urgency: urgency as never,
      estimatedHours: hours, requiredParts: [], templateVersion: 1, copiedAt: NOW,
    }))) as ClientEquipmentClassRecommendation).id;

  const seedAlert = async (externalId: string, signal: string, opts: { state?: string; firedAt?: Date } = {}) => {
    const [rule] = await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
         VALUES ('acme', $1, 'Rule', 'signal-threshold', $2::jsonb, 'account', 'high', true) RETURNING id`,
      [`rule-${Math.random().toString(36).slice(2)}`, JSON.stringify({ signal, max: 1 })]);
    const state = opts.state ?? 'open';
    const [ev] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at,
         acknowledged_at, acknowledged_by, resolved_at, resolved_by, resolution_note)
       VALUES ('acme', $1, 'Rule', $2, $3, 'high', 'x', '{}'::jsonb, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [rule.id, SS, externalId, state, opts.firedAt ?? NOW,
        state !== 'open' ? NOW : null, state !== 'open' ? 'u' : null,
        state === 'resolved' ? NOW : null, state === 'resolved' ? 'u' : null, state === 'resolved' ? 'fixed' : null]);
    return ev.id as string;
  };

  const seedWork = async (externalId: string, alertId: string, status: string) => {
    const [w] = await owner.query(
      `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, origin, raised_by, alert_id, started_at, ended_at, resolution)
       VALUES ('acme', $1, $2, $3, 'Job', $4, 'normal', 'manual', 'u', $5, $6, $7, $8) RETURNING id`,
      [`WO-${Math.random().toString(36).slice(2, 8)}`, SS, externalId, status, alertId,
        status === 'created' ? null : new Date(NOW.getTime() - 5 * HOUR),
        status === 'completed' ? new Date(NOW.getTime() - 2.5 * HOUR) : null, status === 'completed' ? 'done' : null]);
    return w.id as string;
  };

  const setParam = (name: string, value: unknown) =>
    owner.query(`INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
      VALUES ('acme', 'client', NULL, $1, $2::jsonb, NULL, '2026-01-01', 'u')`, [name, JSON.stringify(value)]);

  /** The usual library: overheat on coolant+oil, low_fuel on fuel_level. */
  const library = async () => {
    await seedMode('overheat', ['coolant_temp', 'oil_pressure'], Severity.High);
    await seedMode('low_fuel', ['fuel_level'], Severity.Low);
  };

  const bundleOf = async (ref: { sourceSystem: string; externalId: string }) => (await engine.evaluate(acme, ref, NOW)).bundle;
  const frameOf = async (ref: { sourceSystem: string; externalId: string }) => {
    const b = await bundleOf(ref);
    return { bundle: b, served: await frames.render(acme, b.id) };
  };
  const withModel = (model: FrameModel | null) => {
    process.env.REC_FRAME_MODEL_ENABLED = 'true';
    try { return new RecFrameService(ds, engine, model); } finally { delete process.env.REC_FRAME_MODEL_ENABLED; }
  };
  const rows = () => owner.query(`SELECT renderer, validation, refused_checks, answer, model_id, model_version FROM rec_frame ORDER BY renderer DESC`);

  /** An attributed bundle with two candidates on its one active mode, both priced. */
  const twoCandidates = async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    await seedRec('overheat', 'Flush coolant', 'immediate', 3);
    await seedRec('overheat', 'Check fan belt', 'next_shift', 1);
    await setParam('currency', 'INR'); await setParam('labour_rate_per_hour', 500);
    await seedAlert('DG-1', 'coolant_temp');
    return ref;
  };

  // ============================================================== contract
  it('1. every outcome and every refusal renders a valid GroundedAnswerV1 with the status §1.1 gives', async () => {
    await seedClass(); await seedClass('acme', 'dg2'); await seedProfile('zz'); await library();
    const cases: [string, Parameters<typeof seedMachine>[1], string | null, string][] = [
      ['A', {}, 'coolant_temp', 'answered'],
      ['B', { stale: ['oil_pressure'] }, 'coolant_temp', 'partial'],
      ['C', { stale: ['fuel_level'] }, null, 'partial'],
      ['D', {}, 'vibration', 'partial'],
      ['E', {}, null, 'answered'],
      ['F', { slug: null }, null, 'needs_input'],
      ['G', { slug: 'zz' }, null, 'needs_input'],
      ['H', { slug: 'dg2' }, null, 'needs_input'],
      ['I', { stale: ['coolant_temp', 'oil_pressure'], unbound: ['fuel_level'] }, null, 'insufficient_evidence'],
    ];
    const seen: Record<string, string> = {};
    for (const [id, opts, alertOn, status] of cases) {
      const ref = await seedMachine(id, opts);
      if (alertOn) await seedAlert(id, alertOn);
      const { bundle, served } = await frameOf(ref);
      seen[bundle.outcome ?? bundle.reason!] = served.answer.status;
      expect({ id, ok: validate(served.answer), errors: validate.errors ?? null }).toEqual({ id, ok: true, errors: null });
      expect({ id, status: served.answer.status }).toEqual({ id, status });
      expect(served.answer.context_id).toBe(bundle.id);
      expect(served.answer.citations).toEqual([]);
      expect(served.provenance).toEqual({ renderer: 'template', rendererVersion: 'rec-frame-templates@1', modelId: null, modelVersion: null, bundleId: bundle.id });
    }
    // Every outcome and every refusal reason was exercised, not just most of them.
    expect(Object.keys(seen).sort()).toEqual(['attributed', 'class_not_in_account', 'inconclusive', 'insufficient_coverage',
      'no_library_content', 'nothing_detected', 'unattributed', 'unclassified']);
  });

  it('1b. the hand-written shape check and the schema agree: a widened frame is refused by both', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const b = bundleView(await bundleOf(ref));
    const f = renderTemplateFrame(b);
    expect(critic(f, b)).toEqual([]);
    for (const widened of [{ ...f, confidence: 0.9 }, { ...f, observations: [{ claim: 'x', evidence_refs: [] }] }, { ...f, status: 'maybe' }]) {
      expect(validate(widened)).toBe(false);
      expect(critic(widened, b)).toEqual([CHECK.shape]);
    }
  });

  it('2. every (section, state) the bundle vocabulary can produce has a template, or is listed as deliberately unphrased', () => {
    const templates = TEMPLATES as Record<string, unknown>;
    const missing = BUNDLE_STATE_KEYS.filter((k) => typeof templates[k] !== 'function' && !(k in NOT_PHRASED));
    expect(missing).toEqual([]);
    expect(Object.keys(NOT_PHRASED).filter((k) => !BUNDLE_STATE_KEYS.includes(k))).toEqual([]);
  });

  it('2b. a detect reason with no template fails the render rather than rendering nothing', async () => {
    await seedClass(); const ref = await seedMachine('DG-1', { unbound: ['fuel_level'] }); await library();
    const b = bundleView(await bundleOf(ref));
    b.detect.entries.find((e) => e.signal === 'fuel_level')!.reason = 'mystery';
    expect(() => renderTemplateFrame(b)).toThrow(/No frame template for detect.not_observed.mystery/);
  });

  it('3. the same bundle renders byte-identically, in process and over two requests', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    expect(JSON.stringify(renderTemplateFrame(bundleView(bundle)))).toBe(JSON.stringify(renderTemplateFrame(bundleView(bundle))));
    const a = await frames.render(acme, bundle.id);
    const b = await frames.render(acme, bundle.id);
    expect(JSON.stringify(b.answer)).toBe(JSON.stringify(a.answer));
    expect([a.created, b.created]).toEqual([true, false]);
  });

  // =============================================================== absence
  it('4. no_history → "No history to search", never "similar" or "occurred", and not the found wording', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const { served } = await frameOf(ref);
    const sentence = served.answer.observations.map((o) => o.claim).find((c) => c.includes('No history to search'))!;
    expect(sentence).toBeDefined();
    expect(sentence).not.toMatch(/similar|occurred/i);
    const found = TEMPLATES['precedent.found']({ mode: 'm', alerts: 1, orders: 0, hours: [] });
    expect(sentence).not.toBe(found);
  });

  it('5. a stale signal → it has not reported; nothing calls it normal', async () => {
    await seedClass(); const ref = await seedMachine('DG-1', { stale: ['fuel_level'] }); await library();
    const { served } = await frameOf(ref);
    expect(served.answer.observations.map((o) => o.claim)).toContain(
      'fuel_level has not reported since 2026-10-19 10:00 UTC; it cannot confirm or rule out anything.');
    expect(strings(served.answer).filter((s) => /\bnormal\b|healthy/i.test(s))).toEqual([]);
  });

  it('6. nothing_detected → the summary says how many signals were checked, and never "healthy"', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const { served } = await frameOf(ref);
    expect(served.answer.summary).toBe('3 of 3 signals reporting; none outside its limits.');
    expect(strings(served.answer).join(' ')).not.toMatch(/healthy/i);
  });

  it('7. no labour rate → missing_inputs names it, no money appears anywhere, and status is not downgraded', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    await seedRec('overheat', 'Flush coolant', 'next_shift', 3);
    await setParam('currency', 'INR');
    await seedAlert('DG-1', 'coolant_temp');
    const { served } = await frameOf(ref);
    expect(served.answer.missing_inputs).toContain('labour_rate_per_hour');
    expect(strings(served.answer).filter((s) => /\d\s*INR/.test(s))).toEqual([]);
    expect(served.answer.limitations).toContain('Labour cost not shown: no labour rate is set for this machine.');
    expect(served.answer.status).toBe('answered');
  });

  it('8. no candidates → next_steps is empty and nothing says "no action"', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    await seedAlert('DG-1', 'coolant_temp');
    const { served } = await frameOf(ref);
    expect(served.answer.next_steps).toEqual([]);
    expect(served.answer.summary).toContain('The dg library has no recommendation for overheat mode.');
    expect(strings(served.answer).join(' ')).not.toMatch(/no action/i);
  });

  // ============================================================= selection
  it('9. the top mode\'s work already in hand → the next mode\'s candidate is selected first; the in-hand one follows, said to be in hand', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    await seedMode('leak', ['oil_pressure'], Severity.Low);
    await seedRec('overheat', 'Flush coolant', 'immediate', 3);
    await seedRec('leak', 'Replace seal', 'next_shift', 2);
    const alertId = await seedAlert('DG-1', 'coolant_temp');
    await seedAlert('DG-1', 'oil_pressure');
    await seedWork('DG-1', alertId, 'in-progress');
    const { bundle, served } = await frameOf(ref);
    // QREC1's order, for the record: overheat (two matched signals) before leak.
    expect((bundle.candidates as { action: string; inHand: boolean }[]).map((c) => [c.action, c.inHand]))
      .toEqual([['Flush coolant', true], ['Replace seal', false]]);
    expect(served.answer.next_steps.map((s) => [s.aim, s.expected_outcome])).toEqual([
      ['Replace seal', 'Addresses leak mode.'],
      ['Flush coolant', 'Already in hand: an open work order covers this. Addresses overheat mode.'],
    ]);
  });

  it('9b. every candidate in hand → the first is still listed first, every one said to be in hand', async () => {
    const ref = await twoCandidates();
    const [alertId] = (await owner.query(`SELECT id FROM alert_event`)).map((r: { id: string }) => r.id);
    await seedWork('DG-1', alertId, 'in-progress');
    const { served } = await frameOf(ref);
    expect(served.answer.next_steps.map((s) => s.aim)).toEqual(['Flush coolant', 'Check fan belt']);
    expect(served.answer.next_steps.every((s) => s.expected_outcome.startsWith('Already in hand'))).toBe(true);
  });

  it('10. every aim is the library action verbatim, punctuation, numbers and all', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const action = 'Top up coolant to 50% — check the "C-2" cap, 3 turns';
    await seedRec('overheat', action, 'immediate', null);
    await seedAlert('DG-1', 'coolant_temp');
    const { served } = await frameOf(ref);
    expect(served.answer.next_steps.map((s) => s.aim)).toEqual([action]);
    expect(served.answer.next_steps[0]).toMatchObject({ required_capability: 'action.work', simulation_available: false });
  });

  // =============================================== the critic: attempted, not asserted to exist
  it('11. a template patched to emit a number the bundle does not hold → the render is refused, check 3 named', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const bundle = await bundleOf(ref);
    const t = TEMPLATES as Record<string, unknown>;
    const original = t['limitation.no_reference_documents'];
    t['limitation.no_reference_documents'] = () => 'Searched 987654 documents.';
    try {
      await expect(frames.render(acme, bundle.id)).rejects.toMatchObject({ status: 500, message: expect.stringContaining(CHECK.numbers) });
    } finally {
      t['limitation.no_reference_documents'] = original;
    }
    expect(await rows()).toEqual([]);
  });

  it('12. a ref to a real alert the bundle did not read → refused, check 2 named', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    await seedAlert('DG-1', 'coolant_temp');
    const b = bundleView(await bundleOf(ref));
    await seedMachine('DG-2');
    const elsewhere = await seedAlert('DG-2', 'coolant_temp');
    const f = renderTemplateFrame(b);
    f.observations[0].evidence_refs = [`alert_event:${elsewhere}`];
    expect(critic(f, b)).toEqual([CHECK.refs]);
    f.observations[0].evidence_refs = [`rec_evidence_bundle:${b.id}#/detect/nowhere`];
    expect(critic(f, b)).toEqual([CHECK.refs]);
  });

  it('12b. a time after the bundle\'s as_of in any sentence → refused, check 4 named', async () => {
    await seedClass(); const ref = await seedMachine(); await library();
    const b = bundleView(await bundleOf(ref));
    const f = renderTemplateFrame(b);
    // A time the bundle holds, but stated as later than the evidence: the future is not the bundle's to state.
    b.precedent.coverage.period.to = '2026-10-25T08:00:00.000Z';
    f.limitations.push('Expect a breach by 2026-10-25 08:00 UTC.');
    expect(critic(f, b)).toEqual([CHECK.future]);
  });

  it('13. the model adds a number → its frame is refused and kept as a refusal; the template frame is served', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => ({ ...templateFrame, summary: 'Overheat: 87 minutes to failure.' }));
    const served = await withModel(model).render(acme, bundle.id);
    expect(served.provenance.renderer).toBe('template');
    expect(await rows()).toEqual([
      { renderer: 'template', validation: 'passed', refused_checks: [], answer: expect.any(Object), model_id: null, model_version: null },
      { renderer: 'model', validation: 'refused', refused_checks: [CHECK.numbers], answer: null, model_id: 'fake-model', model_version: '1' },
    ]);
  });

  it('14. the model writes an aim that is not a candidate → refused, check 5', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => ({
      ...templateFrame, next_steps: [{ ...templateFrame.next_steps[0], aim: 'Flush the coolant system' }],
    }));
    await withModel(model).render(acme, bundle.id);
    expect((await rows())[1]).toMatchObject({ validation: 'refused', refused_checks: [CHECK.closedSet] });
  });

  it('15. the model picks the other valid candidate and rephrases → accepted and served, the model named', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => ({
      ...templateFrame,
      summary: 'Coolant temperature alerts point at overheat mode.',
      next_steps: [templateFrame.next_steps[1], templateFrame.next_steps[0]],
    }));
    const service = withModel(model);
    const served = await service.render(acme, bundle.id);
    expect(served.provenance).toEqual({ renderer: 'model', rendererVersion: 'rec-frame-model@1', modelId: 'fake-model', modelVersion: '1', bundleId: bundle.id });
    expect(served.answer.next_steps.map((s) => s.aim)).toEqual(['Check fan belt', 'Flush coolant']);
    expect(served.answer.summary).toBe('Coolant temperature alerts point at overheat mode.');
    expect(validate(served.answer)).toBe(true);
    // And the read serves the same thing, without asking the model again.
    expect((await service.read(acme, bundle.id)).provenance.renderer).toBe('model');
    expect(model.calls).toBe(1);
  });

  it('16. the model says "likely" or gives a percentage → refused, check 6', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => ({ ...templateFrame, summary: 'Overheat mode is the likely cause.' }));
    await withModel(model).render(acme, bundle.id);
    expect((await rows())[1]).toMatchObject({ validation: 'refused', refused_checks: [CHECK.probability] });
  });

  it('16b. the model adds an observation of its own → refused, check 7', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => ({
      ...templateFrame, observations: [...templateFrame.observations, { claim: 'The fan sounds rough.', evidence_refs: templateFrame.observations[0].evidence_refs }],
    }));
    await withModel(model).render(acme, bundle.id);
    expect((await rows())[1]).toMatchObject({ validation: 'refused', refused_checks: [CHECK.structure] });
  });

  // ================================================================== flag
  it('17. flag off with a model bound → the model is never called', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(({ templateFrame }) => templateFrame);
    const off = new RecFrameService(ds, engine, model);
    expect(off.modelEnabled).toBe(false);
    expect((await off.render(acme, bundle.id)).provenance.renderer).toBe('template');
    await off.read(acme, bundle.id);
    expect(model.calls).toBe(0);
    expect((await rows()).map((r: { renderer: string }) => r.renderer)).toEqual(['template']);
  });

  it('18. flag on with no model → one boot warning, and every frame is the template frame', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const service = withModel(null);
      service.onModuleInit();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/REC_FRAME_MODEL_ENABLED is true but no frame model is configured/);
      const ref = await twoCandidates();
      const bundle = await bundleOf(ref);
      expect((await service.render(acme, bundle.id)).provenance.renderer).toBe('template');
    } finally {
      warn.mockRestore();
    }
  });

  // =========================================================== persistence
  it('19. two POSTs for one bundle at once: both settle, one answer_id, one template row', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const results = await Promise.allSettled([frames.render(acme, bundle.id), frames.render(acme, bundle.id)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<RecFrameService['render']>>>).value);
    expect(a.answer.answer_id).toBe(b.answer.answer_id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM rec_frame`))[0].n).toBe(1);
  });

  it('19b. two POSTs at once with the model on: the model is asked once, one model row', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const model = new FakeModel(async ({ templateFrame }) => { await new Promise((r) => setTimeout(r, 50)); return templateFrame; });
    const service = withModel(model);
    const results = await Promise.allSettled([service.render(acme, bundle.id), service.render(acme, bundle.id)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(model.calls).toBe(1);
    expect((await owner.query(`SELECT renderer, count(*)::int AS n FROM rec_frame GROUP BY renderer ORDER BY renderer`)))
      .toEqual([{ renderer: 'model', n: 1 }, { renderer: 'template', n: 1 }]);
  });

  it('20. the database refuses UPDATE and DELETE of a frame, from the application role and from the owner', async () => {
    const ref = await twoCandidates();
    const { served } = await frameOf(ref);
    const id = served.answer.answer_id;
    await expect(withTenantId(ds, 'acme', (m) => m.query(`UPDATE rec_frame SET validation = 'refused' WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied|append-only/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(`DELETE FROM rec_frame WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied|append-only/);
    await expect(owner.query(`UPDATE rec_frame SET validation = 'refused' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(owner.query(`DELETE FROM rec_frame WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('21. a refused frame with prose, an unnamed refusal, or a refused template → each refused by its CHECK', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    const insert = (renderer: string, validation: string, checks: string[], answer: unknown, model: string | null) =>
      owner.query(`INSERT INTO rec_frame (id, tenant_id, bundle_id, renderer, renderer_version, model_id, model_version, validation, refused_checks, answer)
        VALUES (gen_random_uuid(), 'acme', $1, $2, 'v', $3, $3, $4, $5::text[], $6::jsonb)`,
      [bundle.id, renderer, model, validation, checks, answer === null ? null : JSON.stringify(answer)]);
    await expect(insert('model', 'refused', [CHECK.numbers], { summary: 'x' }, 'm')).rejects.toThrow(/ck_rec_frame_answer_iff_passed/);
    await expect(insert('model', 'refused', [], null, 'm')).rejects.toThrow(/ck_rec_frame_refusal_named/);
    await expect(insert('template', 'refused', [CHECK.numbers], null, null)).rejects.toThrow(/ck_rec_frame_template_passed/);
    await expect(insert('model', 'passed', [], { summary: 'x' }, null)).rejects.toThrow(/ck_rec_frame_model_named/);
  });

  it('21b. a frame in one tenant pointing at another tenant\'s bundle → refused by the foreign key', async () => {
    const ref = await twoCandidates();
    const bundle = await bundleOf(ref);
    await expect(owner.query(`INSERT INTO rec_frame (id, tenant_id, bundle_id, renderer, renderer_version, validation, answer)
      VALUES (gen_random_uuid(), 'globex', $1, 'template', 'v', 'passed', '{}'::jsonb)`, [bundle.id])).rejects.toThrow(/fk_rec_frame_bundle/);
  });

  it('22. another tenant cannot read a frame, by bundle id or by answer id', async () => {
    const ref = await twoCandidates();
    const { bundle, served } = await frameOf(ref);
    await expect(frames.read(globex, bundle.id)).rejects.toMatchObject({ status: 404 });
    await expect(frames.render(globex, bundle.id)).rejects.toMatchObject({ status: 404 });
    expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT id FROM rec_frame WHERE id = $1 OR bundle_id = $2`,
      [served.answer.answer_id, bundle.id]))).toEqual([]);
  });

  it('23. a caller whose scope excludes the machine → 404 on render and on read', async () => {
    const ref = await twoCandidates();
    const { bundle } = await frameOf(ref);
    await expect(frames.render(narrow, bundle.id)).rejects.toMatchObject({ status: 404 });
    await expect(frames.read(narrow, bundle.id)).rejects.toMatchObject({ status: 404 });
  });

  describe('over HTTP', () => {
    const auth = async () => `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000c1', client_id: 'acme', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER })}`;

    it('GET before a render is 404; POST is 201 then 200; GET serves it; a non-id is refused', async () => {
      const ref = await twoCandidates();
      const bundle = await bundleOf(ref);
      const url = `/api/v1/rec-evidence/${bundle.id}/frame`;
      expect((await request(app.getHttpServer()).get(url).set('Authorization', await auth())).status).toBe(404);
      const first = await request(app.getHttpServer()).post(url).set('Authorization', await auth());
      expect(first.status).toBe(201);
      expect(Object.keys(first.body).sort()).toEqual(['answer', 'provenance']);
      const again = await request(app.getHttpServer()).post(url).set('Authorization', await auth());
      expect(again.status).toBe(200);
      expect(again.body.answer.answer_id).toBe(first.body.answer.answer_id);
      const read = await request(app.getHttpServer()).get(url).set('Authorization', await auth());
      expect(read.status).toBe(200);
      expect(read.body).toEqual(first.body);
      expect((await request(app.getHttpServer()).post('/api/v1/rec-evidence/not-an-id/frame').set('Authorization', await auth())).status).toBe(400);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it('24. RecFrame1761200000000 down drops the table, its trigger and the bundle key with a real row in it, and up restores them', async () => {
    const ref = await twoCandidates();
    await frameOf(ref);
    await undoMigrationNamed(owner, 'RecFrame1761200000000');
    expect(await owner.query(`SELECT to_regclass('rec_frame') AS t, to_regproc('rec_frame_append_only') AS f,
        to_regclass('uq_rec_evidence_bundle_id_tenant') AS i`)).toEqual([{ t: null, f: null, i: null }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('rec_frame')::text AS t`)).toEqual([{ t: 'rec_frame' }]);
  });
});
