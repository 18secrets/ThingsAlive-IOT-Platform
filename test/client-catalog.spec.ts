import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../src/audit/audit.service';
import { PlatformAccessLog } from '../src/audit/platform-access-log.entity';
import { capabilitiesFor } from '../src/auth/capabilities';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
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
    );
    copies = new CopyOnGrantService(ds);
    client = new ClientCatalogService(ds, copies);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['client_scenario', 'client_equipment_class', 'platform_access_log',
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
