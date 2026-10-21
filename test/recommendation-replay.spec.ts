import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Severity } from '../src/common/severity';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { RecommendationReplayService } from '../src/evaluation/recommendation-replay.service';
import { coverageHonesty, grounding } from '../src/evaluation/replay-scoring';
import { createApp } from '../src/main';
import { bundleView, GroundedAnswer } from '../src/rec-frame/grounded-answer';
import { renderTemplateFrame } from '../src/rec-frame/render';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';
import { runTenantSpanning, withEvalSession } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'EvaluationReplayReads1761600000000';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SS = 'iot-platform-1';
const SIGNALS = ['coolant_temp', 'oil_pressure', 'fuel_level'];
const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-15T00:00:00.000Z');
const T1 = Date.parse('2026-10-05T08:00:00.000Z');
const T2 = Date.parse('2026-10-08T08:00:00.000Z');

/**
 * The recommendation replay (task QEVAL1c). QREC1's five steps and QREC2's template
 * renderer, re-run at past moments under the eval role. Every alert, work order and
 * reading is planted at a known time, so which moment sees what — and which work came
 * after it — is worked by hand.
 */
describeDb('evaluation: the recommendation replay', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let replay: RecommendationReplayService;
  let engine: RecEngineService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qeval1c';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qeval1c-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    replay = app.get(RecommendationReplayService);
    engine = app.get(RecEngineService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "eval_result", "eval_run", "rec_frame", "rec_evidence_bundle", "telemetry_reading", "signal_binding_version",
        "alert_event", "alert_rule", "work_order", "equipment_service_record", "incident",
        "client_equipment_class_recommendation", "client_equipment_class_failure_mode", "client_equipment_class",
        "equipment_profile", "equipment_class_sensor_requirement", "equipment_class_profile"
      RESTART IDENTITY CASCADE`);
    await owner.query(`INSERT INTO equipment_class_profile (slug, version, status, name, expected_signals)
      VALUES ('dg', 1, 'published', 'dg', $1::jsonb)`, [JSON.stringify(SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })))]);
    for (const s of SIGNALS) {
      await owner.query(`INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, forecast_enabled)
        VALUES ('dg', 1, $1, 'u', false)`, [s]);
    }
  });

  // ============================================================== fixtures
  const fixture = (fn: (m: EntityManager) => Promise<unknown>) => runTenantSpanning(owner, 'test fixture', fn);

  /** A classified machine with a library: overheat on coolant+oil (high), low_fuel on fuel (low). */
  const seedAccount = async (tenant = 'acme') => {
    await fixture(async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: tenant, slug: 'dg', name: 'dg', description: null, category: null,
        expectedSignals: SIGNALS.map((s) => ({ signal: s, unit: 'u', required: true })), failureModes: [], defaultThresholds: {},
        templateSlug: 'dg', templateVersion: 1, templateChecksum: 'c', copiedAt: FROM, status: 'active', updatedBy: 'u',
      });
      for (const [code, signals, severity] of [['overheat', ['coolant_temp', 'oil_pressure'], Severity.High],
        ['low_fuel', ['fuel_level'], Severity.Low]] as const) {
        await m.getRepository(ClientEquipmentClassFailureMode).save({
          tenantId: tenant, clientEquipmentClassSlug: 'dg', code, name: code, symptom: '', severity, signals: [...signals],
          templateVersion: 1, copiedAt: FROM,
        });
        await m.getRepository(ClientEquipmentClassRecommendation).save({
          tenantId: tenant, clientEquipmentClassSlug: 'dg', failureModeCode: code, action: `Check the ${code} path`, urgency: 'next_shift' as never,
          estimatedHours: null, requiredParts: [], templateVersion: 1, copiedAt: FROM,
        });
      }
    });
  };

  /** Bound from the start of the month, and reporting a minute before each of the moments the tests replay. */
  const seedMachine = async (externalId: string, tenant = 'acme') => {
    const imei = `imei-${tenant}-${externalId}`;
    await fixture(async (m) => {
      await m.getRepository(EquipmentProfile).save({
        tenantId: tenant, sourceSystem: SS, externalId, equipmentClassSlug: 'dg', classVersion: 1,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: externalId,
      });
      for (const s of SIGNALS) {
        await m.getRepository(SignalBindingVersion).save({
          tenantId: tenant, sourceSystem: SS, externalId, signalKey: s, measurementRole: s, componentId: '', origin: 'physical',
          imei, channel: s, sensorInstanceId: null, canonicalUnit: 'u', sourceUnit: null, validFrom: FROM,
          validTo: null, expectedPeriodSeconds: 60, isPrimary: true, status: 'active', discoveredFrom: null,
          discoveredBy: 'manual', approvedBy: 'u', approvedAt: FROM,
        });
      }
    });
    for (const at of [T1, T2, TO.getTime()]) {
      for (const s of SIGNALS) {
        await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
          VALUES ($1, $2, $3, 50, 'u', $4, $4, 'live')`, [tenant, imei, s, new Date(at - 60_000)]);
      }
    }
  };

  const seedAlert = async (externalId: string, signal: string, firedAt: number, resolvedAt: number | null = null, tenant = 'acme') => {
    const [rule] = await owner.query(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
      VALUES ($1, $2, 'Rule', 'signal-threshold', $3::jsonb, 'account', 'high', true) RETURNING id`,
    [tenant, `rule-${Math.random().toString(36).slice(2)}`, JSON.stringify({ signal, max: 100 })]);
    const [ev] = await owner.query(`INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary,
        evidence, state, fired_at, resolved_at, resolved_by, resolution_note)
      VALUES ($1, $2, 'Rule', $3, $4, 'high', 'x', '{}'::jsonb, $5, $6, $7, $8, $9) RETURNING id`,
    [tenant, rule.id, SS, externalId, resolvedAt ? 'resolved' : 'open', new Date(firedAt),
      resolvedAt ? new Date(resolvedAt) : null, resolvedAt ? 'u' : null, resolvedAt ? 'fixed' : null]);
    return ev.id as string;
  };

  /** A work order raised from an alert at `createdAt`, finished two hours later. */
  const seedCompletedWork = (externalId: string, alertId: string, createdAt: number, tenant = 'acme') => owner.query(
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, origin, raised_by, alert_id,
       started_at, ended_at, resolution, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Job', 'completed', 'normal', 'manual', 'u', $5, $6, $7, 'done', $6, $7)`,
    [tenant, `WO-${Math.random().toString(36).slice(2, 8)}`, SS, externalId, alertId, new Date(createdAt), new Date(createdAt + 2 * HOUR)]);

  const runRow = (id: string) => owner.query(`SELECT * FROM eval_run WHERE id = $1`, [id]).then((r) => r[0]);
  const results = (runId: string) => owner.query(
    `SELECT tenant_id, external_id, variant, metrics FROM eval_result WHERE run_id = $1 ORDER BY tenant_id, external_id, variant`, [runId]);
  const profile = (externalId: string) => runTenantSpanning(owner, 'test read', (m) =>
    m.getRepository(EquipmentProfile).findOneByOrFail({ tenantId: 'acme', sourceSystem: SS, externalId }));

  // ============================================================== G10, attempted

  it('1. an eval session cannot store a bundle or a frame, and a replay leaves both tables empty', async () => {
    await seedAccount(); await seedMachine('DG-1');
    await seedAlert('DG-1', 'coolant_temp', T1);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(
      `INSERT INTO rec_evidence_bundle (tenant_id, source_system, external_id, as_of, engine_version, inputs_hash, status,
         detect, attribute, precedent, gap, cost, candidates)
       VALUES ('acme', $1, 'DG-1', now(), 'x', 'h', 'ready', '{}', '{}', '{}', '{}', '{}', '[]')`, [SS],
    ))).rejects.toThrow(/permission denied for table rec_evidence_bundle/);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(
      `INSERT INTO rec_frame (id, tenant_id, bundle_id, renderer, renderer_version, validation, answer)
       VALUES (gen_random_uuid(), 'acme', gen_random_uuid(), 'template', 'x', 'refused', NULL)`,
    ))).rejects.toThrow(/permission denied for table rec_frame/);

    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    expect(s.status).toBe('completed');
    expect(await owner.query(`SELECT (SELECT count(*) FROM rec_evidence_bundle)::int AS b, (SELECT count(*) FROM rec_frame)::int AS f`))
      .toEqual([{ b: 0, f: 0 }]);
  });

  // ============================================================== as of a past moment

  it('2. a bundle as of a past moment sees the alert open then and nothing that came after', async () => {
    await seedAccount(); await seedMachine('DG-1');
    const later = await seedAlert('DG-1', 'fuel_level', T2);
    const resolvedSince = await seedAlert('DG-1', 'coolant_temp', T1, T1 + DAY);
    const p = await profile('DG-1');
    const at = await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, new Date(T1 + HOUR)));
    const v = bundleView(at);
    // Resolved today, open then: the replay must not read this morning's resolution backwards.
    expect(v.detect.entries.find((e) => e.signal === 'coolant_temp')!.state).toBe('anomalous');
    expect(JSON.stringify(v)).not.toContain(later);
    expect(JSON.stringify(v)).toContain(resolvedSince);
    // Before anything had happened: no history, said as such.
    const before = bundleView(await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, new Date(T1 - HOUR))));
    expect(before.precedent.modes.every((x) => x.state === 'no_history')).toBe(true);
    // Replaying one moment twice gives the same bundle.
    const again = await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, new Date(T1 + HOUR)));
    expect(again.id).toBe(at.id);
  });

  // ============================================================== measurement 1: grounding

  it('3. the template renderer\'s frames are grounded: no failure over a replay', async () => {
    await seedAccount(); await seedMachine('DG-1');
    const a = await seedAlert('DG-1', 'coolant_temp', T1);
    await seedCompletedWork('DG-1', a, T1 + HOUR);
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    const g = (await runRow(s.runId)).summary.grounding;
    expect(g).toMatchObject({ frames: 2, failed: 0, failureRate: 0, reason: null });
  });

  it('8. a number the bundle does not hold, and a library name it did not carry, are each a named grounding failure', async () => {
    await seedAccount(); await seedMachine('DG-1');
    await seedAlert('DG-1', 'coolant_temp', T1);
    const p = await profile('DG-1');
    const v = bundleView(await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, new Date(T1 + HOUR))));
    const frame = renderTemplateFrame(v);
    expect(grounding(frame, v, { names: ['overheat', 'coolant_temp', 'seal_leak'] })).toEqual([]);
    const planted: GroundedAnswer = { ...frame, summary: `${frame.summary} Seen 7 times before; see seal_leak.` };
    const failed = grounding(planted, v, { names: ['seal_leak'] });
    expect(failed).toContain('critic:3_numbers_trace');
    expect(failed).toContain('name_not_in_bundle:seal_leak');
  });

  it('9. a future-tense time with no forecast run is a grounding failure (D26)', async () => {
    await seedAccount(); await seedMachine('DG-1');
    await seedAlert('DG-1', 'coolant_temp', T1);
    const p = await profile('DG-1');
    const v = bundleView(await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, new Date(T1 + HOUR))));
    const frame = renderTemplateFrame(v);
    const planted: GroundedAnswer = { ...frame, summary: `${frame.summary} It will fail by 2026-12-01 10:00 UTC.` };
    expect(grounding(planted, v, { names: [] })).toContain('critic:4_no_future_number');
  });

  // ============================================================== measurement 2: coverage honesty

  it('10. a machine with no history: "No history to search" at every moment, no violation, and selection is insufficient_history', async () => {
    await seedAccount(); await seedMachine('DG-1');
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    const summary = (await runRow(s.runId)).summary;
    expect(summary.coverageHonesty).toMatchObject({ noHistoryMoments: 1, violations: 0, reason: null });
    expect(summary.selection).toMatchObject({ labelled: 0, rate: null, denominator: 0, reason: 'insufficient_history' });
    const [row] = (await results(s.runId)).filter((r: { variant: string }) => r.variant === 'replay');
    expect(row.metrics.selection).toMatchObject({ rate: null, reason: 'insufficient_history' });
  });

  it('10b. a frame that turns "no history" into "no similar cases occurred" is caught', async () => {
    await seedAccount(); await seedMachine('DG-1');
    const p = await profile('DG-1');
    const v = bundleView(await withEvalSession(ds, { tenantId: 'acme' }, (m) => engine.computeAsOf(m, 'acme', p, TO)));
    const frame = renderTemplateFrame(v);
    expect(coverageHonesty(frame, v)).toEqual([]);
    const lying: GroundedAnswer = {
      ...frame,
      observations: frame.observations.map((o) => ({ ...o, claim: o.claim.replace(/No history to search.*/, 'No similar cases occurred.') })),
      limitations: frame.limitations.map((l) => l.replace(/No history to search.*/, 'No similar cases occurred.')),
    };
    expect(coverageHonesty(lying, v).sort()).toEqual(['no_history_not_stated', 'says_occurred', 'says_similar']);
  });

  // ============================================================== measurement 3: selection against recorded work

  it('11. the selection agrees with the work that followed, counted with its denominator and never called accuracy', async () => {
    await seedAccount(); await seedMachine('DG-1');
    const a = await seedAlert('DG-1', 'fuel_level', T1);
    await seedCompletedWork('DG-1', a, T1 + HOUR);
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    const sel = (await runRow(s.runId)).summary.selection;
    // Two moments, T1 and the window's end; only T1 has work after it.
    expect(sel).toMatchObject({ labelled: 1, agreed: 1, disagreed: 0, noSelection: 0, rate: 1, denominator: 1, reason: null });
    expect(sel.label).toMatch(/agreement with recorded work — not accuracy/);
  });

  it('11b. a selection for another failure mode than the work done is a disagreement, worked by hand', async () => {
    await seedAccount(); await seedMachine('DG-1');
    // Coolant at T1 (no work); fuel at T2, worked on an hour later. At T1 the next work is
    // the fuel job, and the frame selects overheat: disagree. At T2 both are open and
    // overheat sorts first on severity: disagree again. The window's end has no work after it.
    await seedAlert('DG-1', 'coolant_temp', T1);
    const fuel = await seedAlert('DG-1', 'fuel_level', T2);
    await seedCompletedWork('DG-1', fuel, T2 + HOUR);
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    expect((await runRow(s.runId)).summary.selection).toMatchObject({ labelled: 2, agreed: 0, disagreed: 2, rate: 0, denominator: 2 });
  });

  // ============================================================== run behaviour

  it('12. a run over simulated telemetry is labelled seeded, even when asked to be real', async () => {
    await seedAccount(); await seedMachine('DG-1');
    await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      VALUES ('acme', 'sim', 'coolant_temp', 1, 'u', $1, $1, 'simulated')`, [new Date(T1)]);
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    const r = await runRow(s.runId);
    expect(r.dataset).toBe('seeded');
    expect(r.summary.claim).toMatch(/smoke test/);
  });

  it('13. a run that exhausts its budget says so, and lists the machines it did not reach', async () => {
    await seedAccount(); await seedMachine('DG-1'); await seedMachine('DG-2');
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO, budgetSeries: 1 });
    expect(s.status).toBe('budget_exhausted');
    expect((await runRow(s.runId)).unreached).toBe(1);
    expect((await results(s.runId)).filter((r: { variant: string }) => r.variant === 'unreached'))
      .toEqual([expect.objectContaining({ external_id: 'DG-2', metrics: { reason: 'budget_exhausted' } })]);
  });

  it('14. the run row holds aggregates only, and each account reads only its own per-machine rows', async () => {
    await seedAccount('acme'); await seedMachine('DG-1', 'acme');
    await seedAccount('globex'); await seedMachine('GX-9', 'globex');
    const s = await replay.run({ dataset: 'real', from: FROM, to: TO });
    expect(JSON.stringify(await runRow(s.runId))).not.toMatch(/DG-1|GX-9/);
    const own = await withEvalSession(ds, { tenantId: 'globex' }, (m) => m.query(`SELECT external_id FROM eval_result WHERE run_id = $1`, [s.runId]));
    expect(own).toEqual([{ external_id: 'GX-9' }]);
  });

  it('15. two replays fired together: both settle, one runs, one reports the lock held, results written once', async () => {
    await seedAccount(); await seedMachine('DG-1');
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const a = replay.run({ dataset: 'real', from: FROM, to: TO, onLocked: () => gate });
    const b = replay.run({ dataset: 'real', from: FROM, to: TO, onLocked: () => gate });
    void Promise.race([a, b]).then(() => open());
    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(settled.map((x) => (x as PromiseFulfilledResult<{ status: string }>).value.status).sort()).toEqual(['completed', 'lock_held']);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM eval_result WHERE variant = 'replay'`);
    expect(n).toBe(1);
  });

  // ============================================================== migration

  it('16. the down path revokes only the replay\'s reads; the backtest\'s grants stay', async () => {
    await seedAccount(); await seedMachine('DG-1');
    await replay.run({ dataset: 'real', from: FROM, to: TO });
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT has_table_privilege('ta_eval', 'incident', 'SELECT') AS i,
      has_table_privilege('ta_eval', 'work_order', 'SELECT') AS w`)).toEqual([{ i: false, w: true }]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM eval_run`))[0].n).toBeGreaterThan(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT has_table_privilege('ta_eval', 'incident', 'SELECT') AS i`)).toEqual([{ i: true }]);
  });
});
