import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { RuleDto } from '../src/alert/alert.controller';
import { describeRule, RULE_CLAUSES } from '../src/alert/services/alert-rule-render';
import {
  ALERT_TRIGGERS, describeSignalThresholdRule, evaluateRule, validateParams, WindowReading,
} from '../src/alert/services/alert-rules';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { withTenantId } from '../src/scope/tenant-session';
import {
  compileWorkflow, MAX_WORKFLOW_DEPTH, MAX_WORKFLOW_NODES, NODE_REGISTRY, WORKFLOW_NODE_TYPES, WorkflowSpec,
} from '../src/workflow/workflow-spec';
import { WorkflowService } from '../src/workflow/workflow.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SS = 'ta-2.0';
const COOLANT = 'engine_coolant_temperature';
const OIL = 'engine_oil_pressure';

/** A one-threshold workflow: coolant above `max` on GEN-1. */
const thresholdSpec = (max = 105, scope: Partial<WorkflowSpec['scope']> = {}, extra: Record<string, unknown> = {}): WorkflowSpec => ({
  kind: 'alert',
  scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1', ...scope } as WorkflowSpec['scope'],
  nodes: [
    { id: 'sig', type: 'ReadSignal', params: { signal: COOLANT } },
    { id: 'hot', type: 'Threshold', params: { max, lookbackReadings: 10, requiredBreaches: 6, ...extra } },
    { id: 'tell', type: 'Notify', params: { name: 'Coolant hot', severity: Severity.High } },
  ],
  edges: [{ from: 'sig', to: 'hot' }, { from: 'hot', to: 'tell' }],
});

/** Coolant AND oil, or coolant OR oil, each leaf with its own M-of-N. */
const compositeSpec = (op: 'AllOf' | 'AnyOf', scope: Partial<WorkflowSpec['scope']> = {}): WorkflowSpec => ({
  kind: 'alert',
  scope: { appliesTo: 'equipment-class', equipmentClassSlug: 'genset', ...scope } as WorkflowSpec['scope'],
  nodes: [
    { id: 's1', type: 'ReadSignal', params: { signal: COOLANT } },
    { id: 't1', type: 'Threshold', params: { max: 105, lookbackReadings: 10, requiredBreaches: 6 } },
    { id: 's2', type: 'ReadSignal', params: { signal: OIL } },
    { id: 't2', type: 'Threshold', params: { min: 150, lookbackReadings: 10, requiredBreaches: 3 } },
    { id: 'both', type: op },
    { id: 'tell', type: 'Notify', params: { name: 'Engine distress', severity: Severity.Critical } },
  ],
  edges: [
    { from: 's1', to: 't1' }, { from: 's2', to: 't2' }, { from: 't1', to: 'both' }, { from: 't2', to: 'both' },
    { from: 'both', to: 'tell' },
  ],
});

const readings = (signal: string, values: number[]): WindowReading[] => values.map((value, i) => ({
  signal, value, imei: 'IMEI-1', sourceTimestamp: new Date(Date.UTC(2026, 9, 19, 8, 0, i)).toISOString(),
}));

/**
 * The workflow compiler (task QWF1, D16, D18). A workflow is how a person draws an
 * alert; the compiler turns the drawing into the `alert_rule` rows the runtime already
 * evaluates. What is tested is that the compiler adds nothing of its own — the same
 * parameters, the same refusal sentences, the same evaluation — and that the database
 * keeps the graph the only thing anybody edits.
 */
