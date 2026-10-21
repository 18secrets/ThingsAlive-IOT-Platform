import { DataSource, EntityManager } from 'typeorm';
import { describeRule, plainSignalName } from '../src/alert/services/alert-rule-render';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { ChainService } from '../src/intelligence/services/chain.service';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { TelemetryWindowReader } from '../src/kpi/services/telemetry-window-reader';
import { createLegacyDataSource } from '../src/legacy/legacy-source';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { ArtifactEmitter, EmitterRegistry, ReplayPlan } from '../src/proposal/emitter';
import { PREDICTION_IS_NOT_A_KIND, PROPOSAL_KINDS, REPLAY_WINDOW_DAYS } from '../src/proposal/proposal-kinds';
import { ProposalService, ProposalView } from '../src/proposal/proposal.service';
import { ReplayService } from '../src/proposal/replay.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { compileWorkflow, WorkflowSpec, WorkflowSpecError } from '../src/workflow/workflow-spec';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { createAppDataSource, createTestDataSource, describeDb, TEST_DB, undoMigrationNamed } from './db';
import { bindProjectedDevice } from './bind-projected-devices';

const SS = 'ta-2.0';
const COOLANT = 'engine_coolant_temperature';
const DAY = 86_400_000;

/** Coolant above `max` on `externalId`, 6 of the last 10 readings. */
const coolantSpec = (externalId = 'GEN-1', max = 105): WorkflowSpec => ({
  kind: 'alert',
  scope: { appliesTo: 'equipment', sourceSystem: SS, externalId },
  nodes: [
    { id: 'sig', type: 'ReadSignal', params: { signal: COOLANT } },
    { id: 'hot', type: 'Threshold', params: { max, lookbackReadings: 10, requiredBreaches: 6 } },
    { id: 'tell', type: 'Notify', params: { name: 'Coolant hot', severity: 'high' } },
  ],
  edges: [{ from: 'sig', to: 'hot' }, { from: 'hot', to: 'tell' }],
});

/**
 * The test-only workflow emitter (§6): enough of QGEN3's shape to drive the substrate —
 * pin the bindings the spec reads, compile with QWF1's compiler, hand the substrate a
 * replay plan, and materialise a generated workflow whose rules are off when the draft
 * is unvalidated. Not QGEN3: no assembly, no intents.
 */
function workflowEmitter(): ArtifactEmitter<'workflow'> & { materialised: number } {
  return {
    kind: 'workflow', version: 'test-1', materialised: 0,
    async emit(seed, ctx) {
      const spec = seed.spec as WorkflowSpec;
      const bindings = spec.scope.externalId ? await ctx.m.query(
        `SELECT id, signal_key AS "signalKey", source_system AS "sourceSystem", external_id AS "externalId"
           FROM signal_binding_version
          WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3 AND status = 'active' AND is_primary AND valid_to IS NULL
          ORDER BY signal_key`,
        [ctx.scope.tenantId, spec.scope.sourceSystem, spec.scope.externalId],
      ) : [];
      return { status: 'proposed', payload: { spec }, target: { ...spec.scope }, targetVersions: { bindings } };
    },
    async compile(payload) {
      try {
        const compiled = compileWorkflow(payload.spec);
        const plan: ReplayPlan = {
          compilerVersion: 'qwf1',
          machines: compiled.scope.externalId ? [{ sourceSystem: compiled.scope.sourceSystem!, externalId: compiled.scope.externalId }] : [],
          rules: compiled.rules.map((r) => ({ name: r.name, trigger: r.trigger, params: r.params, signals: r.signals })),
        };
        return { ok: true, result: { graphHash: compiled.graphHash, rules: compiled.rules.length }, replay: plan };
      } catch (err) {
        if (err instanceof WorkflowSpecError) return { ok: false, message: err.message };
        throw err;
      }
    },
    async render(payload) {
      return compileWorkflow(payload.spec).rules.map((r) => describeRule(r, plainSignalName));
    },
    async materialise(payload, ctx, m) {
      this.materialised += 1;
      const compiled = compileWorkflow(payload.spec);
      const [def] = await m.query(
        `INSERT INTO workflow_definition (tenant_id, slug, name, kind, created_by) VALUES ($1, $2, 'Generated', 'alert', $3) RETURNING id`,
        [ctx.scope.tenantId, `gen-${ctx.proposal.id.slice(0, 8)}`, ctx.scope.userId],
      );
      const [version] = await m.query(
        `INSERT INTO workflow_version (tenant_id, workflow_id, version, spec, graph_hash, status, source, proposal_id, published_by, published_at)
           VALUES ($1, $2, 1, $3, $4, 'published', 'generated', $5, $6, $7) RETURNING id`,
        [ctx.scope.tenantId, def.id, payload.spec, compiled.graphHash, ctx.proposal.id, ctx.scope.userId, ctx.at],
      );
      const ruleIds: string[] = [];
      for (const [i, r] of compiled.rules.entries()) {
        const [rule] = await m.query(
          `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, severity, applies_to, source_system, external_id, enabled,
             compiled_from_workflow_id, compiled_from_version_id, graph_hash)
           VALUES ($1, $2, $3, $4, $5, $6, 'equipment', $7, $8, $9, $10, $11, $12) RETURNING id`,
          [ctx.scope.tenantId, `gen-${ctx.proposal.id.slice(0, 8)}-${i + 1}`, r.name, r.trigger, r.params, r.severity,
            compiled.scope.sourceSystem, compiled.scope.externalId, !ctx.unvalidated, def.id, version.id, compiled.graphHash],
        );
        ruleIds.push(rule.id);
      }
      return { workflowId: def.id, versionId: version.id, ruleIds };
    },
  };
}

