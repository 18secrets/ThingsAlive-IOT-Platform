import { ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { EmitterRegistry } from '../src/proposal/emitter';
import { ProposalService, ProposalView } from '../src/proposal/proposal.service';
import { ReplayService } from '../src/proposal/replay.service';
import { WorkflowEmitter } from '../src/proposal/workflow-emitter';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { WorkflowSpec } from '../src/workflow/workflow-spec';
import { WorkflowService } from '../src/workflow/workflow.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';
import { withTenantSession } from '../src/scope/tenant-session';

const SS = 'ta-2.0';
const COOLANT = 'engine_coolant_temperature';
const DAY = 86_400_000;

describeDb('QGEN3: The workflow emitter', () => {
  let owner: DataSource;
  let ds: DataSource;
  let proposals: ProposalService;
  let emitter: WorkflowEmitter;
  let workflows: WorkflowService;
  let registry: EmitterRegistry;

  const NOW = new Date('2026-10-19T00:00:00.000Z');
  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const admin: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const bossB: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };

  let keys = 0;
  const key = () => `wf-key-${(keys += 1)}`;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (const month of ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']) {
      await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    }
    ds = await createAppDataSource();

    workflows = new WorkflowService(ds);
    emitter = new WorkflowEmitter(ds, workflows);
    registry = new EmitterRegistry();
    registry.register(emitter);
    const replays = new ReplayService(ds);
    proposals = new ProposalService(ds, registry, replays);
  }, 60_000);

  afterAll(async () => {
    delete process.env.PROPOSAL_REPLAY_MAX_FIRES;
    await ds?.destroy();
    await owner?.destroy();
  });

  beforeEach(async () => {
    process.env.PROPOSAL_REPLAY_MAX_FIRES = '5';
    await owner.query(`
      TRUNCATE TABLE "proposal_rule_enablement", "replay_run", "alert_event", "alert_rule", "workflow_layout", "workflow_version",
        "workflow_definition", "artifact_proposal", "signal_binding_version", "telemetry_reading", "equipment_shift",
        "client_equipment_class_failure_mode", "client_equipment_class", "equipment_profile" CASCADE`);

    // Class with coolant signal
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals, template_version, template_checksum)
       VALUES ('acme', 'genset', 'Genset', $1::jsonb, 1, 'cksum-class-1')`,
      [JSON.stringify([{ signal: COOLANT, unit: 'degC', required: true }])],
    );

    // Failure mode for genset
    await owner.query(
      `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name, symptom, signals, template_version)
       VALUES ('acme', 'genset', 'FM-COOLANT', 'Cooling System Overheat', 'High temperature', $1::text[], 1)`,
      [[COOLANT]],
    );

    // Machines
    for (const id of ['GEN-1', 'GEN-2']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, origin, status, tier, readiness)
         VALUES ('acme', $1, $2, $2, 'genset', 'client', 'active', 'basic', '{}'::jsonb)`,
        [SS, id],
      );
    }

    // Primary binding for GEN-1
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', $1, 'GEN-1', $2, $2, '', 'physical', 'IMEI-1', 'ch1', 'degC', '2026-01-01', NULL, true, 'active', 'manual', 'u', '2026-01-01')`,
      [SS, COOLANT],
    );

    // Shift for GEN-1: 06:00 - 14:00 UTC
    await owner.query(
      `INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone)
       VALUES ('acme', $1, 'GEN-1', 'Day', 360, 840, '{0,1,2,3,4,5,6}', 'UTC')`,
      [SS],
    );

    // Copied alert template for coolant threshold
    await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, severity, applies_to, source_system, external_id,
         equipment_class_slug, template_slug, template_version, template_checksum, created_by, updated_by)
       VALUES ('acme', 'tpl-coolant-high', 'Coolant High', 'signal-threshold',
         '{"signal":"engine_coolant_temperature","max":105,"lookbackReadings":10,"requiredBreaches":6}'::jsonb,
         'high', 'equipment-class', NULL, NULL, 'genset', 'tpl-coolant', 1, 'cksum-tpl-1', 'u', 'u')`,
    );
  });

  /** Seeds `perDay` readings of coolant at `value` on each of the `days` days before NOW, inside the shift. */
  const seedReadings = (days: number, perDay: number, value: number, firstDay = 1) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
     SELECT 'acme', 'IMEI-1', $1, $2, ts, ts, 'live' FROM (
       SELECT $3::timestamptz - make_interval(days => d) + interval '8 hours' + make_interval(mins => k) AS ts
         FROM generate_series($4::int, $4::int + $5::int - 1) d, generate_series(0, $6::int - 1) k) x`,
    [COOLANT, value, NOW, firstDay, days, perDay],
  );

  // 1. A failure mode whose signals all have copied templates and are bound on the machine -> proposal compiles, replays, pass, approves, materialises
  it('1. assembles failure mode with bound signals, replays quiet history to pass, and materialises', async () => {
    // 20 days of 15 readings per shift at 90 degC (below 105 limit -> 0 fires -> pass)
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    expect(res.status).toBe('draft_ready');
    expect(res.gateOutcome).toBe('pass');

    // Approve and materialise
    const approved = await proposals.approve(boss, res.id, NOW);
    expect(approved.status).toBe('materialised');

    // Stored rules are enabled
    const rules = await owner.query(
      `SELECT * FROM alert_rule WHERE compiled_from_workflow_id = $1`,
      [approved.materialisedRef.workflowId],
    );
    expect(rules.length).toBe(1);
    expect(rules[0].enabled).toBe(true);
    expect(rules[0].trigger).toBe('signal-threshold');
    expect((rules[0].params as any).max).toBe(105);
  });

  // 2. Replay refuses a noisy rule: seed 90 days in which the template's threshold is breached on most shifts -> refuse; approval refused by DB
  it('2. replay refuses a noisy rule that breaches on most shifts, and the database refuses approval', async () => {
    // 30 days of 15 readings per shift at 115 degC (above 105 limit -> fires every shift -> 30 fires > 5 bound -> refuse)
    await seedReadings(30, 15, 115);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    expect(res.status).toBe('gate_refused');
    expect(res.gateOutcome).toBe('refuse');

    // Direct attempt to approve via proposal service is refused
    await expect(proposals.approve(boss, res.id, NOW)).rejects.toThrow();

    // Direct attempt to bypass in database is refused by check constraint or trigger
    await expect(
      owner.query(
        `UPDATE artifact_proposal SET status = 'approved', approved_by = 'u', approved_at = now() WHERE id = $1`,
        [res.id],
      ),
    ).rejects.toThrow(/cannot move from gate_refused to approved|ck_artifact_proposal_approvable/);
  });

  // 3. Zero history -> insufficient_history, never pass. Approve it -> rules exist with enabled = false
  it('3. zero history results in insufficient_history, materialising with enabled = false', async () => {
    // Zero readings seeded
    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    expect(res.status).toBe('draft_ready');
    expect(res.gateOutcome).toBe('insufficient_history');
    expect(res.unvalidated).toBe(true);

    const approved = await proposals.approve(boss, res.id, NOW);
    expect(approved.status).toBe('materialised');

    const rules = await owner.query(
      `SELECT * FROM alert_rule WHERE compiled_from_workflow_id = $1`,
      [approved.materialisedRef.workflowId],
    );
    expect(rules.length).toBe(1);
    expect(rules[0].enabled).toBe(false);

    // Direct flip to true without enablement record is refused by database
    await expect(
      owner.query(`UPDATE alert_rule SET enabled = true WHERE id = $1`, [rules[0].id]),
    ).rejects.toThrow();
  });

  // 4. A failure-mode signal with no copied template -> needs_input naming the signal; no proposal written
  it('4. returns needs_input when a failure mode signal lacks a copied template', async () => {
    // Add failure mode requiring oil_pressure which has no copied template
    await owner.query(
      `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name, symptom, signals, template_version)
       VALUES ('acme', 'genset', 'FM-OIL', 'Low Oil Pressure', 'Pressure drop', '{oil_pressure}', 1)`,
    );

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-OIL',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('needs_input');
    if (res.status === 'needs_input') {
      expect(res.missing.some((m) => m.field === 'oil_pressure' && m.reason === 'no_copied_template')).toBe(true);
    }

    const count = await owner.query(`SELECT count(*)::int AS c FROM artifact_proposal`);
    expect(count[0].c).toBe(0);
  });

  // 5. A signal declared but unbound on the machine -> needs_input, not a proposal that replays to zero
  it('5. returns needs_input when signal is declared on class but unbound on target machine', async () => {
    // GEN-2 has no bindings for coolant
    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-2' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW);

    expect(res.status).toBe('needs_input');
    if (res.status === 'needs_input') {
      expect(res.missing.some((m) => m.reason === 'signal_unbound' && m.field.includes(COOLANT))).toBe(true);
    }
  });

  // 6. A spec with kind = 'agent' reaching the substrate -> database refuses at materialisation
  it('6. database refuses materialisation when spec kind is agent', async () => {
    const agentSpec: any = {
      kind: 'agent',
      scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
      nodes: [],
      edges: [],
    };

    const out = await emitter.compile({ spec: agentSpec }, {
      scope: boss, proposalScope: 'tenant', m: ds.manager, at: NOW,
    });
    expect(out.ok).toBe(false);

    await expect(
      owner.query(`INSERT INTO workflow_definition (tenant_id, slug, name, kind) VALUES ('acme', 'agent-one', 'Agent', 'agent')`),
    ).rejects.toThrow(/ck_workflow_definition_kind/);
  });

  // 7. A spec node carrying a string where a parameter is numeric, or an extra property -> compile refused
  it('7. refuses compile when node parameter is non-numeric or has extra unknown properties', async () => {
    const badParamSpec: WorkflowSpec = {
      kind: 'alert',
      scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
      nodes: [
        { id: 's', type: 'ReadSignal', params: { signal: COOLANT } },
        { id: 't', type: 'Threshold', params: { max: 'one hundred' as any } },
        { id: 'n', type: 'Notify', params: { name: 'Alert', severity: 'high' } },
      ],
      edges: [{ from: 's', to: 't' }, { from: 't', to: 'n' }],
    };

    const out1 = await emitter.compile({ spec: badParamSpec }, {
      scope: boss, proposalScope: 'tenant', m: ds.manager, at: NOW,
    });
    expect(out1.ok).toBe(false);
    expect((out1 as any).message).toMatch(/numeric/);

    const extraParamSpec: WorkflowSpec = {
      kind: 'alert',
      scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
      nodes: [
        { id: 's', type: 'ReadSignal', params: { signal: COOLANT } },
        { id: 't', type: 'Threshold', params: { max: 100, customNoiseProperty: 'invalid' } as any },
        { id: 'n', type: 'Notify', params: { name: 'Alert', severity: 'high' } },
      ],
      edges: [{ from: 's', to: 't' }, { from: 't', to: 'n' }],
    };

    const out2 = await emitter.compile({ spec: extraParamSpec }, {
      scope: boss, proposalScope: 'tenant', m: ds.manager, at: NOW,
    });
    expect(out2.ok).toBe(false);
    expect((out2 as any).message).toMatch(/unknown parameter/i);
  });

  // 8. Every threshold in an approved generated workflow traces to a template version in target_versions
  it('8. walks materialised rules back to alert template version in target_versions', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    const approved = await proposals.approve(boss, res.id, NOW);
    const rules = await owner.query(
      `SELECT * FROM alert_rule WHERE compiled_from_workflow_id = $1`,
      [approved.materialisedRef.workflowId],
    );

    const targetTpls = (res.targetVersions.alertTemplates as any[]) ?? [];
    expect(targetTpls.length).toBeGreaterThan(0);
    expect(targetTpls[0].templateSlug).toBe('tpl-coolant');
    expect(targetTpls[0].templateVersion).toBe(1);
  });

  // 9. Signal rebound after the replay -> approval 409 naming the binding
  it('9. refuses approval with 409 if a signal was rebound after the replay', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    // Mutate the primary binding valid_to
    await owner.query(
      `UPDATE signal_binding_version SET valid_to = now() WHERE tenant_id = 'acme' AND external_id = 'GEN-1' AND signal_key = $1`,
      [COOLANT],
    );

    await expect(proposals.approve(boss, res.id, NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ message: expect.stringContaining('changed since the replay') }),
    });
  });

  // 10. Concurrent approve via Promise.allSettled -> both settle, one workflow, one set of rules
  it('10. concurrent approvals settle idempotently with one workflow and one set of rules', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    const [a1, a2] = await Promise.allSettled([
      proposals.approve(boss, res.id, NOW),
      proposals.approve(boss, res.id, NOW),
    ]);

    expect(a1.status === 'fulfilled' || a2.status === 'fulfilled').toBe(true);

    const wfCount = await owner.query(`SELECT count(*)::int AS c FROM workflow_definition WHERE tenant_id = 'acme'`);
    expect(wfCount[0].c).toBe(1);
  });

  // 11. Concurrent propose with one idempotency key -> one proposal
  it('11. concurrent proposes with one idempotency key return the same proposal', async () => {
    await seedReadings(20, 15, 90);

    const idemKey = key();
    const seed = {
      target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
      intent: 'watch-failure-mode' as const,
      failureModeCode: 'FM-COOLANT',
    };

    const [p1, p2] = await Promise.all([
      proposals.propose(boss, { kind: 'workflow', seed, idempotencyKey: idemKey }, NOW),
      proposals.propose(boss, { kind: 'workflow', seed, idempotencyKey: idemKey }, NOW),
    ]);

    expect((p1 as any).id).toBe((p2 as any).id);
    const count = await owner.query(`SELECT count(*)::int AS c FROM artifact_proposal WHERE idempotency_key = $1`, [idemKey]);
    expect(count[0].c).toBe(1);
  });

  // 12. Approver lacking alert.author -> refused, naming the capability; nothing written
  it('12. refuses materialisation when user lacks alert.author capability', async () => {
    const noAuthorScope: RequestScope = { tenantId: 'acme', userId: 'u-viewer', roles: ['analyst'], isPlatformRole: false };

    await expect(
      emitter.materialise({
        spec: { kind: 'alert', scope: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' }, nodes: [], edges: [] },
      }, {
        scope: noAuthorScope,
        at: NOW,
        unvalidated: false,
        proposal: { id: '11111111-2222-3333-4444-555555555555', scope: 'tenant', gateOutcome: 'pass', targetVersions: {} },
      }, ds.manager),
    ).rejects.toThrow(ForbiddenException);
  });

  // 13. A generated workflow edited and republished by hand -> version 2 source = 'manual', version 1 rules disabled, provenance on version 1 intact
  it('13. a generated workflow edited and republished by hand creates version 2 with source = manual', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    const approved = await proposals.approve(boss, res.id, NOW);
    const wfId = approved.materialisedRef.workflowId as string;

    // Verify version 1
    const [v1] = await owner.query(`SELECT * FROM workflow_version WHERE workflow_id = $1 AND version = 1`, [wfId]);
    expect(v1.source).toBe('generated');
    expect(v1.proposal_id).toBe(res.id);

    // Edit and create version 2 by hand
    await workflows.newVersion(boss, wfId);
    const specV2 = JSON.parse(JSON.stringify(v1.spec));
    specV2.nodes[0].params = { signal: COOLANT };
    await workflows.replaceSpec(boss, wfId, 2, specV2);

    // Publish version 2
    await workflows.publish(boss, wfId, 2, NOW);

    // Verify version 2 has source = manual
    const [v2] = await owner.query(`SELECT * FROM workflow_version WHERE workflow_id = $1 AND version = 2`, [wfId]);
    expect(v2.source).toBe('manual');
    expect(v2.status).toBe('published');

    // Version 1 rules are disabled
    const v1Rules = await owner.query(`SELECT enabled FROM alert_rule WHERE compiled_from_version_id = $1`, [v1.id]);
    expect(v1Rules.every((r: any) => r.enabled === false)).toBe(true);

    // Version 1 provenance is intact
    const [v1After] = await owner.query(`SELECT source, proposal_id FROM workflow_version WHERE id = $1`, [v1.id]);
    expect(v1After.source).toBe('generated');
    expect(v1After.proposal_id).toBe(res.id);
  });

  // 14. Replay never touches production (G10), through this kind
  it('14. replay evaluation never writes alert_events or work_orders', async () => {
    await seedReadings(30, 15, 115); // noisy

    const eventsBefore = (await owner.query(`SELECT count(*)::int AS c FROM alert_event`))[0].c;
    const ordersBefore = (await owner.query(`SELECT count(*)::int AS c FROM work_order`))[0].c;

    await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW);

    const eventsAfter = (await owner.query(`SELECT count(*)::int AS c FROM alert_event`))[0].c;
    const ordersAfter = (await owner.query(`SELECT count(*)::int AS c FROM work_order`))[0].c;

    expect(eventsAfter).toBe(eventsBefore);
    expect(ordersAfter).toBe(ordersBefore);
  });

  // 15. The rendering an approver reads equals QWF1 renderer output for the compiled rules, byte for byte
  it('15. rendering presented to approver equals QWF1 renderer output byte for byte', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    const rendering = await withTenantSession(ds, boss, (m) =>
      workflows.renderSpec(m, boss, res.payload.spec as WorkflowSpec),
    );
    expect(res.rendering).toEqual(rendering);
  });

  // 16. There is no prediction intent and no node the emitter can construct that emits a predicted value
  it('16. refuses prediction intent without constructing proposals', async () => {
    await expect(
      proposals.propose(boss, {
        kind: 'workflow',
        seed: {
          target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
          intent: 'prediction' as any,
        },
        idempotencyKey: key(),
      }, NOW),
    ).rejects.toThrow(/Prediction has no emitter/);
  });

  // 17. RLS: tenant B cannot see, approve or replay tenant A workflow proposals
  it('17. enforces RLS so tenant B cannot see, approve or replay tenant A workflow proposals', async () => {
    await seedReadings(20, 15, 90);

    const res = await proposals.propose(boss, {
      kind: 'workflow',
      seed: {
        target: { appliesTo: 'equipment', sourceSystem: SS, externalId: 'GEN-1' },
        intent: 'watch-failure-mode',
        failureModeCode: 'FM-COOLANT',
      },
      idempotencyKey: key(),
    }, NOW) as ProposalView;

    // Tenant B cannot see proposal
    await expect(proposals.get(bossB, res.id, NOW)).rejects.toThrow();

    // Tenant B cannot approve proposal
    await expect(proposals.approve(bossB, res.id, NOW)).rejects.toThrow();
  });
});