describe('workflow compiler: the graph', () => {
  it('1. a single threshold compiles to exactly the params a hand-written rule holds, and fires at 6 of 10, not 5', () => {
    const [rule] = compileWorkflow(thresholdSpec()).rules;
    expect(rule.trigger).toBe('signal-threshold');
    expect(rule.params).toEqual({ signal: COOLANT, max: 105, lookbackReadings: 10, requiredBreaches: 6 });
    const fire = (hot: number) => evaluateRule({
      trigger: rule.trigger, params: rule.params, predictions: [],
      readings: readings(COOLANT, [...Array(hot).fill(110), ...Array(10 - hot).fill(90)]),
    });
    expect(fire(6)).not.toBeNull();
    expect(fire(5)).toBeNull();
  });

  it('2. every node type in the registry compiles; an unknown one is refused by name', () => {
    const spec: WorkflowSpec = {
      kind: 'alert', scope: { appliesTo: 'account' },
      nodes: [
        { id: 's', type: 'ReadSignal', params: { signal: COOLANT } },
        { id: 'th', type: 'Threshold', params: { max: 100 } },
        { id: 'fg', type: 'FreshnessGate' },
        { id: 'ps', type: 'PredictionSeverity', params: { atLeast: Severity.High } },
        { id: 'fl', type: 'FuelLoss', params: { dropAtLeast: 20, withinMinutes: 30 } },
        { id: 'co', type: 'ChainOrigin', params: { atLeast: 'critical' } },
        { id: 'any', type: 'AnyOf' }, { id: 'all', type: 'AllOf' },
        { id: 'n', type: 'Notify', params: { name: 'Everything', severity: Severity.Medium } },
      ],
      edges: [
        { from: 's', to: 'th' }, { from: 'th', to: 'all' }, { from: 'fg', to: 'all' },
        { from: 'all', to: 'any' }, { from: 'ps', to: 'any' }, { from: 'fl', to: 'any' }, { from: 'co', to: 'any' },
        { from: 'any', to: 'n' },
      ],
    };
    const used = new Set(spec.nodes.map((n) => n.type));
    expect(WORKFLOW_NODE_TYPES.filter((t) => !used.has(t))).toEqual([]);
    expect(compileWorkflow(spec).rules[0].trigger).toBe('composite');

    const unknown = thresholdSpec();
    unknown.nodes.push({ id: 'x', type: 'RunScript' as never });
    expect(() => compileWorkflow(unknown)).toThrow('Node "x": "RunScript" is not a workflow node type.');
  });

  it('3. M greater than N in a node is refused in the same sentence a hand-written rule gets', () => {
    const sentence = validateParams('signal-threshold', { signal: COOLANT, max: 105, lookbackReadings: 10, requiredBreaches: 11 })!;
    expect(sentence).toBeTruthy();
    expect(() => compileWorkflow(thresholdSpec(105, {}, { requiredBreaches: 11 })))
      .toThrow(`Node "hot" (Threshold): ${sentence}`);
  });

  it('5. a cycle, a path with no Notify, a one-child composite and an over-size graph are each refused', () => {
    // Two composites feeding each other: every node has the edges its role allows, so
    // only the cycle check can refuse it.
    const cycle: WorkflowSpec = {
      kind: 'alert', scope: { appliesTo: 'account' },
      nodes: [
        { id: 's1', type: 'ReadSignal', params: { signal: COOLANT } }, { id: 't1', type: 'Threshold', params: { max: 1 } },
        { id: 's2', type: 'ReadSignal', params: { signal: OIL } }, { id: 't2', type: 'Threshold', params: { max: 1 } },
        { id: 'a', type: 'AllOf' }, { id: 'b', type: 'AnyOf' },
      ],
      edges: [
        { from: 's1', to: 't1' }, { from: 's2', to: 't2' }, { from: 't1', to: 'a' }, { from: 't2', to: 'b' },
        { from: 'a', to: 'b' }, { from: 'b', to: 'a' },
      ],
    };
    expect(() => compileWorkflow(cycle)).toThrow('The workflow has a cycle; a condition cannot depend on itself.');

    const noNotify = thresholdSpec();
    noNotify.nodes = noNotify.nodes.filter((n) => n.id !== 'tell');
    noNotify.edges = noNotify.edges.filter((e) => e.to !== 'tell');
    expect(() => compileWorkflow(noNotify)).toThrow(/every path ends in exactly one Notify/);

    const lonely: WorkflowSpec = {
      ...thresholdSpec(),
      nodes: [...thresholdSpec().nodes, { id: 'and', type: 'AllOf' }],
      edges: [{ from: 'sig', to: 'hot' }, { from: 'hot', to: 'and' }, { from: 'and', to: 'tell' }],
    };
    expect(() => compileWorkflow(lonely)).toThrow('Node "and" (AllOf) combines 1 condition(s); a composite needs at least two.');

    const big = thresholdSpec();
    for (let i = 0; i < MAX_WORKFLOW_NODES; i++) big.nodes.push({ id: `fg${i}`, type: 'FreshnessGate' });
    expect(() => compileWorkflow(big)).toThrow(`A workflow has at most ${MAX_WORKFLOW_NODES} nodes`);

    // ReadSignal → Threshold → AllOf × n → Notify, one level too deep.
    const deep: WorkflowSpec = { kind: 'alert', scope: { appliesTo: 'account' }, nodes: [], edges: [] };
    deep.nodes.push({ id: 's', type: 'ReadSignal', params: { signal: COOLANT } }, { id: 't', type: 'Threshold', params: { max: 1 } });
    deep.edges.push({ from: 's', to: 't' });
    let prev = 't';
    for (let i = 0; i < MAX_WORKFLOW_DEPTH - 2; i++) {
      deep.nodes.push({ id: `a${i}`, type: 'AllOf' }, { id: `g${i}`, type: 'FreshnessGate' });
      deep.edges.push({ from: prev, to: `a${i}` }, { from: `g${i}`, to: `a${i}` });
      prev = `a${i}`;
    }
    deep.nodes.push({ id: 'n', type: 'Notify', params: { name: 'Deep', severity: Severity.Low } });
    deep.edges.push({ from: prev, to: 'n' });
    expect(() => compileWorkflow(deep)).toThrow(`A workflow is at most ${MAX_WORKFLOW_DEPTH} nodes deep; this one is ${MAX_WORKFLOW_DEPTH + 1}.`);
  });

  it('refuses free text and agent workflows before anything else sees them', () => {
    expect(() => compileWorkflow({ ...thresholdSpec(), kind: 'agent' as never })).toThrow(/Only alert workflows/);
    const expr = thresholdSpec();
    expr.nodes[1].params = { condition: 'coolant > 105' };
    expect(() => compileWorkflow(expr)).toThrow('Node "hot" (Threshold) has no parameter "condition".');
  });

  it('13. the hash ignores node ids and term order; changing one threshold changes it', () => {
    const a = compositeSpec('AllOf');
    const renamed = JSON.parse(JSON.stringify(a).replace(/"t1"/g, '"first"').replace(/"s1"/g, '"read-1"')) as WorkflowSpec;
    renamed.edges.reverse();
    expect(compileWorkflow(renamed).graphHash).toBe(compileWorkflow(a).graphHash);
    expect(compileWorkflow(thresholdSpec(106)).graphHash).not.toBe(compileWorkflow(thresholdSpec(105)).graphHash);
  });

  it('14. AND fires only when both leaves\' own M-of-N hold; OR when either does; the leaves are the leaf code', () => {
    const and = compileWorkflow(compositeSpec('AllOf')).rules[0];
    const or = compileWorkflow(compositeSpec('AnyOf')).rules[0];
    const hot = readings(COOLANT, [...Array(6).fill(110), ...Array(4).fill(90)]);
    const lowOil = (n: number) => readings(OIL, [...Array(n).fill(100), ...Array(10 - n).fill(300)]);
    const run = (rule: typeof and, r: WindowReading[]) => evaluateRule({ trigger: rule.trigger, params: rule.params, readings: r, predictions: [] });

    // The oil leaf needs 3 of 10. Two is short by its own count, three is enough.
    expect(run(and, [...hot, ...lowOil(2)])).toBeNull();
    expect(run(and, [...hot, ...lowOil(3)])).not.toBeNull();
    expect(run(or, [...hot, ...lowOil(0)])).not.toBeNull();
    expect(run(or, [...readings(COOLANT, Array(10).fill(90)), ...lowOil(2)])).toBeNull();
    // The summary is each leaf's own summary, so an AND says why on both counts.
    expect(run(and, [...hot, ...lowOil(3)])!.summary).toContain(`${COOLANT} breached 105`);
  });

  it('15. every trigger has a renderer; a threshold reads byte-identical; a composite in its leaves\' words', () => {
    expect(ALERT_TRIGGERS.filter((t) => typeof RULE_CLAUSES[t] !== 'function')).toEqual([]);
    const [threshold] = compileWorkflow(thresholdSpec()).rules;
    const name = (s: string) => ({ displayName: s.replace(/_/g, ' '), unit: 'degC' });
    expect(describeRule(threshold, name)).toBe(describeSignalThresholdRule(threshold.params as never, name(COOLANT)));
    const [composite] = compileWorkflow(compositeSpec('AllOf')).rules;
    const leaf = describeSignalThresholdRule(threshold.params as never, name(COOLANT)).replace(/^Fires when /, '').replace(/\.$/, '');
    expect(describeRule(composite, name)).toContain(leaf);
    expect(describeRule(composite, name)).toContain(', and at least 3 of the last 10 readings of engine oil pressure fall below 150');
  });

  it('every registry entry names a role, and only conditions name a trigger', () => {
    for (const [type, kind] of Object.entries(NODE_REGISTRY)) {
      expect(!!kind.trigger).toBe(kind.role === 'condition');
      expect(WORKFLOW_NODE_TYPES).toContain(type);
    }
  });
});

