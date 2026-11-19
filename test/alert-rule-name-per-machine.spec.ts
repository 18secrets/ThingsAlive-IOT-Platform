import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { AlertService, RuleInput } from '../src/alert/services/alert.service';
import { WorkflowSpec } from '../src/workflow/workflow-spec';
import { WorkflowService } from '../src/workflow/workflow.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

jest.setTimeout(60_000);

/**
 * TC_199 and the 18 Nov sheet: publishing "Coolant hot" twice on one machine wrote two
 * enabled rules, both listed, both firing. The workflow editor stamps each slug with the
 * time, and the slug was the only thing anything held unique. One enabled rule of a name
 * per machine is now the database's rule; the services say it first, in words.
 */
describeDb('one enabled alert rule of a name per machine', () => {
  let owner: DataSource;
  let ds: DataSource;
  let alerts: AlertService;
  let workflows: WorkflowService;
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const COOLANT = 'engine_coolant_temperature';
  const GEN1 = { sourceSystem: 'ta-2.0', externalId: 'GEN-1' };
  const GEN2 = { sourceSystem: 'ta-2.0', externalId: 'GEN-2' };

  const rule = (slug: string, name: string, at: { sourceSystem: string; externalId: string } = GEN1): RuleInput => ({
    slug, name, trigger: 'signal-threshold', params: { signal: COOLANT, max: 105 },
    appliesTo: 'equipment', ...at, severity: Severity.High,
  });

  const notify = (id: string, name: string) => ({ id, type: 'Notify' as const, params: { name, severity: Severity.High } });
  const machineSpec = (name: string, max = 105): WorkflowSpec => ({
    kind: 'alert', scope: { appliesTo: 'equipment', ...GEN1 },
    nodes: [
      { id: 'sig', type: 'ReadSignal', params: { signal: COOLANT } },
      { id: 'hot', type: 'Threshold', params: { max } },
      notify('tell', name),
    ],
    edges: [{ from: 'sig', to: 'hot' }, { from: 'hot', to: 'tell' }],
  });

  const enabledNamed = async (name: string): Promise<number> => Number((await owner.query(
    `SELECT count(*) AS n FROM alert_rule WHERE enabled AND lower(btrim(name)) = lower(btrim($1))`, [name],
  ))[0].n);

  /** A copy of an existing rule under another slug — the database's view, no service in between. */
  const copyRow = (fromId: string, slug: string, name: string, enabled: boolean, createdAt?: string) => owner.query(
    `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, source_system, external_id,
                             severity, enabled, created_by, updated_by, created_at)
     SELECT tenant_id, $2, $3, trigger, params, applies_to, source_system, external_id,
            severity, $4, created_by, updated_by, COALESCE($5::timestamptz, now())
       FROM alert_rule WHERE id = $1 RETURNING id`,
    [fromId, slug, name, enabled, createdAt ?? null],
  );

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    const month = new Date(); month.setUTCDate(1);
    await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month.toISOString().slice(0, 10)]);
    ds = await createAppDataSource();
    alerts = new AlertService(ds);
    workflows = new WorkflowService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "alert_event", "alert_rule", "workflow_layout", "workflow_version", "workflow_definition", "client_equipment_class", "equipment_profile", "signal_binding_version", "telemetry_reading" CASCADE`);
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals) VALUES ('acme', 'genset', 'Genset', $1::jsonb)`,
      [JSON.stringify([{ signal: COOLANT, unit: 'degC', required: true }])],
    );
    for (const [ext, imei] of [['GEN-1', 'IMEI-1'], ['GEN-2', 'IMEI-2']]) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, origin, status, tier, readiness)
           VALUES ('acme', 'ta-2.0', $1, $1, 'genset', 'client', 'active', 'basic', '{}'::jsonb)`, [ext],
      );
      // Bound and receiving, so a machine-scoped publish is not refused as reading nothing.
      await owner.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
           origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
         VALUES ('acme', 'ta-2.0', $1, $2, $2, '', 'physical', $3, 'ch1', 'degC', '2026-01-01', NULL, true, 'active', 'manual', 'u', '2026-01-01')`,
        [ext, COOLANT, imei],
      );
      await owner.query(
        `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
           VALUES ('acme', $1, $2, 90, $3, $3, 'live')`, [imei, COOLANT, new Date(Date.now() - 60_000)],
      );
    }
  });

  describe('rules written by hand', () => {
    it('refuses a second rule of the same name on the machine — trimmed and case-blind — and writes nothing', async () => {
      await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await expect(alerts.createRule(acme, rule('coolant-hot-2', '  coolant HOT ')))
        .rejects.toThrow('This machine already has an alert rule called "coolant HOT"');
      expect(await enabledNamed('Coolant hot')).toBe(1);
    });

    it('allows the same name on another machine, and on a rule that covers the whole account', async () => {
      await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await alerts.createRule(acme, rule('coolant-hot-gen2', 'Coolant hot', GEN2));
      await alerts.createRule(acme, { ...rule('coolant-hot-all', 'Coolant hot'), appliesTo: 'account', sourceSystem: null, externalId: null });
      expect(await enabledNamed('Coolant hot')).toBe(3);
    });

    it('refuses renaming a rule onto another\'s name; saving a rule under its own name is not a clash', async () => {
      await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      const other = await alerts.createRule(acme, rule('coolant-cold', 'Coolant cold'));
      await expect(alerts.updateRule(acme, other.id, { name: 'Coolant hot' })).rejects.toThrow(ConflictException);
      expect((await alerts.updateRule(acme, other.id, { name: 'Coolant cold', params: { signal: COOLANT, max: 100 } })).name)
        .toBe('Coolant cold');
    });

    it('a rule that is off may share the name, and is refused when switched back on', async () => {
      const first = await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await alerts.setEnabled(acme, first.id, false);
      const second = await alerts.createRule(acme, rule('coolant-hot-2', 'Coolant hot'));
      await expect(alerts.setEnabled(acme, first.id, true)).rejects.toThrow(ConflictException);
      await alerts.setEnabled(acme, second.id, false);
      expect((await alerts.setEnabled(acme, first.id, true)).enabled).toBe(true);
    });

    it('two creates of one name fired together: one lands, the other is told why', async () => {
      const results = await Promise.allSettled([
        alerts.createRule(acme, rule('coolant-hot-a', 'Coolant hot')),
        alerts.createRule(acme, rule('coolant-hot-b', 'Coolant hot')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused?.reason).toBeInstanceOf(ConflictException);
      expect(await enabledNamed('Coolant hot')).toBe(1);
    });
  });

  describe('the database, with no service in front of it', () => {
    it('refuses an enabled duplicate on the machine, and takes a switched-off one', async () => {
      const first = await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await expect(copyRow(first.id, 'raw-dup', 'COOLANT HOT', true))
        .rejects.toMatchObject({ code: '23505', constraint: 'uq_alert_rule_machine_name' });
      await copyRow(first.id, 'raw-off', 'Coolant hot', false);
      expect(await enabledNamed('Coolant hot')).toBe(1);
    });
  });

  describe('rules published from a workflow', () => {
    it('refuses publishing a second workflow whose Notify carries a name the machine already has; Check says so first', async () => {
      const a = await workflows.create(acme, { slug: 'coolant-a', name: 'Coolant A', spec: machineSpec('Coolant hot') });
      await workflows.publish(acme, a.id, 1);
      const b = await workflows.create(acme, { slug: 'coolant-b', name: 'Coolant B', spec: machineSpec('Coolant hot', 110) });
      expect((await workflows.compile(acme, b.id, 1)).publishRefusal).toMatch('already has an alert rule called "Coolant hot"');
      await expect(workflows.publish(acme, b.id, 1)).rejects.toThrow(ConflictException);
      expect(await enabledNamed('Coolant hot')).toBe(1);
    });

    it('refuses one by hand when a workflow already holds the name, and the other way round', async () => {
      const a = await workflows.create(acme, { slug: 'coolant-a', name: 'Coolant A', spec: machineSpec('Coolant hot') });
      await workflows.publish(acme, a.id, 1);
      await expect(alerts.createRule(acme, rule('by-hand', 'Coolant hot'))).rejects.toThrow(ConflictException);

      await alerts.createRule(acme, rule('by-hand-cold', 'Coolant cold'));
      const b = await workflows.create(acme, { slug: 'coolant-b', name: 'Coolant B', spec: machineSpec('Coolant cold') });
      await expect(workflows.publish(acme, b.id, 1)).rejects.toThrow(ConflictException);
    });

    it('republishing the same workflow is not a clash with its own earlier rules', async () => {
      const a = await workflows.create(acme, { slug: 'coolant-a', name: 'Coolant A', spec: machineSpec('Coolant hot') });
      await workflows.publish(acme, a.id, 1);
      await workflows.newVersion(acme, a.id);
      await workflows.replaceSpec(acme, a.id, 2, machineSpec('Coolant hot', 100));
      expect((await workflows.compile(acme, a.id, 2)).publishRefusal).toBeNull();
      await workflows.publish(acme, a.id, 2);
      expect(await enabledNamed('Coolant hot')).toBe(1);
      expect(Number((await owner.query(`SELECT count(*) AS n FROM alert_rule WHERE name = 'Coolant hot'`))[0].n)).toBe(2);
    });

    it('two workflows of one name published together: one lands, the other is refused', async () => {
      const a = await workflows.create(acme, { slug: 'coolant-a', name: 'Coolant A', spec: machineSpec('Coolant hot') });
      const b = await workflows.create(acme, { slug: 'coolant-b', name: 'Coolant B', spec: machineSpec('Coolant hot', 110) });
      const results = await Promise.allSettled([workflows.publish(acme, a.id, 1), workflows.publish(acme, b.id, 1)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      expect(await enabledNamed('Coolant hot')).toBe(1);
    });
  });

  describe('AlertRuleNamePerMachine1765700000000', () => {
    afterAll(async () => {
      // Leave the schema whole for anything after this block.
      await owner.runMigrations({ transaction: 'all' });
    });

    it('renames the duplicates already there — the oldest keeps the name, the rest take the next free number — and both still fire', async () => {
      await undoMigrationNamed(owner, 'AlertRuleNamePerMachine1765700000000');
      const first = await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await owner.query(`UPDATE alert_rule SET created_at = '2026-11-01' WHERE id = $1`, [first.id]);
      const [{ id: second }] = await copyRow(first.id, 'dup-2', 'coolant hot ', true, '2026-11-02');
      const [{ id: third }] = await copyRow(first.id, 'dup-3', 'Coolant hot', true, '2026-11-03');
      // "(2)" is taken already, so the second duplicate becomes "(3)", and the third "(4)".
      await copyRow(first.id, 'taken', 'Coolant hot (2)', true, '2026-10-01');
      const [{ id: off }] = await copyRow(first.id, 'dup-off', 'Coolant hot', false, '2026-11-04');

      await owner.runMigrations({ transaction: 'all' });

      const names = new Map<string, { name: string; enabled: boolean }>(
        (await owner.query(`SELECT id, name, enabled FROM alert_rule`)).map((r: { id: string; name: string; enabled: boolean }) => [r.id, r]),
      );
      expect(names.get(first.id)).toEqual(expect.objectContaining({ name: 'Coolant hot', enabled: true }));
      expect(names.get(second)).toEqual(expect.objectContaining({ name: 'coolant hot (3)', enabled: true }));
      expect(names.get(third)).toEqual(expect.objectContaining({ name: 'Coolant hot (4)', enabled: true }));
      expect(names.get(off)).toEqual(expect.objectContaining({ name: 'Coolant hot', enabled: false }));
      await expect(copyRow(first.id, 'after', 'Coolant hot', true))
        .rejects.toMatchObject({ code: '23505', constraint: 'uq_alert_rule_machine_name' });
    });

    it('down drops the rule, so a duplicate goes in again', async () => {
      const first = await alerts.createRule(acme, rule('coolant-hot', 'Coolant hot'));
      await undoMigrationNamed(owner, 'AlertRuleNamePerMachine1765700000000');
      await copyRow(first.id, 'dup', 'Coolant hot', true);
      expect(await enabledNamed('Coolant hot')).toBe(2);
      await owner.query(`DELETE FROM alert_rule WHERE slug = 'dup'`);
    });
  });
});
