import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../src/audit/audit.service';
import { PlatformAccessLog } from '../src/audit/platform-access-log.entity';
import { capabilitiesFor } from '../src/auth/capabilities';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { ClientCatalogService } from '../src/client-catalog/services/client-catalog.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { ScopedRepository } from '../src/scope/scoped-repository';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The template library and the client's copy of it, and the wall between them.
 *
 * The model: granting a class copies it into the client's account, and from that
 * moment the copy is the client's. Their super admin may rewrite any of it; nobody at
 * Things Alive can write it at all. These tests are about that second half, because
 * it is the part that is easy to believe without checking.
 */
describeDb('client-owned catalog', () => {
  let ds: DataSource;
  let owner: DataSource;
  let authoring: CatalogAuthoringService;
  let copies: CopyOnGrantService;
  let client: ClientCatalogService;

  const NOW = new Date('2026-09-12T00:00:00.000Z');

  const master: RequestScope = {
    tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const acmeSuper: RequestScope = {
    tenantId: 'acme', userId: 'u-acme-super', roles: ['super admin'], isPlatformRole: false,
  };
  const acmeOperator: RequestScope = {
    tenantId: 'acme', userId: 'u-acme-op', roles: ['operational'], isPlatformRole: false,
  };
  const globexSuper: RequestScope = {
    tenantId: 'globex', userId: 'u-globex-super', roles: ['super admin'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate),
    );
    copies = new CopyOnGrantService(ds);
    client = new ClientCatalogService(ds, copies);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['client_scenario', 'client_equipment_class', 'platform_access_log',
      'alert_rule', 'alert_rule_template',
      'scenario_definition', 'equipment_class_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }

    await authoring.createClass(master, 'diesel-generator', {
      name: 'Diesel generator',
      expectedSignals: [
        { signal: 'coolant_temp', unit: 'degC', required: true },
        { signal: 'oil_pressure', unit: 'bar', required: true },
      ],
    });
    await authoring.publishClass(master, 'diesel-generator');
    await authoring.createScenario(master, 'dg-coolant-overheat', {
      equipmentClassSlug: 'diesel-generator',
      name: 'Coolant over-temperature',
      requiredSignals: ['coolant_temp'],
      parameters: [{ key: 'warnC', label: 'Warning', type: 'number', default: 95 }] as any,
    });
    await authoring.publishScenario(master, 'dg-coolant-overheat');
    await copies.copyForTenant('acme', 'diesel-generator', 'u-master', NOW);
  });

  describe('the grant is where ownership transfers', () => {
    it('copies the class and its published scenarios into the account', async () => {
      const [cls] = await client.classes(acmeSuper);
      expect(cls.slug).toBe('diesel-generator');
      expect(cls.templateVersion).toBe(1);
      expect((await client.scenarios(acmeSuper)).map((s) => s.slug)).toEqual(['dg-coolant-overheat']);
    });

    it('never overwrites a copy the client already has', async () => {
      // Re-granting after a revocation restores access. Replacing their copy would be
      // Things Alive editing a client's settings through the side door.
      await client.editScenario(acmeSuper, 'dg-coolant-overheat', { name: 'Ours, renamed' });
      const again = await copies.copyForTenant('acme', 'diesel-generator', 'u-master', NOW);

      expect(again.alreadyPresent).toBe(true);
      const [scenario] = await client.scenarios(acmeSuper);
      expect(scenario.name).toBe('Ours, renamed');
    });
  });

  describe('Things Alive cannot write a client copy', () => {
    it('grants no platform role the capability at all', () => {
      // Not "no route today" — no permission. Adding one later would be a change of
      // model rather than a change of configuration, which is the point.
      for (const role of ['master-admin', 'catalog-author', 'platform-support']) {
        const caps = capabilitiesFor({ ...master, roles: [role] });
        expect(caps['client-catalog.write']).toBe(false);
        expect(caps['client-catalog.read']).toBe(false);
      }
      expect(capabilitiesFor(acmeSuper)['client-catalog.write']).toBe(true);
    });

    it('cannot reach the row even holding a master-admin scope', async () => {
      // The capability is the first wall; this is the second. Every client-catalog
      // method runs inside the caller's own tenant session, so a master admin asking
      // for acme's scenario is asking inside things-alive, where it does not exist.
      await expect(client.editScenario(master, 'dg-coolant-overheat', { enabled: false }))
        .rejects.toThrow(/No scenario/);

      const untouched = await client.scenarios(acmeSuper);
      expect(untouched[0].enabled).toBe(true);
    });

    it('leaves the client copy alone when the template is edited', async () => {
      await authoring.editClass(master, 'diesel-generator', { name: 'Diesel generator (revised)' });
      await authoring.publishClass(master, 'diesel-generator');

      const [cls] = await client.classes(acmeSuper);
      expect(cls.name).toBe('Diesel generator');
      expect(cls.templateVersion).toBe(1);
    });

    it('cannot read one either, except through the audited cross-tenant path', async () => {
      // Support does need to see what is running. It goes through acrossTenants(),
      // which requires a reason and writes the access log before returning a row.
      const audit = new AuditService(ds.getRepository(PlatformAccessLog));
      const repo = new ScopedRepository<ClientScenario>(ds, ClientScenario, {}, audit);

      await expect(repo.acrossTenants(acmeSuper, 'curiosity')).rejects.toBeInstanceOf(ForbiddenException);

      const rows = await repo.acrossTenants(master, 'ticket TA-5512: alert not firing');
      expect(rows.map((r) => r.slug)).toEqual(['dg-coolant-overheat']);

      const [entry] = await owner.getRepository(PlatformAccessLog).find();
      expect(entry.action).toBe('cross-tenant-read');
      expect(entry.reason).toBe('ticket TA-5512: alert not firing');
    });
  });

  describe('the client owns their copy outright', () => {
    it('lets super admin change a threshold the template set', async () => {
      const edited = await client.editScenario(acmeSuper, 'dg-coolant-overheat', {
        parameters: [{ key: 'warnC', label: 'Warning', type: 'number', default: 88 }] as any,
      });
      expect((edited.parameters[0] as any).default).toBe(88);
    });

    it('does not check the edit against the template bounds', async () => {
      // A deliberate consequence of the model, recorded here so nobody later reads
      // its absence as an oversight. The client owns the row; a super admin who wants
      // a shutdown above the engine builder's limit can set one. What the platform
      // does instead is remember that the copy no longer matches what was shipped.
      const edited = await client.editScenario(acmeSuper, 'dg-coolant-overheat', {
        parameters: [{ key: 'warnC', label: 'Warning', type: 'number', default: 400 }] as any,
      });
      expect((edited.parameters[0] as any).default).toBe(400);

      const { provenance } = await client.oneScenario(acmeSuper, 'dg-coolant-overheat');
      expect(provenance.unchangedSinceCopy).toBe(false);
    });

    it('refuses an operator the write, while letting them read', async () => {
      expect(capabilitiesFor(acmeOperator)['client-catalog.read']).toBe(true);
      expect(capabilitiesFor(acmeOperator)['client-catalog.write']).toBe(false);
    });

    it('keeps one account edit out of another account', async () => {
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);
      await client.editScenario(acmeSuper, 'dg-coolant-overheat', { name: 'Acme wording' });

      const [globexScenario] = await client.scenarios(globexSuper);
      expect(globexScenario.name).toBe('Coolant over-temperature');
    });

    it('refuses a required signal the account class does not declare', async () => {
      // The same rule the template seeder enforces. The recommendation engine cannot
      // tell a typo from an absent sensor, so it would tell the customer to fit one
      // they already have.
      await expect(
        client.editScenario(acmeSuper, 'dg-coolant-overheat', { requiredSignals: ['coolent_temp'] }),
      ).rejects.toThrow(/does not declare/);
    });
  });

  describe('provenance answers "is this still what we shipped"', () => {
    it('reports an untouched copy as unchanged', async () => {
      const { provenance } = await client.oneScenario(acmeSuper, 'dg-coolant-overheat');
      expect(provenance.unchangedSinceCopy).toBe(true);
      expect(provenance.templateVersion).toBe(1);
      expect(provenance.newerTemplateAvailable).toBe(false);
    });

    it('notices a newer template without pushing it', async () => {
      await authoring.editScenario(master, 'dg-coolant-overheat', { name: 'Coolant over-temp v2' });
      await authoring.publishScenario(master, 'dg-coolant-overheat');

      const { provenance, name } = await client.oneScenario(acmeSuper, 'dg-coolant-overheat');
      expect(provenance.newerTemplateAvailable).toBe(true);
      expect(provenance.newerTemplateVersion).toBe(2);
      // Offered, not applied. Applying it would be Things Alive editing their settings.
      expect(name).toBe('Coolant over-temperature');
    });

    it('adopts the newer template only when the client asks', async () => {
      await authoring.editScenario(master, 'dg-coolant-overheat', { name: 'Coolant over-temp v2' });
      await authoring.publishScenario(master, 'dg-coolant-overheat');
      await client.editScenario(acmeSuper, 'dg-coolant-overheat', { name: 'Our local wording' });

      const adopted = await client.adoptLatestTemplate(acmeSuper, 'dg-coolant-overheat');
      expect(adopted.name).toBe('Coolant over-temp v2');
      expect(adopted.templateVersion).toBe(2);

      const { provenance } = await client.oneScenario(acmeSuper, 'dg-coolant-overheat');
      expect(provenance.unchangedSinceCopy).toBe(true);
      expect(provenance.newerTemplateAvailable).toBe(false);
    });
  });

  /**
   * Alert rules as catalog content (task P1-128).
   *
   * The point of the whole change: a new account should not have to already know that
   * a diesel generator's coolant matters at 103 °C, well before the 110 °C alarm the
   * manufacturer stamped on it. That knowledge is the product.
   */
  describe('alert rules ship with the class', () => {
    const publishedTemplate = async (over: Record<string, unknown> = {}) => {
      await authoring.createAlertTemplate(master, 'dg-coolant-hot', {
        equipmentClassSlug: 'diesel-generator',
        name: 'Coolant running hot',
        trigger: 'signal-threshold',
        params: { signal: 'coolant_temp', max: 103 } as any,
        severity: 'high' as any,
        ...over,
      });
      return authoring.publishAlertTemplate(master, 'dg-coolant-hot');
    };

    const rulesIn = (tenantId: string) =>
      owner.query(`SELECT * FROM "alert_rule" WHERE "tenant_id" = $1 ORDER BY "slug"`, [tenantId]);

    it('copies published alert templates into the account on grant', async () => {
      await publishedTemplate();
      const result = await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      expect(result.alertRulesCopied).toBe(1);
      const [rule] = await rulesIn('globex');
      expect(rule.slug).toBe('dg-coolant-hot');
      expect(rule.params).toEqual({ signal: 'coolant_temp', max: 103 });
      expect(rule.template_slug).toBe('dg-coolant-hot');
      expect(rule.template_version).toBe(1);
      expect(rule.copied_at).not.toBeNull();
    });

    it('scopes the copy to the class rather than the whole account', async () => {
      // The reason this matters: a rule authored about generators, landing scoped to
      // the account, would fire on the air compressors too — on machines it was never
      // about, in a new customer's first week.
      await publishedTemplate();
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      const [rule] = await rulesIn('globex');
      expect(rule.applies_to).toBe('equipment-class');
      expect(rule.equipment_class_slug).toBe('diesel-generator');
      expect(rule.plant_id).toBeNull();
      expect(rule.external_id).toBeNull();
    });

    it('honours a template that ships switched off', async () => {
      // Some rules are noisy until somebody has looked at the fleet, and shipping
      // those enabled teaches a customer that our alerts are noise.
      await publishedTemplate({ enabledOnCopy: false });
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      const [rule] = await rulesIn('globex');
      expect(rule.enabled).toBe(false);
    });

    it('does not copy a template that is still a draft', async () => {
      await authoring.createAlertTemplate(master, 'dg-unfinished', {
        equipmentClassSlug: 'diesel-generator',
        name: 'Half-written',
        trigger: 'no-telemetry',
        params: {} as any,
      });
      const result = await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      expect(result.alertRulesCopied).toBe(0);
      expect(await rulesIn('globex')).toEqual([]);
    });

    it('leaves a rule the account already has exactly alone', async () => {
      // Re-granting must not reach into an account and restore a rule the client
      // edited or switched off. That would be Things Alive editing their alerting
      // through the side door, which is the whole thing the copy model prevents.
      await publishedTemplate();
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);
      await owner.query(
        `UPDATE "alert_rule" SET "enabled" = false, "params" = $1 WHERE "tenant_id" = 'globex'`,
        [JSON.stringify({ signal: 'coolant_temp', max: 108 })],
      );
      await owner.query(`DELETE FROM "client_equipment_class" WHERE "tenant_id" = 'globex'`);

      const again = await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      expect(again.alertRulesCopied).toBe(0);
      const [rule] = await rulesIn('globex');
      expect(rule.enabled).toBe(false);
      expect(rule.params).toEqual({ signal: 'coolant_temp', max: 108 });
    });

    it('keeps one account\\'s copies out of another', async () => {
      await publishedTemplate();
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      expect(await rulesIn('acme')).toEqual([]);
      expect(await rulesIn('globex')).toHaveLength(1);
    });

    it('refuses a template watching a signal the class does not declare', async () => {
      // It would copy into every account and never fire, and the reason would be
      // invisible from inside the account, because the class is ours.
      await expect(authoring.createAlertTemplate(master, 'dg-nonsense', {
        equipmentClassSlug: 'diesel-generator',
        name: 'Watches nothing',
        trigger: 'signal-threshold',
        params: { signal: 'turbine_rpm', max: 40 } as any,
      })).rejects.toThrow(/turbine_rpm/);
    });

    it('forks a new draft rather than editing a published template', async () => {
      await publishedTemplate();
      await authoring.editAlertTemplate(master, 'dg-coolant-hot', {
        params: { signal: 'coolant_temp', max: 99 } as any,
      });

      const versions = await owner.query(
        `SELECT "version", "status" FROM "alert_rule_template"
         WHERE "slug" = 'dg-coolant-hot' ORDER BY "version"`,
      );
      expect(versions).toEqual([
        { version: 1, status: 'published' },
        { version: 2, status: 'draft' },
      ]);
    });

    it('copies the version that was published, not the draft beside it', async () => {
      await publishedTemplate();
      await authoring.editAlertTemplate(master, 'dg-coolant-hot', {
        params: { signal: 'coolant_temp', max: 99 } as any,
      });
      await copies.copyForTenant('globex', 'diesel-generator', 'u-master', NOW);

      const [rule] = await rulesIn('globex');
      expect(rule.template_version).toBe(1);
      expect(rule.params).toEqual({ signal: 'coolant_temp', max: 103 });
    });
  });

  /**
   * The authoring reads (task P1-133). Separate from the entitlement-narrowed reads
   * on purpose: those return published rows only and must keep doing so.
   */
  describe('the authoring console can see drafts', () => {
    it('lists every version and status, which the client-facing read does not', async () => {
      await authoring.createClass(master, 'air-compressor', {
        name: 'Air compressor',
        expectedSignals: [{ signal: 'discharge_pressure', unit: 'bar', required: true }],
      });

      const all = await authoring.allClasses();
      const bySlug = new Map(all.map((c) => [c.slug, c.status]));
      expect(bySlug.get('diesel-generator')).toBe('published');
      expect(bySlug.get('air-compressor')).toBe('draft');

      // The client-facing read is unchanged: a draft is not a thing a tenant can see,
      // because a tenant that could see it could activate something unfinished.
      expect((await client.classes(acmeSuper)).map((c) => c.slug)).toEqual(['diesel-generator']);
    });

    it('narrows alert templates to one class when asked', async () => {
      await publishedFor('diesel-generator', 'dg-a');
      await authoring.createClass(master, 'air-compressor', {
        name: 'Air compressor',
        expectedSignals: [{ signal: 'discharge_pressure', unit: 'bar', required: true }],
      });
      await publishedFor('air-compressor', 'ac-a');

      expect((await authoring.allAlertTemplates('diesel-generator')).map((t) => t.slug))
        .toEqual(['dg-a']);
      expect((await authoring.allAlertTemplates()).map((t) => t.slug).sort())
        .toEqual(['ac-a', 'dg-a']);
    });

    const publishedFor = async (classSlug: string, slug: string) => {
      await authoring.createAlertTemplate(master, slug, {
        equipmentClassSlug: classSlug,
        name: slug,
        trigger: 'no-telemetry',
        params: {} as any,
      });
      return authoring.publishAlertTemplate(master, slug);
    };
  });

  describe('template authoring', () => {
    it('forks a new draft rather than editing a published version', async () => {
      // Under the copy model no live alert runs on a template, so this is no longer
      // about protecting running alerts. It is about provenance: every copy records
      // the version it came from, and a version edited in place makes that a lie.
      await authoring.editClass(master, 'diesel-generator', { name: 'Revised' });

      const versions = await ds.getRepository(EquipmentClassProfile)
        .find({ where: { slug: 'diesel-generator' }, order: { version: 'ASC' } });
      expect(versions.map((v) => [v.version, v.status])).toEqual([[1, 'published'], [2, 'draft']]);
    });

    it('refuses to publish a class that declares no signals', async () => {
      // Every scenario on it would be permanently blocked, naming signals the class
      // never promised.
      await authoring.createClass(master, 'empty-class', { name: 'Empty' });
      await expect(authoring.publishClass(master, 'empty-class')).rejects.toThrow(/no expected signals/);
    });

    it('refuses a template scenario requiring a signal its class does not declare', async () => {
      await expect(
        authoring.createScenario(master, 'dg-typo', {
          equipmentClassSlug: 'diesel-generator', requiredSignals: ['collant_temp'],
        }),
      ).rejects.toThrow(/does not declare/);
    });

    it('retires a template without disturbing copies already made from it', async () => {
      await authoring.retireClass(master, 'diesel-generator');
      const [cls] = await client.classes(acmeSuper);
      expect(cls.status).toBe('active');
      expect((await client.scenarios(acmeSuper))).toHaveLength(1);
    });
  });
});
