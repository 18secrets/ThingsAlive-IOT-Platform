import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogService } from '../src/catalog/services/catalog.service';
import { EntitlementService } from '../src/catalog/services/entitlement.service';
import { createTestDataSource, describeDb } from './db';

/**
 * The catalog, and the entitlement join that narrows it (tasks P1-01, P1-04).
 *
 * The catalog has no tenant column, so row-level security cannot help here — the
 * join is the only thing standing between one customer and the list of everything
 * Things Alive sells. That makes these assertions the whole control.
 */
describeDb('catalog', () => {
  let ds: DataSource;
  let catalog: CatalogService;
  let entitlements: EntitlementService;

  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false,
  };
  const globex: RequestScope = {
    tenantId: 'globex', userId: 'u-globex', roles: ['operational'], isPlatformRole: false,
  };
  const master: RequestScope = {
    tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
    catalog = new CatalogService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(ClientCatalogEntitlement),
    );
    entitlements = new EntitlementService(
      ds.getRepository(ClientCatalogEntitlement),
      ds.getRepository(EquipmentClassProfile),
    );
  });

  afterAll(async () => { await ds?.destroy(); });

  beforeEach(async () => {
    await ds.query(`DELETE FROM client_catalog_entitlement`);
    await ds.query(`DELETE FROM scenario_definition`);
    await ds.query(`DELETE FROM equipment_class_profile`);
    await ds.query(`DELETE FROM signal_alias`);

    const classes = ds.getRepository(EquipmentClassProfile);
    await classes.save([
      classRow('diesel-generator', 1, 'published'),
      // A second version of the same class: only this one should ever be returned.
      classRow('diesel-generator', 2, 'published'),
      classRow('cnc-machine', 1, 'published'),
      // Drafts are invisible to tenants — activating something Things Alive has not
      // finished writing is not a choice a customer should be offered.
      classRow('air-compressor', 1, 'draft'),
    ]);

    await ds.getRepository(ScenarioDefinition).save([
      scenarioRow('fuel-theft', 1, 'diesel-generator', 'published'),
      scenarioRow('fuel-theft', 2, 'diesel-generator', 'published'),
      scenarioRow('coolant-loss', 1, 'diesel-generator', 'draft'),
      scenarioRow('spindle-wear', 1, 'cnc-machine', 'published'),
    ]);

    await entitlements.grant(master, 'acme', 'diesel-generator');
  });

  const classRow = (slug: string, version: number, status: any) => ({
    slug, version, status, name: `${slug} v${version}`,
    description: null, category: 'power', expectedSignals: [], failureModes: [],
    defaultThresholds: { oemMax: 95 }, publishedAt: status === 'published' ? new Date() : null,
  });

  const scenarioRow = (slug: string, version: number, equipmentClassSlug: string, status: any) => ({
    slug, version, equipmentClassSlug, status, name: `${slug} v${version}`,
    description: null, severity: 'high' as any, tier: 1 as any,
    requiredSignals: ['fuel_level'], minimumHistoryDays: 0, parameters: [],
    publishedAt: status === 'published' ? new Date() : null,
  });

  it('shows a tenant only the classes it has been granted', async () => {
    const mine = await catalog.equipmentClasses(acme);
    expect(mine.map((c) => c.slug)).toEqual(['diesel-generator']);

    // Not "an empty list because something failed" — an empty list because nothing
    // was granted, which is the correct answer for a tenant mid-onboarding.
    expect(await catalog.equipmentClasses(globex)).toEqual([]);
  });

  it('returns only the latest published version of a class', async () => {
    const [dg] = await catalog.equipmentClasses(acme);
    expect(dg.version).toBe(2);
  });

  it('never shows a draft, even to the tenant that owns the class', async () => {
    await entitlements.grant(master, 'acme', 'air-compressor');
    const slugs = (await catalog.equipmentClasses(acme)).map((c) => c.slug);
    expect(slugs).not.toContain('air-compressor');
  });

  it('404s an unentitled class rather than 403ing it', async () => {
    // A 403 confirms the class exists. That is commercial information: it tells a
    // customer what Things Alive sells, and by enumeration, roughly to whom.
    await expect(catalog.equipmentClass(acme, 'cnc-machine')).rejects.toBeInstanceOf(NotFoundException);
    await expect(catalog.equipmentClass(acme, 'no-such-class')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gives a platform role the whole catalog', async () => {
    const slugs = (await catalog.equipmentClasses(master)).map((c) => c.slug).sort();
    expect(slugs).toEqual(['cnc-machine', 'diesel-generator']);
  });

  it('lists scenarios only for entitled classes, latest published version', async () => {
    const scenarios = await catalog.scenarios(acme);
    expect(scenarios.map((s) => s.slug)).toEqual(['fuel-theft']);
    expect(scenarios[0].version).toBe(2);
  });

  describe('grants', () => {
    it('refuses a grant for a class that does not exist', async () => {
      // Almost always a typo in a slug, and it would sit there looking like a working
      // entitlement while the customer's catalog stayed empty.
      await expect(entitlements.grant(master, 'acme', 'diesle-generator')).rejects.toThrow(/No equipment class/);
    });

    it('revokes without deleting, and re-granting reuses the row', async () => {
      const [grant] = await entitlements.list(master);
      await entitlements.revoke(master, grant.id);
      expect(await catalog.equipmentClasses(acme)).toEqual([]);

      const all = await entitlements.list(master);
      expect(all).toHaveLength(1);
      expect(all[0].revokedAt).not.toBeNull();
      expect(all[0].revokedBy).toBe('u-master');

      const again = await entitlements.grant(master, 'acme', 'diesel-generator');
      expect(again.id).toBe(grant.id);
      expect(again.revokedAt).toBeNull();
      expect((await catalog.equipmentClasses(acme)).map((c) => c.slug)).toEqual(['diesel-generator']);
    });
  });

  describe('signal aliases', () => {
    beforeEach(async () => {
      await ds.getRepository(SignalAlias).save([
        { sourceSystem: '*', alias: 'fuellevel', canonical: 'fuel_level', unit: '%', note: null },
        { sourceSystem: '*', alias: 'fuel_pct', canonical: 'fuel_level', unit: '%', note: null },
        { sourceSystem: 'iot-platform-1', alias: 'fuellevel', canonical: 'fuel_litres', unit: 'L', note: null },
      ]);
    });

    it('resolves case-insensitively, because firmware is not consistent', async () => {
      const map = await catalog.aliasMap('other-source');
      expect(catalog.canonicalise('FuelLevel', map)).toBe('fuel_level');
      expect(catalog.canonicalise('FUEL_PCT', map)).toBe('fuel_level');
    });

    it('lets a source-specific alias win over the wildcard', async () => {
      // Order of rows from the database is not a contract. If the wildcard could win
      // by arriving second, the same query would resolve differently between runs.
      const map = await catalog.aliasMap('iot-platform-1');
      expect(catalog.canonicalise('fuellevel', map)).toBe('fuel_litres');
    });

    it('leaves an unknown spelling alone', async () => {
      // Unmapped is not the same as wrong. Rewriting it to something plausible is how
      // a signal silently becomes a different signal.
      const map = await catalog.aliasMap('iot-platform-1');
      expect(catalog.canonicalise('oil_pressure', map)).toBe('oil_pressure');
    });
  });
});
