import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertEvent } from '../src/alert/entities/alert-event.entity';
import { AlertService } from '../src/alert/services/alert.service';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EntitlementService } from '../src/catalog/services/entitlement.service';
import { Severity } from '../src/common/severity';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { alertRuleContentChecksum } from '../src/client-catalog/services/provenance';
import { checksumOf } from '../src/projection/services/checksum';
import { queueVaniCalls } from '../src/vani/vani-queue';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * An alert rule's recommended action, and Vani saying it
 * (`1765800000000-AlertRecommendedAction.ts`).
 *
 * The field travels template → the account's copy → the call packet, and each hop is
 * tested where it happens: the copy through a real grant, the packet through the
 * queue the alert engine calls. What must not happen is tested by attempting it: a
 * blank or overlong action refused by the database, an edit after the alert changing
 * what the customer was told, and every rule copied before this column existed
 * suddenly reading as edited.
 */
describeDb('alert rules: a recommended action Vani can say', () => {
  let owner: DataSource;
  let app: DataSource;
  let alerts: AlertService;

  const SRC = 'ta-2.0';
  const boss: RequestScope = { tenantId: 'usa-test', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const ACTION = 'Schedule a bearing inspection within the week. No immediate shutdown is needed.';

  const rule = (over: Record<string, unknown> = {}) => ({
    slug: 'bearing-hot', name: 'Main bearing vibration rising',
    trigger: 'prediction-severity' as const, params: { atLeast: Severity.High },
    ...over,
  });

  const asTenant = <R>(tenant: string, fn: (m: EntityManager) => Promise<R>) =>
    app.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn(m);
    });

  const alertFor = async (ruleId: string): Promise<AlertEvent> => {
    const [row] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('usa-test', $1, 'Main bearing vibration rising', $2, 'DG-01', 'critical', 'Bearing vibration high', '{}'::jsonb, 'open', now())
       RETURNING id`,
      [ruleId, SRC],
    );
    return owner.getRepository(AlertEvent).findOneByOrFail({ id: row.id });
  };

  const packetFor = async (a: AlertEvent) => {
    expect(await asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]))).toBe(1);
    const [row] = await owner.query(`SELECT request FROM vani_call WHERE alert_event_id = $1`, [a.id]);
    return row.request;
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    alerts = new AlertService(app);

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'usa-test')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('usa-test', $1, 'DG-01', 'DG-01', 'client', 'active', 'basic', '{}'::jsonb)`,
      [SRC],
    );
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`,
      [SRC],
    );
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['vani_call', 'alert_event', 'alert_rule', 'alert_rule_template',
      'client_scenario', 'client_equipment_class', 'client_catalog_entitlement', 'equipment_class_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  describe('the database refuses what would be read aloud badly', () => {
    it('refuses a blank action and a paragraph on a rule', async () => {
      await expect(alerts.createRule(boss, rule({ recommendedAction: '   ' })))
        .rejects.toThrow(/ck_alert_rule_recommended_action/);
      await expect(alerts.createRule(boss, rule({ recommendedAction: 'x'.repeat(301) })))
        .rejects.toThrow(/ck_alert_rule_recommended_action/);
    });

    it('refuses the same on a template', async () => {
      await expect(owner.query(
        `INSERT INTO alert_rule_template (slug, version, equipment_class_slug, name, trigger, params, severity, recommended_action)
           VALUES ('t', 1, 'diesel-generator', 'T', 'prediction-severity', '{}', 'high', '')`,
      )).rejects.toThrow(/ck_alert_rule_template_recommended_action/);
    });
  });

  describe('the call packet', () => {
    it('carries the rule\'s action as recommended_action', async () => {
      const r = await alerts.createRule(boss, rule({ recommendedAction: ACTION }));
      const request = await packetFor(await alertFor(r.id));
      expect(request.context.recommended_action).toBe(ACTION);
    });

    it('carries no recommended_action at all when the rule has none', async () => {
      // Absent, not empty and not composed: Vani says nothing rather than something made up.
      const r = await alerts.createRule(boss, rule());
      const request = await packetFor(await alertFor(r.id));
      expect(request.context).not.toHaveProperty('recommended_action');
    });

    it('keeps what was queued when the rule is edited after the alert fired', async () => {
      const r = await alerts.createRule(boss, rule({ recommendedAction: ACTION }));
      const a = await alertFor(r.id);
      await packetFor(a);
      await alerts.updateRule(boss, r.id, { recommendedAction: 'Shut it down now.' });
      const [row] = await owner.query(`SELECT request FROM vani_call WHERE alert_event_id = $1`, [a.id]);
      expect(row.request.context.recommended_action).toBe(ACTION);
    });
  });

  describe('editing a rule', () => {
    it('keeps the action when a patch leaves it out, and clears it on null', async () => {
      const r = await alerts.createRule(boss, rule({ recommendedAction: ACTION }));
      expect((await alerts.updateRule(boss, r.id, { name: 'Bearing vibration rising' })).recommendedAction).toBe(ACTION);
      expect((await alerts.updateRule(boss, r.id, { recommendedAction: null })).recommendedAction).toBeNull();
    });
  });

  describe('from the library', () => {
    const grantWithTemplate = async (action: string | null) => {
      await owner.getRepository(EquipmentClassProfile).save({
        slug: 'diesel-generator', version: 1, status: 'published' as any, name: 'Diesel generator',
        description: null, category: 'power', expectedSignals: [], failureModes: [],
        defaultThresholds: {}, publishedAt: new Date(),
      } as any);
      await owner.query(
        `INSERT INTO alert_rule_template
           (slug, version, equipment_class_slug, name, trigger, params, severity, enabled_on_copy, status, published_at, recommended_action)
         VALUES ('bearing-hot', 1, 'diesel-generator', 'Main bearing vibration rising', 'prediction-severity',
                 $1, 'critical', true, 'published', now(), $2)`,
        [JSON.stringify({ atLeast: Severity.High }), action],
      );
      const entitlements = new EntitlementService(
        owner.getRepository(ClientCatalogEntitlement), owner.getRepository(EquipmentClassProfile), new CopyOnGrantService(owner),
      );
      await entitlements.grant(master, 'usa-test', 'diesel-generator');
      const [copy] = await alerts.listRules(boss);
      return copy;
    };

    it('copies the template\'s action into the account, reading as unchanged until edited', async () => {
      const copy = await grantWithTemplate(ACTION);
      expect(copy.recommendedAction).toBe(ACTION);
      expect(copy.provenance.unchangedSinceCopy).toBe(true);

      // The action becomes the account's own words, and changing them is an edit.
      await alerts.updateRule(boss, copy.id, { recommendedAction: 'Inspect the bearing this week.' });
      const [edited] = await alerts.listRules(boss);
      expect(edited.provenance.unchangedSinceCopy).toBe(false);
    });

    it('hashes a rule with no action exactly as before the column existed', async () => {
      // Every rule copied before this migration carries a checksum computed without the
      // field. If a null action changed the hash, all of them would read as edited.
      const copy = await grantWithTemplate(null);
      const before = checksumOf({
        name: copy.name, description: copy.description, trigger: copy.trigger,
        params: copy.params, severity: copy.severity, enabled: copy.enabled,
      });
      expect(alertRuleContentChecksum(copy)).toBe(before);
      expect(copy.provenance.unchangedSinceCopy).toBe(true);
    });
  });

  it('undoes cleanly, by name', async () => {
    await undoMigrationNamed(owner, 'AlertRecommendedAction1765800000000');
    const cols = await owner.query(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'recommended_action'`);
    expect(cols).toEqual([]);
    await owner.runMigrations({ transaction: 'all' });
  });
});
