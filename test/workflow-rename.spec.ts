import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { WorkflowSpec } from '../src/workflow/workflow-spec';
import { WorkflowService } from '../src/workflow/workflow.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

jest.setTimeout(60_000);

/**
 * A workflow's name could be set only before its first save (the AI alert prompt test
 * log, S.NO 14): drafts of different alerts ended up under one name, and nothing could
 * tell them apart. It is renamed now, in any state; the alert itself is named by its
 * Notify node, so a rename changes no rule.
 */
describeDb('renaming a workflow', () => {
  let owner: DataSource;
  let ds: DataSource;
  let workflows: WorkflowService;
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };
  const COOLANT = 'engine_coolant_temperature';

  const spec: WorkflowSpec = {
    kind: 'alert', scope: { appliesTo: 'account' },
    nodes: [
      { id: 'sig', type: 'ReadSignal', params: { signal: COOLANT } },
      { id: 'hot', type: 'Threshold', params: { max: 105 } },
      { id: 'tell', type: 'Notify', params: { name: 'Coolant hot', severity: Severity.High } },
    ],
    edges: [{ from: 'sig', to: 'hot' }, { from: 'hot', to: 'tell' }],
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    const month = new Date(); month.setUTCDate(1);
    await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month.toISOString().slice(0, 10)]);
    ds = await createAppDataSource();
    workflows = new WorkflowService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "alert_event", "alert_rule", "workflow_layout", "workflow_version", "workflow_definition", "client_equipment_class", "equipment_profile", "signal_binding_version", "telemetry_reading" CASCADE`);
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals) VALUES ('acme', 'genset', 'Genset', $1::jsonb)`,
      [JSON.stringify([{ signal: COOLANT, unit: 'degC', required: true }])],
    );
    // An account-wide workflow reads the signals its machines' classes declare.
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, origin, status, tier, readiness)
         VALUES ('acme', 'ta-2.0', 'GEN-1', 'GEN-1', 'genset', 'client', 'active', 'basic', '{}'::jsonb)`,
    );
    // Receiving the signal, so a publish is not refused as reading nothing.
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', 'ta-2.0', 'GEN-1', $1, $1, '', 'physical', 'IMEI-1', 'ch1', 'degC', '2026-01-01', NULL, true, 'active', 'manual', 'u', '2026-01-01')`,
      [COOLANT],
    );
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
         VALUES ('acme', 'IMEI-1', $1, 90, $2, $2, 'live')`, [COOLANT, new Date(Date.now() - 60_000)],
    );
  });

  it('renames a draft, and the name reads back', async () => {
    const wf = await workflows.create(acme, { slug: 'coolant', name: 'Outrigger pressure below 40', spec });
    expect((await workflows.rename(acme, wf.id, '  Coolant watch – EX-07  ')).name).toBe('Coolant watch – EX-07');
    expect((await workflows.get(acme, wf.id)).name).toBe('Coolant watch – EX-07');
  });

  it('renames a published workflow without touching the rule it compiled to', async () => {
    const wf = await workflows.create(acme, { slug: 'coolant', name: 'Coolant', spec });
    await workflows.publish(acme, wf.id, 1);
    const before = await owner.query(`SELECT name, params, enabled FROM alert_rule ORDER BY slug`);
    await workflows.rename(acme, wf.id, 'Coolant – renamed');
    expect(await owner.query(`SELECT name, params, enabled FROM alert_rule ORDER BY slug`)).toEqual(before);
    expect((await workflows.get(acme, wf.id)).versions.map((v) => v.status)).toEqual(['published']);
  });

  it('refuses an empty name, and another account\'s workflow is not found', async () => {
    const wf = await workflows.create(acme, { slug: 'coolant', name: 'Coolant', spec });
    await expect(workflows.rename(acme, wf.id, '   ')).rejects.toThrow('A workflow needs a name.');
    await expect(workflows.rename(globex, wf.id, 'Mine')).rejects.toThrow(NotFoundException);
    expect((await workflows.get(acme, wf.id)).name).toBe('Coolant');
  });

  it('two renames fired together both settle; the row ends as one of them', async () => {
    const wf = await workflows.create(acme, { slug: 'coolant', name: 'Coolant', spec });
    const results = await Promise.allSettled([workflows.rename(acme, wf.id, 'First'), workflows.rename(acme, wf.id, 'Second')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(['First', 'Second']).toContain((await workflows.get(acme, wf.id)).name);
  });
});