describeDb('workflow compiler: storage, publish and the database\'s refusals', () => {
  let owner: DataSource;
  let ds: DataSource;
  let workflows: WorkflowService;
  let alerts: AlertService;

  const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    workflows = new WorkflowService(ds);
    alerts = new AlertService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * acme has a "genset" class copy declaring coolant, oil and fuel; GEN-1 has coolant
   * bound and reporting, GEN-2 has nothing bound. A copied threshold template watches
   * coolant; nothing watches oil.
   */
  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "alert_event", "alert_rule", "workflow_layout", "workflow_version", "workflow_definition",
        "signal_binding_version", "telemetry_reading", "client_equipment_class_failure_mode", "client_equipment_class",
        "equipment_profile" CASCADE`);
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals) VALUES ('acme', 'genset', 'Genset', $1::jsonb)`,
      [JSON.stringify([
        { signal: COOLANT, unit: 'degC', required: true }, { signal: OIL, unit: 'kPa', required: true },
        { signal: 'fuel_level', unit: '%', required: false },
      ])],
    );
    await owner.query(
      `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name, signals)
         VALUES ('acme', 'genset', 'overheat', 'Overheating', $1)`, [[COOLANT, OIL]],
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
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
         VALUES ('acme', 'IMEI-1', $1, 90, $2, $2, 'live')`, [COOLANT, new Date(NOW.getTime() - 60_000)],
    );
    await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, equipment_class_slug, severity, enabled,
         template_slug, template_version)
       VALUES ('acme', 'coolant-high', 'Coolant high', 'signal-threshold', $1::jsonb, 'equipment-class', 'genset', 'high', true,
         'coolant-high', 1)`, [JSON.stringify({ signal: COOLANT, max: 105 })],
    );
  });

  const create = (spec: WorkflowSpec, slug = 'coolant') => workflows.create(acme, { slug, name: 'Coolant', spec });
  const asOwner = (sql: string, params: unknown[] = []) => owner.query(sql, params);

  it('1. publishes a threshold rule whose params equal a hand-written one with the same values', async () => {
    const wf = await create(thresholdSpec());
    const out = await workflows.publish(acme, wf.id, 1, NOW);
    const hand = await alerts.createRule(acme, {
      slug: 'by-hand', name: 'By hand', trigger: 'signal-threshold',
      params: { signal: COOLANT, max: 105, lookbackReadings: 10, requiredBreaches: 6 },
    });
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0].params).toEqual(hand.params);
    expect(out.rules[0]).toMatchObject({ compiledFromWorkflowId: wf.id, appliesTo: 'equipment', externalId: 'GEN-1', enabled: true });
  });

  it('4. a ReadSignal naming a signal the class does not declare is refused, named', async () => {
    const spec = thresholdSpec();
    spec.nodes[0].params = { signal: 'turbo_boost' };
    await expect(create(spec)).rejects.toThrow('Signal "turbo_boost" is not declared by class "genset".');
  });

  it('6. the database refuses a workflow of kind agent', async () => {
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO workflow_definition (tenant_id, slug, name, kind) VALUES ('acme', 'agent-one', 'Agent', 'agent')`,
    ))).rejects.toThrow(/ck_workflow_definition_kind/);
  });

  it('7 and 8. a published version cannot change, and a second one cannot be published beside it', async () => {
    const wf = await create(thresholdSpec());
    await workflows.publish(acme, wf.id, 1, NOW);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE workflow_version SET spec = '{}'::jsonb WHERE workflow_id = $1`, [wf.id],
    ))).rejects.toThrow(/its content cannot change/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE workflow_version SET status = 'draft' WHERE workflow_id = $1`, [wf.id],
    ))).rejects.toThrow(/cannot move from published to draft/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO workflow_version (tenant_id, workflow_id, version, spec, graph_hash, status, published_by, published_at)
         VALUES ('acme', $1, 2, '{}'::jsonb, 'x', 'published', 'u', now())`, [wf.id],
    ))).rejects.toThrow(/uq_workflow_version_published/);
    await expect(workflows.replaceSpec(acme, wf.id, 1, thresholdSpec(110))).rejects.toMatchObject({ status: 409 });
  });

  it('9. a compiled rule\'s content is refused by the database and by the API; switching it off is not', async () => {
    const wf = await create(thresholdSpec());
    const [rule] = (await workflows.publish(acme, wf.id, 1, NOW)).rules;
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE alert_rule SET params = '{"signal":"x","max":1}'::jsonb WHERE id = $1`, [rule.id],
    ))).rejects.toThrow(/compiled from a workflow/);
    await expect(alerts.updateRule(acme, rule.id, { name: 'Renamed', params: { signal: COOLANT, max: 1 } }))
      .rejects.toMatchObject({ status: 409 });
    // D18 Q7: off and on again, by itself.
    expect((await alerts.setEnabled(acme, rule.id, false)).enabled).toBe(false);
    expect((await workflows.get(acme, wf.id)).versions[0].rules).toEqual([expect.objectContaining({ id: rule.id, enabled: false })]);
    // A hand-written rule beside it still updates, and cannot be adopted into a workflow.
    const hand = await asOwner(`SELECT id FROM alert_rule WHERE slug = 'coolant-high'`);
    await expect(alerts.updateRule(acme, hand[0].id, { params: { signal: COOLANT, max: 100 } })).resolves.toBeDefined();
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE alert_rule SET compiled_from_workflow_id = $1, compiled_from_version_id = $2, graph_hash = 'x' WHERE id = $3`,
      [wf.id, rule.compiledFromVersionId, hand[0].id],
    ))).rejects.toThrow(/cannot be adopted into a workflow/);
  });

  it('10. a composite is refused by the rule API and, written directly with no workflow, by the database', async () => {
    const dto = plainToInstance(RuleDto, { slug: 'x-y', name: 'X', trigger: 'composite', params: { condition: {} } });
    expect((await validate(dto)).map((e) => e.property)).toContain('trigger');
    await expect(alerts.createRule(acme, { slug: 'x-y', name: 'X', trigger: 'composite', params: { condition: { allOf: [] } } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params) VALUES ('acme', 'direct', 'Direct', 'composite', '{}'::jsonb)`,
    ))).rejects.toThrow(/ck_alert_rule_composite_compiled/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, compiled_from_workflow_id)
         VALUES ('acme', 'half', 'Half', 'signal-threshold', '{}'::jsonb, gen_random_uuid())`,
    ))).rejects.toThrow(/ck_alert_rule_compiled_provenance|foreign key/);
  });

  it('11. republishing switches the old rules off unchanged, writes new ones, and old events still find their rule', async () => {
    const wf = await create(thresholdSpec(105));
    const [v1Rule] = (await workflows.publish(acme, wf.id, 1, NOW)).rules;
    await asOwner(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('acme', $1, 'Coolant hot', $2, 'GEN-1', 'high', 'hot', '{}'::jsonb, 'open', now())`, [v1Rule.id, SS],
    );
    await workflows.newVersion(acme, wf.id);
    await workflows.replaceSpec(acme, wf.id, 2, thresholdSpec(110));
    const [v2Rule] = (await workflows.publish(acme, wf.id, 2, NOW)).rules;

    const rows = await asOwner(`SELECT id, enabled, params FROM alert_rule WHERE compiled_from_workflow_id = $1 ORDER BY slug`, [wf.id]);
    expect(rows).toEqual([
      { id: v1Rule.id, enabled: false, params: { signal: COOLANT, max: 105, lookbackReadings: 10, requiredBreaches: 6 } },
      { id: v2Rule.id, enabled: true, params: { signal: COOLANT, max: 110, lookbackReadings: 10, requiredBreaches: 6 } },
    ]);
    expect((await workflows.get(acme, wf.id)).versions.map((v) => v.status)).toEqual(['superseded', 'published']);
    expect(await asOwner(`SELECT r.slug FROM alert_event e JOIN alert_rule r ON r.id = e.rule_id`)).toEqual([{ slug: v1Rule.slug }]);
  });

  it('12. two publishes of one draft at once both settle; one set of rules, one published version', async () => {
    const wf = await create(thresholdSpec());
    const results = await Promise.allSettled([workflows.publish(acme, wf.id, 1, NOW), workflows.publish(acme, wf.id, 1, NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await asOwner(`SELECT count(*)::int AS n FROM alert_rule WHERE compiled_from_workflow_id = $1`, [wf.id])).toEqual([{ n: 1 }]);
    expect(await asOwner(`SELECT count(*)::int AS n FROM workflow_version WHERE workflow_id = $1 AND status = 'published'`, [wf.id]))
      .toEqual([{ n: 1 }]);
  });

  it('13. moving nodes changes the layout and nothing else; a new threshold changes the hash', async () => {
    const wf = await create(thresholdSpec());
    const before = (await workflows.get(acme, wf.id)).versions[0].graphHash;
    const moved = await workflows.setLayout(acme, wf.id, 1, { sig: { x: 10, y: 20 }, hot: { x: 200, y: 20 } });
    expect(moved.graphHash).toBe(before);
    const after = await workflows.get(acme, wf.id);
    expect(after.versions[0]).toMatchObject({ graphHash: before, layout: { sig: { x: 10, y: 20 } } });
    await workflows.replaceSpec(acme, wf.id, 1, thresholdSpec(110));
    expect((await workflows.get(acme, wf.id)).versions[0].graphHash).not.toBe(before);
  });

  it('16. machine scope with an unbound signal: compile reports it, publish refuses it, nothing is written', async () => {
    const wf = await create(thresholdSpec(105, { externalId: 'GEN-2' }));
    const plan = await workflows.compile(acme, wf.id, 1, NOW);
    expect(plan.readiness).toEqual([expect.objectContaining({
      state: 'not_configured', signals: [{ signal: COOLANT, state: 'not_configured', reason: 'unbound' }],
    })]);
    expect(plan.publishRefusal).toMatch(/unbound/);
    await expect(workflows.publish(acme, wf.id, 1, NOW)).rejects.toMatchObject({ status: 409 });
    expect(await asOwner(`SELECT count(*)::int AS n FROM alert_rule WHERE compiled_from_workflow_id IS NOT NULL`)).toEqual([{ n: 0 }]);
    // On GEN-1, bound and reporting, the same graph is ready.
    const ok = await create(thresholdSpec(105), 'coolant-gen1');
    expect((await workflows.compile(acme, ok.id, 1, NOW)).readiness[0]).toMatchObject({ state: 'ready' });
  });

  it('D18 Q8. class scope publishes with readiness listed while one machine is ready, and is refused when none is', async () => {
    const one = thresholdSpec(105, { appliesTo: 'equipment-class', equipmentClassSlug: 'genset', sourceSystem: null, externalId: null });
    const wf = await create(one);
    const out = await workflows.publish(acme, wf.id, 1, NOW);
    expect(out.readiness!.map((r) => [r.machine.externalId, r.state])).toEqual([['GEN-1', 'ready'], ['GEN-2', 'not_configured']]);

    await owner.query(`TRUNCATE TABLE telemetry_reading`);
    const stale = await create(one, 'coolant-stale');
    const plan = await workflows.compile(acme, stale.id, 1, NOW);
    expect(plan.readiness.map((r) => r.signals[0].reason)).toEqual(['no_readings', 'unbound']);
    await expect(workflows.publish(acme, stale.id, 1, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it('17. assembling a failure mode leaves a signal with no copied template unresolved, with no threshold invented', async () => {
    const out = await workflows.assemble(acme, {
      target: { appliesTo: 'equipment-class', equipmentClassSlug: 'genset' }, failureModeCode: 'overheat', combine: 'allOf',
    });
    expect(out.unresolved).toEqual([expect.objectContaining({ signal: OIL, reason: 'no_copied_template' })]);
    expect(JSON.stringify(out.spec)).not.toContain(OIL);
    expect(out.spec.nodes.filter((n) => n.type === 'Threshold').map((n) => n.params)).toEqual([{ max: 105 }]);
    expect(out.rendering).toEqual(['Fires when at least 6 of the last 10 readings of engine coolant temperature rise above 105 degC.']);
    expect(await asOwner(`SELECT count(*)::int AS n FROM workflow_definition`)).toEqual([{ n: 0 }]);
  });

  it('19. another account can neither read, compile nor publish a workflow, nor see its rules', async () => {
    const wf = await create(thresholdSpec());
    await workflows.publish(acme, wf.id, 1, NOW);
    expect(await workflows.list(globex)).toEqual([]);
    await expect(workflows.get(globex, wf.id)).rejects.toMatchObject({ status: 404 });
    await expect(workflows.compile(globex, wf.id, 1, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(workflows.publish(globex, wf.id, 1, NOW)).rejects.toMatchObject({ status: 404 });
    expect((await alerts.listRules(globex)).filter((r) => r.compiledFromWorkflowId)).toEqual([]);
  });

  // Last: it takes the schema down past this migration and back up.
  it('18 and 20. WorkflowCompiler1760800000000 down keeps hand-written rules intact, and they evaluate the same after it', async () => {
    const before = await asOwner(`SELECT trigger, params FROM alert_rule WHERE slug = 'coolant-high'`);
    const wf = await create(thresholdSpec());
    await workflows.publish(acme, wf.id, 1, NOW);
    await undoMigrationNamed(owner, 'WorkflowCompiler1760800000000');
    expect(await asOwner(`SELECT to_regclass('workflow_definition') AS a, to_regclass('workflow_version') AS b, to_regclass('workflow_layout') AS c`))
      .toEqual([{ a: null, b: null, c: null }]);
    expect(await asOwner(`SELECT column_name FROM information_schema.columns WHERE table_name = 'alert_rule'
      AND column_name IN ('compiled_from_workflow_id', 'compiled_from_version_id', 'graph_hash')`)).toEqual([]);
    expect(await asOwner(`SELECT trigger, params FROM alert_rule WHERE slug = 'coolant-high'`)).toEqual(before);

    // Seeded with the migration down, then migrated up: a hand-written rule is untouched and fires the same.
    await asOwner(`INSERT INTO alert_rule (tenant_id, slug, name, trigger, params) VALUES ('acme', 'pre-existing', 'Pre', 'signal-threshold', $1::jsonb)`,
      [JSON.stringify({ signal: COOLANT, max: 100, lookbackReadings: 4, requiredBreaches: 2 })]);
    await owner.runMigrations({ transaction: 'all' });
    const [pre] = await asOwner(`SELECT trigger, params, compiled_from_workflow_id FROM alert_rule WHERE slug = 'pre-existing'`);
    expect(pre.compiled_from_workflow_id).toBeNull();
    const window = readings(COOLANT, [101, 102, 90, 90]);
    expect(evaluateRule({ trigger: pre.trigger, params: pre.params, readings: window, predictions: [] })).toEqual(
      evaluateRule({ trigger: 'signal-threshold', params: { signal: COOLANT, max: 100, lookbackReadings: 4, requiredBreaches: 2 }, readings: window, predictions: [] }),
    );
  });
});