/** The test-only KPI emitter: a kind that does not fire, and a compiler that can refuse. */
function kpiEmitter(): ArtifactEmitter<'kpi'> & { materialised: number } {
  return {
    kind: 'kpi', version: 'test-1', materialised: 0,
    async emit(seed) {
      if (!seed.expression) return { status: 'needs_input', missing: [{ field: 'expression', reason: 'required', detail: 'Pick a measurement.' }] };
      return { status: 'proposed', payload: { expression: seed.expression }, target: { class: 'genset' }, targetVersions: {} };
    },
    async compile(payload) {
      return payload.expression === 'nonsense()'
        ? { ok: false, message: 'Unknown operator "nonsense".' }
        : { ok: true, result: { compiled: payload.expression } };
    },
    async render(payload) { return [`KPI ${String(payload.expression)}`]; },
    async materialise() { this.materialised += 1; return { formula: 'f-1' }; },
  };
}

describe('artifact proposals: the registry', () => {
  it('19. every kind has exactly one emitter, prediction is not a kind, and a second registration is refused', () => {
    expect(PREDICTION_IS_NOT_A_KIND).toBe(true);
    expect(PROPOSAL_KINDS).toEqual(['kpi', 'workflow']);
    const registry = new EmitterRegistry();
    expect(registry.missing()).toEqual(['kpi', 'workflow']);
    registry.register(kpiEmitter());
    registry.register(workflowEmitter());
    expect(registry.missing()).toEqual([]);
    expect(() => registry.register(kpiEmitter())).toThrow('already registered');
    expect(() => registry.register({ ...kpiEmitter(), kind: 'prediction' } as never)).toThrow('"prediction" is not a proposal kind');
  });
});

describeDb('artifact proposals: the substrate, the gate and replay', () => {
  let owner: DataSource;
  let ds: DataSource;
  let proposals: ProposalService;
  let replays: ReplayService;
  let wfEmitter: ReturnType<typeof workflowEmitter>;
  let kEmitter: ReturnType<typeof kpiEmitter>;
  const bound = process.env.PROPOSAL_REPLAY_MAX_FIRES;

  const NOW = new Date('2026-10-19T00:00:00.000Z');
  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const admin: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };
  let keys = 0;
  const key = () => `k-${(keys += 1)}`;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (const month of ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']) {
      await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    }
    ds = await createAppDataSource();
    replays = new ReplayService(ds);
  }, 60_000);

  afterAll(async () => {
    if (bound === undefined) delete process.env.PROPOSAL_REPLAY_MAX_FIRES; else process.env.PROPOSAL_REPLAY_MAX_FIRES = bound;
    await ds?.destroy(); await owner?.destroy();
  });

  /**
   * acme: a genset class copy; GEN-1 with coolant bound to IMEI-1 and a daily 06:00–14:00
   * UTC shift; GEN-2 with nothing. No telemetry: each test seeds the history it means.
   */
  beforeEach(async () => {
    delete process.env.PROPOSAL_REPLAY_MAX_FIRES;
    await owner.query(`
      TRUNCATE TABLE "proposal_rule_enablement", "replay_run", "alert_event", "alert_rule", "workflow_layout", "workflow_version",
        "workflow_definition", "artifact_proposal", "signal_binding_version", "telemetry_reading", "equipment_shift",
        "client_equipment_class", "equipment_profile" CASCADE`);
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals, template_version, template_checksum)
         VALUES ('acme', 'genset', 'Genset', $1::jsonb, 1, 'c')`,
      [JSON.stringify([{ signal: COOLANT, unit: 'degC', required: true }])],
    );
    for (const id of ['GEN-1', 'GEN-2']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, origin, status, tier, readiness)
           VALUES ('acme', $1, $2, $2, 'genset', 'client', 'active', 'basic', '{}'::jsonb)`, [SS, id],
      );
    }
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', $1, 'GEN-1', $2, $2, '', 'physical', 'IMEI-1', 'ch1', 'degC', '2026-01-01', NULL, true, 'active', 'manual', 'u', '2026-01-01')`,
      [SS, COOLANT],
    );
    await owner.query(
      `INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone)
         VALUES ('acme', $1, 'GEN-1', 'Day', 360, 840, '{0,1,2,3,4,5,6}', 'UTC')`, [SS],
    );
    const registry = new EmitterRegistry();
    wfEmitter = workflowEmitter();
    kEmitter = kpiEmitter();
    registry.register(wfEmitter);
    registry.register(kEmitter);
    proposals = new ProposalService(ds, registry, replays);
  });

  /** `perDay` readings of coolant at `value` on each of the `days` days before NOW, inside the shift. */
  const seed = (days: number, perDay: number, value: number, firstDay = 1) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
     SELECT 'acme', 'IMEI-1', $1, $2, ts, ts, 'live' FROM (
       SELECT $3::timestamptz - make_interval(days => d) + interval '8 hours' + make_interval(mins => k) AS ts
         FROM generate_series($4::int, $4::int + $5::int - 1) d, generate_series(0, $6::int - 1) k) x`,
    [COOLANT, value, NOW, firstDay, days, perDay],
  );

  const proposeWorkflow = (spec = coolantSpec(), scope = boss, idem = key()) =>
    proposals.propose(scope, { kind: 'workflow', seed: { spec }, idempotencyKey: idem }, NOW) as Promise<ProposalView>;
  const asApp = <R>(tenant: string, fn: (m: EntityManager) => Promise<R>) => withTenantId(ds, tenant, fn);
  const count = async (table: string) => (await owner.query(`SELECT count(*)::int AS n FROM "${table}"`))[0].n as number;

  it('1. the database refuses a proposal of kind prediction', async () => {
    await expect(asApp('acme', (m) => m.query(
      `INSERT INTO artifact_proposal (tenant_id, kind, seed, target, target_versions, payload, proposal_hash, idempotency_key,
         emitter_kind, emitter_version, expires_at, proposed_by)
       VALUES ('acme', 'prediction', '{}', '{}', '{}', '{}', 'h', 'x', 'e', '1', now(), 'u')`,
    ))).rejects.toThrow(/ck_artifact_proposal_kind/);
    await expect(proposals.propose(boss, { kind: 'prediction', seed: {}, idempotencyKey: key() }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('D26') });
  });

  it('2 and 3. a proposal\'s payload cannot be edited, and rejected cannot become approved', async () => {
    const p = await proposals.propose(boss, { kind: 'kpi', seed: { expression: 'avg(x)' }, idempotencyKey: key() }) as ProposalView;
    await expect(asApp('acme', (m) => m.query(`UPDATE artifact_proposal SET payload = '{"expression":"max(x)"}' WHERE id = $1`, [p.id])))
      .rejects.toThrow(/cannot change its content/);
    await proposals.reject(boss, p.id, 'not this one');
    await expect(asApp('acme', (m) => m.query(
      `UPDATE artifact_proposal SET status = 'approved', approved_by = 'u', approved_at = now() WHERE id = $1`, [p.id],
    ))).rejects.toThrow(/cannot move from rejected to approved/);
  });

  it('4 and 5. a refused gate cannot be approved, and a workflow cannot skip replay — refused by the database', async () => {
    const insert = (status: string, kind: string, outcome: string) => asApp('acme', (m) => m.query(
      `INSERT INTO artifact_proposal (tenant_id, kind, status, seed, target, target_versions, payload, proposal_hash, idempotency_key,
         emitter_kind, emitter_version, expires_at, proposed_by, gate_outcome, approved_by, approved_at)
       VALUES ('acme', $1, $2, '{}', '{}', '{}', '{}', 'h', $4, 'e', '1', now(), 'u', $3,
         CASE WHEN $2 = 'approved' THEN 'u' END, CASE WHEN $2 = 'approved' THEN now() END)`,
      [kind, status, outcome, key()],
    ));
    await expect(insert('approved', 'workflow', 'refuse')).rejects.toThrow(/ck_artifact_proposal_approvable/);
    await expect(insert('draft_ready', 'workflow', 'not_applicable')).rejects.toThrow(/ck_artifact_proposal_not_applicable/);

    // And through the trigger: a gate_refused proposal moved to approved.
    await seed(20, 15, 110);
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '3';
    const noisy = await proposeWorkflow();
    expect(noisy).toMatchObject({ status: 'gate_refused', gateOutcome: 'refuse' });
    await expect(asApp('acme', (m) => m.query(
      `UPDATE artifact_proposal SET status = 'approved', approved_by = 'u', approved_at = now() WHERE id = $1`, [noisy.id],
    ))).rejects.toThrow(/ck_artifact_proposal_approvable|cannot move from gate_refused/);
    await expect(proposals.approve(boss, noisy.id, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it('6. two emits with one idempotency key at once both settle on one proposal', async () => {
    const idem = key();
    const results = await Promise.allSettled([proposeWorkflow(coolantSpec(), boss, idem), proposeWorkflow(coolantSpec(), boss, idem)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<ProposalView>).value);
    expect(a.id).toBe(b.id);
    expect(await count('artifact_proposal')).toBe(1);
    expect(await count('replay_run')).toBe(1);
  });

  it('7. two approvals at once both settle; one workflow is materialised and its ref is written once', async () => {
    const p = await proposeWorkflow();
    expect(p.gateOutcome).toBe('insufficient_history');
    const results = await Promise.allSettled([proposals.approve(boss, p.id, NOW), proposals.approve(boss, p.id, NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(wfEmitter.materialised).toBe(1);
    expect(await count('workflow_definition')).toBe(1);
    const [row] = await owner.query(`SELECT status, materialised_ref FROM artifact_proposal WHERE id = $1`, [p.id]);
    expect(row.status).toBe('materialised');
    expect(row.materialised_ref.ruleIds).toHaveLength(1);
  });

  it('8. a compile refusal keeps the compiler\'s own message, stops there, and nothing is materialised', async () => {
    const p = await proposals.propose(boss, { kind: 'kpi', seed: { expression: 'nonsense()' }, idempotencyKey: key() }) as ProposalView;
    expect(p).toMatchObject({ status: 'compile_refused', readiness: 'blocked', reason: 'compile_refused', sentence: 'Unknown operator "nonsense".' });
    expect(p.compileResult).toEqual({ refused: true, message: 'Unknown operator "nonsense".' });
    expect(p.gateOutcome).toBeNull();
    await expect(proposals.approve(boss, p.id, NOW)).rejects.toMatchObject({ status: 409 });
    expect(kEmitter.materialised).toBe(0);

    const spec = coolantSpec();
    spec.nodes[1].params = { condition: 'coolant > 105' };
    const wf = await proposeWorkflow(spec);
    expect(wf).toMatchObject({ status: 'compile_refused', compileResult: { message: 'Node "hot" (Threshold) has no parameter "condition".' } });
    expect(await count('replay_run')).toBe(0);
  });

  it('9. the D28 floor: 13 days, or 199 readings, is insufficient_history naming the signal; 14 days and 200 are replayed', async () => {
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '100';
    await seed(13, 20, 90);
    const thirteen = await proposeWorkflow();
    expect(thirteen.gateOutcome).toBe('insufficient_history');
    expect(thirteen.gateDetail!.reason).toContain(`${COOLANT} has 260 reading(s) over 13 day(s)`);

    await owner.query(`TRUNCATE telemetry_reading`);
    await seed(13, 14, 90);
    await seed(1, 17, 90, 14);
    const short = await proposeWorkflow();
    expect(short.gateOutcome).toBe('insufficient_history');
    expect(short.gateDetail!.reason).toContain(`${COOLANT} has 199 reading(s) over 14 day(s)`);

    await seed(1, 1, 90, 20);
    const enough = await proposeWorkflow();
    expect(enough.gateOutcome).toBe('pass');
    expect((enough.gateDetail!.machines as { signals: { readings: number; days: number }[] }[])[0].signals[0])
      .toMatchObject({ readings: 200, days: 15 });
  });

  it('10. zero history is insufficient_history, never pass — labelled, and blocked for enabling', async () => {
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '100';
    const p = await proposeWorkflow();
    expect(p).toMatchObject({ status: 'draft_ready', gateOutcome: 'insufficient_history', unvalidated: true, readiness: 'blocked', reason: 'insufficient_history' });
    expect(p.gateOutcome).not.toBe('pass');
    expect(p.sentence).toMatch(/^Unvalidated: /);
    expect(p.replayRuns![0]).toMatchObject({ outcome: 'insufficient_history', fires: 0 });
  });

  it('11. above the bound refuses, within it passes; with no bound named, enough history refuses with that reason', async () => {
    await seed(20, 15, 110);
    const unbounded = await proposeWorkflow();
    expect(unbounded).toMatchObject({ status: 'gate_refused', gateOutcome: 'refuse' });
    expect(unbounded.gateDetail!.reason).toMatch(/^replay_bound_not_set: 20 fire\(s\) over \d+ evaluated shift window\(s\)/);

    process.env.PROPOSAL_REPLAY_MAX_FIRES = '19';
    expect((await proposeWorkflow()).gateOutcome).toBe('refuse');
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '20';
    const within = await proposeWorkflow();
    expect(within).toMatchObject({ status: 'draft_ready', gateOutcome: 'pass', readiness: 'ready' });
    const run = await proposals.replayRun(boss, within.id, within.replayRuns![0].id);
    expect(run.fires).toBe(20);
    expect((run.firesDetail as { windows: { summary: string }[] }).windows[0].summary).toContain(`${COOLANT} breached 105`);
  });

  it('12. replay never touches production, and a write inside its transaction is refused by PostgreSQL', async () => {
    await seed(30, 15, 110);
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '1000';
    const tables = ['alert_event', 'domain_event', 'work_order', 'prediction_baseline'];
    const before = await Promise.all(tables.map(count));
    const p = await proposeWorkflow();
    expect(p.replayRuns![0].fires).toBe(30);
    expect(await Promise.all(tables.map(count))).toEqual(before);

    await expect(replays.readOnly('acme', (m) => m.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('acme', gen_random_uuid(), 'x', 'x', 'x', 'high', 'x', '{}', 'open', now())`,
    ))).rejects.toThrow(/read-only transaction/);
  });

  it('14. the replay read touches only partitions inside its 90 days', async () => {
    const from = new Date(NOW.getTime() - REPLAY_WINDOW_DAYS * DAY);
    const { partitions } = await replays.readOnly('acme', (m) => new TelemetryWindowReader().explainSegmentRows(
      m, 'acme', [{ signal: COOLANT, imei: 'IMEI-1', from: new Date('2026-01-01'), to: null }], from, NOW,
    ));
    expect(partitions).toEqual(['2026_07', '2026_08', '2026_09', '2026_10']);
  });

  it('15. an unvalidated approval materialises its rules off; switching one on directly is refused; through the proposal it is recorded', async () => {
    const p = await proposeWorkflow();
    const done = await proposals.approve(boss, p.id, NOW);
    const ruleId = (done.materialisedRef!.ruleIds as string[])[0];
    expect(await owner.query(`SELECT enabled FROM alert_rule WHERE id = $1`, [ruleId])).toEqual([{ enabled: false }]);

    await expect(asApp('acme', (m) => m.query(`UPDATE alert_rule SET enabled = true WHERE id = $1`, [ruleId])))
      .rejects.toThrow(/without enough history to replay/);
    await expect(new AlertService(ds).setEnabled(boss, ruleId, true)).rejects.toThrow(/without enough history/);
    const [rule] = await owner.query(`SELECT compiled_from_workflow_id AS w, compiled_from_version_id AS v, graph_hash AS h FROM alert_rule WHERE id = $1`, [ruleId]);
    await expect(asApp('acme', (m) => m.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, enabled, compiled_from_workflow_id, compiled_from_version_id, graph_hash)
         VALUES ('acme', 'sneak', 'Sneak', 'signal-threshold', $1, true, $2, $3, $4)`,
      [{ signal: COOLANT, max: 1 }, rule.w, rule.v, rule.h],
    ))).rejects.toThrow(/without enough history to replay/);

    // Question 8, and idempotent: two at once, one record.
    await expect(proposals.enableRule(admin, p.id, ruleId, NOW)).resolves.toMatchObject({ enabled: true, enabledBy: 'u-admin' });
    const again = await Promise.allSettled([proposals.enableRule(boss, p.id, ruleId, NOW), proposals.enableRule(boss, p.id, ruleId, NOW)]);
    expect(again.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT enabled_by, history->'machines'->0->'signals'->0->>'readings' AS readings FROM proposal_rule_enablement`))
      .toEqual([{ enabled_by: 'u-admin', readings: '0' }]);
    expect(await owner.query(`SELECT enabled FROM alert_rule WHERE id = $1`, [ruleId])).toEqual([{ enabled: true }]);
    await expect(asApp('acme', (m) => m.query(`DELETE FROM proposal_rule_enablement`))).rejects.toThrow(/permission denied|append-only/);
  });

  it('16. a binding changed under the target since the gate: approval is 409 naming it, and the proposal stays draft_ready', async () => {
    const p = await proposeWorkflow();
    await owner.query(`UPDATE signal_binding_version SET valid_to = $1 WHERE external_id = 'GEN-1'`, [NOW]);
    await expect(proposals.approve(boss, p.id, NOW)).rejects.toMatchObject({
      status: 409, response: { reason: 'stale_version', message: expect.stringContaining(`signal "${COOLANT}" on GEN-1`) },
    });
    expect((await proposals.get(boss, p.id, NOW)).status).toBe('draft_ready');
  });

  it('17. approval after expiry is 409 with no background job, and the draft reads as expired', async () => {
    const p = await proposeWorkflow();
    const later = new Date(NOW.getTime() + 2 * DAY);
    await expect(proposals.approve(boss, p.id, later)).rejects.toMatchObject({ status: 409, response: { reason: 'expired' } });
    expect(await proposals.get(boss, p.id, later)).toMatchObject({ status: 'draft_ready', expired: true, readiness: 'blocked', reason: 'expired' });
  });

  it('18. a role without proposal.approve is 403; a class-scope proposal is refused at approval with its reason', async () => {
    const p = await proposeWorkflow();
    await expect(proposals.approve(admin, p.id, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(proposals.reject(admin, p.id, null, NOW)).rejects.toMatchObject({ status: 403 });
    const cls = await proposals.propose(boss, { kind: 'kpi', scope: 'class', seed: { expression: 'avg(x)' }, idempotencyKey: key() }, NOW) as ProposalView;
    expect(cls).toMatchObject({ scope: 'class', status: 'draft_ready', gateOutcome: 'not_applicable' });
    await expect(proposals.approve(boss, cls.id, NOW)).rejects.toMatchObject({ status: 409, response: { reason: 'class_scope_undecided' } });
  });

  it('a KPI is not_applicable for replay, approves through its emitter, and rejecting twice at once records one rejection', async () => {
    const kpi = await proposals.propose(boss, { kind: 'kpi', seed: { expression: 'avg(x)' }, idempotencyKey: key() }, NOW) as ProposalView;
    expect(kpi).toMatchObject({ gateOutcome: 'not_applicable', readiness: 'ready', rendering: ['KPI avg(x)'] });
    expect(await count('replay_run')).toBe(0);
    expect((await proposals.approve(boss, kpi.id, NOW)).materialisedRef).toEqual({ formula: 'f-1' });

    const other = await proposals.propose(boss, { kind: 'kpi', seed: { expression: 'max(x)' }, idempotencyKey: key() }, NOW) as ProposalView;
    const results = await Promise.allSettled([proposals.reject(boss, other.id, 'no', NOW), proposals.reject(boss, other.id, 'no', NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT status, rejected_by FROM artifact_proposal WHERE id = $1`, [other.id])).toEqual([{ status: 'rejected', rejected_by: 'u-boss' }]);

    expect(await proposals.propose(boss, { kind: 'kpi', seed: {}, idempotencyKey: key() }, NOW)).toEqual({
      status: 'needs_input', missing: [{ field: 'expression', reason: 'required', detail: 'Pick a measurement.' }],
    });
  });

  it('a rule that reads predictions is not replayed, and says so rather than reporting zero fires as clean', async () => {
    await seed(20, 15, 90);
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '100';
    const spec: WorkflowSpec = {
      kind: 'alert', scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
      nodes: [
        { id: 'ps', type: 'PredictionSeverity', params: { atLeast: 'high' } },
        { id: 'tell', type: 'Notify', params: { name: 'Predicted', severity: 'high' } },
      ],
      edges: [{ from: 'ps', to: 'tell' }],
    };
    const p = await proposeWorkflow(spec);
    expect(p.gateOutcome).toBe('insufficient_history');
    expect(p.gateDetail!.reason).toContain('the scorer\'s predictions');
  });

  it('20. another account can neither list, read nor see the replay runs of a proposal', async () => {
    const p = await proposeWorkflow();
    expect(await proposals.list(globex)).toEqual([]);
    await expect(proposals.get(globex, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(proposals.replayRun(globex, p.id, p.replayRuns![0].id)).rejects.toMatchObject({ status: 404 });
    await expect(proposals.approve(globex, p.id, NOW)).rejects.toMatchObject({ status: 404 });
    expect(await asApp('globex', (m) => m.query(`SELECT count(*)::int AS n FROM replay_run`))).toEqual([{ n: 0 }]);
    expect(await asApp('globex', (m) => m.query(`SELECT count(*)::int AS n FROM artifact_proposal`))).toEqual([{ n: 0 }]);
  });

  // Last: it takes the schema down past this migration and back up.
  it('21. ArtifactProposal1761800000000 down removes both tables and leaves workflow_version.proposal_id intact, keyless', async () => {
    const p = await proposeWorkflow();
    const done = await proposals.approve(boss, p.id, NOW);
    await undoMigrationNamed(owner, 'ArtifactProposal1761800000000');
    expect(await owner.query(`SELECT to_regclass('artifact_proposal') AS a, to_regclass('replay_run') AS b, to_regclass('proposal_rule_enablement') AS c`))
      .toEqual([{ a: null, b: null, c: null }]);
    expect(await owner.query(`SELECT proposal_id FROM workflow_version WHERE id = $1`, [done.materialisedRef!.versionId]))
      .toEqual([{ proposal_id: p.id }]);
    expect(await owner.query(`SELECT conname FROM pg_constraint WHERE conname = 'fk_workflow_version_proposal'`)).toEqual([]);

    // Up again over that history: the version keeps the id it was published with, and a
    // new row naming a proposal that does not exist is still refused.
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT proposal_id FROM workflow_version WHERE id = $1`, [done.materialisedRef!.versionId]))
      .toEqual([{ proposal_id: p.id }]);
    await expect(owner.query(
      `INSERT INTO workflow_version (tenant_id, workflow_id, version, spec, graph_hash, source, proposal_id)
         SELECT tenant_id, workflow_id, 2, spec, graph_hash, 'generated', gen_random_uuid() FROM workflow_version WHERE id = $1`,
      [done.materialisedRef!.versionId],
    )).rejects.toThrow(/fk_workflow_version_proposal/);
  });
});

/**
 * 13. Replay matches production: the shift runner raises an alert over a window, and the
 * replay of the same rule over the same window fires once with the same summary and
 * evidence. The runner is the real one, reading a stood-up copy of the existing
 * platform's table as `shift-runner.spec.ts` does.
 */
describeDb('artifact proposals: replay matches the shift runner', () => {
  let owner: DataSource;
  let ds: DataSource;
  let legacy: DataSource;
  const NOW = new Date('2026-09-14T09:00:00.000Z');
  const IMEI = '860123456789012';
  const ASSET = 'DG-7';
  const MEASUREMENT_ID = '90210';
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'prediction.run', 'alert.author'],
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`
      CREATE TABLE "device_sensor_measurement_logs" (
        "id" bigserial PRIMARY KEY, "device_sensor_measurement_id" bigint NOT NULL,
        "timestamp" timestamptz NOT NULL, "value" double precision NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now())`);
    await owner.query(`GRANT SELECT ON "device_sensor_measurement_logs" TO "ta_app"`);
    ds = await createAppDataSource();
    legacy = createLegacyDataSource({
      host: TEST_DB.DB_HOST, port: Number(TEST_DB.DB_PORT), username: TEST_DB.DB_USERNAME,
      password: TEST_DB.DB_PASSWORD, database: TEST_DB.DB_DATABASE, schema: 'public',
    });
    await legacy.initialize();
  }, 60_000);

  afterAll(async () => {
    await legacy?.destroy(); await ds?.destroy();
    await owner?.query(`DROP TABLE IF EXISTS "device_sensor_measurement_logs"`);
    await owner?.destroy();
  });

  it('13. the same rule over the same window: one fire, the same summary, the same evidence', async () => {
    const plant = await new PlantService(ds).create(boss, { code: 'NORTH', name: 'Northern yard' });
    await new EquipmentService(ds).create(boss, { code: ASSET, name: 'Generator 7', plantId: plant.id });
    const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: ASSET };
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(DeviceProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'dev-1', checksum: 'c', imei: IMEI,
        equipmentExternalId: ASSET, name: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
      });
      await bindProjectedDevice(m, { tenantId: 'acme', ...ref, imei: IMEI });
      await m.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
           origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
         VALUES ('acme', $1, $2, 'coolant_temp', 'coolant_temp', '', 'physical', $3, 'ch1', 'degC', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
        [CLIENT_SOURCE_SYSTEM, ASSET, IMEI],
      );
      await m.getRepository(SensorMapProjection).save({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: MEASUREMENT_ID, checksum: 'c', imei: IMEI,
        signal: 'coolant_temp', sensorName: 'Coolant', unit: 'degC', payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW,
        status: 'live' as const,
      });
    });
    for (const [at, value] of [['2026-09-14T06:00:00Z', 140], ['2026-09-14T07:00:00Z', 95], ['2026-09-14T08:00:00Z', 150]] as const) {
      await owner.query(
        `INSERT INTO device_sensor_measurement_logs (device_sensor_measurement_id, "timestamp", value, created_at) VALUES ($1, $2, $3, $2)`,
        [MEASUREMENT_ID, at, value],
      );
    }
    const params = { signal: 'coolant_temp', max: 100, lookbackReadings: 3, requiredBreaches: 2 };
    const alerts = new AlertService(ds);
    await alerts.createRule(boss, { slug: 'coolant', name: 'Coolant hot', trigger: 'signal-threshold', params } as never);
    const shifts = new ShiftService(ds);
    await shifts.create(boss, ref, { name: 'A', startMinute: 360, endMinute: 840, days: [0, 1, 2, 3, 4, 5, 6] as never, timeZone: 'Asia/Kolkata' });

    const runner = new ShiftRunner(
      ds, shifts, new LegacyTelemetryReader(ds, legacy), new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), alerts, new UtilizationService(ds),
      new DeviceHealthService(ds), new ChainService(ds),
    );
    expect((await runner.run(NOW)).outcomes[0].alerts).toBe(1);
    const [event] = await owner.query(`SELECT summary, evidence, window_start, window_end FROM alert_event`);

    const [run] = await new ReplayService(ds).replay('acme', {
      compilerVersion: 'qwf1', machines: [ref],
      rules: [{ name: 'Coolant hot', trigger: 'signal-threshold', params, signals: ['coolant_temp'] }],
    }, NOW);
    expect(run.fires).toBe(1);
    expect(run.firesDetail.windows[0]).toMatchObject({
      window: { start: new Date(event.window_start).toISOString(), end: new Date(event.window_end).toISOString() },
      summary: event.summary,
      evidence: event.evidence,
    });
  });
});
