import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogService } from '../src/catalog/services/catalog.service';
import { RecommendationService } from '../src/catalog/services/recommendation.service';
import { seedCatalog } from '../src/database/seeds/seed-catalog';
import { DEMO_FLEET, seedDemoFleet } from '../src/database/seeds/seed-demo-fleet';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The shipped catalog content, exercised end to end (tasks P1-02, P1-03, P1-11).
 *
 * This runs the real seed files rather than fixtures invented for the test. A
 * profile that loads cleanly but produces nothing useful is the failure this
 * catches: the seeder's own consistency checks say the file is well-formed, and
 * only running it through the recommendation engine says it is worth having.
 */
describeDb('seeded catalog', () => {
  let ds: DataSource;
  let owner: DataSource;
  let recommendations: RecommendationService;
  let catalog: CatalogService;

  const SOURCE = 'iot-platform-1';
  const demo: RequestScope = {
    tenantId: 'demo-tenant', userId: 'u-demo', roles: ['admin'], isPlatformRole: false,
  };
  const master: RequestScope = {
    tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    catalog = new CatalogService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(ClientCatalogEntitlement),
    );
    recommendations = new RecommendationService(ds, catalog);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const spec = (externalId: string) => DEMO_FLEET.find((a) => a.externalId === externalId)!;
  const forAsset = (externalId: string) =>
    recommendations.forEquipment(demo, SOURCE, externalId, new Date());

  describe('loaded as drafted', () => {
    beforeAll(async () => {
      await seedCatalog(owner.manager, false);
    }, 30_000);

    it('loads both classes and every scenario', async () => {
      const classes = await owner.getRepository(EquipmentClassProfile).find();
      expect(classes.map((c) => c.slug).sort()).toEqual(['cnc-machining-centre', 'diesel-generator']);
      expect(await owner.getRepository(ScenarioDefinition).count()).toBeGreaterThanOrEqual(20);
      expect(await owner.getRepository(SignalAlias).count()).toBeGreaterThanOrEqual(60);
    });

    it('ships everything as draft, so nothing can be activated before review', async () => {
      // The content is drafted from OEM documentation, not reviewed by anyone who has
      // stood next to one of these machines. A drafted threshold and a reviewed one
      // look identical in a JSON file; the status column is what tells them apart.
      const statuses = new Set([
        ...(await owner.getRepository(EquipmentClassProfile).find()).map((c) => c.status),
        ...(await owner.getRepository(ScenarioDefinition).find()).map((s) => s.status),
      ]);
      expect([...statuses]).toEqual(['draft']);

      // And draft means invisible, not merely labelled.
      expect(await catalog.equipmentClasses(master)).toEqual([]);
    });

    it('refuses to load a scenario requiring a signal its class does not declare', async () => {
      // A typo in a signal name produces a scenario that is permanently blocked with
      // missing-signals: ['coolent_temp'], telling a customer to fit a sensor that is
      // already fitted. The engine cannot tell a misspelling from an absent sensor,
      // so the catalog refuses the misspelling at load time.
      const { checkSignalsDeclared } = await import('../src/database/seeds/seed-catalog');
      const problems = checkSignalsDeclared(
        [{ slug: 'dg', expectedSignals: [{ signal: 'coolant_temp' }], failureModes: [] }] as any,
        [{ slug: 's1', equipmentClassSlug: 'dg', requiredSignals: ['coolent_temp'] }] as any,
      );
      expect(problems).toEqual([
        's1: requires "coolent_temp", which dg does not declare',
      ]);
    });
  });

  describe('published, with the demo fleet', () => {
    beforeAll(async () => {
      await seedCatalog(owner.manager, true);
      await seedDemoFleet(owner);
    }, 30_000);

    it('is idempotent — a second run changes nothing', async () => {
      const before = await owner.getRepository(ScenarioDefinition).count();
      await seedCatalog(owner.manager, true);
      await seedDemoFleet(owner);
      expect(await owner.getRepository(ScenarioDefinition).count()).toBe(before);
    }, 30_000);

    it('resolves the wire signal names the fleet actually sends', async () => {
      // The demo fleet's sensor map carries the OBD-CAN decoder's own field names —
      // coolant_temp_c, oil_pressure_scaled, battery_voltage_v — and the scenarios
      // require the canonical spellings. If the alias table were not consulted, every
      // genset scenario would report missing-signals, and the whole catalog would
      // look broken for a fleet that is sending exactly the right data.
      expect(spec('DG-KOEL-125-001').signals).toContain('coolant_temp_c');

      const { recommendations: recs } = await forAsset('DG-KOEL-125-001');
      const overheat = recs.find((r) => r.scenarioSlug === 'dg-coolant-overheat')!;
      expect(overheat.bucket).toBe('availableNow');
      expect(overheat.blockedBy).toEqual([]);
    });

    it('gives the fully-instrumented set a usable list rather than a token one', async () => {
      const { recommendations: recs } = await forAsset('DG-KOEL-125-001');
      const now = recs.filter((r) => r.bucket === 'availableNow');
      // A catalog that ships and leaves every scenario blocked is not a catalog.
      expect(now.length).toBeGreaterThanOrEqual(8);
      expect(now.map((r) => r.scenarioSlug)).toEqual(
        expect.arrayContaining(['dg-coolant-overheat', 'dg-lube-oil-pressure-loss', 'dg-fuel-pilferage']),
      );
    });

    it('names the commercial blocker separately from the engineering one', async () => {
      // Same hardware, lower tier. "Fit a sensor" and "buy an upgrade" are different
      // conversations and must not arrive on screen as the same word.
      const advanced = await forAsset('DG-KOEL-125-001');
      const basic = await forAsset('DG-KOEL-125-002');

      const tierBlocked = (r: any) => r.blockedBy.some((b: any) => b.code === 'tier-too-low');
      expect(basic.recommendations.filter(tierBlocked).length)
        .toBeGreaterThan(advanced.recommendations.filter(tierBlocked).length);
    });

    it('dates the wait for a newly commissioned set, and only where time is the blocker', async () => {
      const { recommendations: recs } = await forAsset('DG-CUMMINS-62-003');
      const dated = recs.filter((r) => r.estimatedReadyDate);
      expect(dated.length).toBeGreaterThan(0);
      for (const r of dated) {
        expect(r.blockedBy.every((b) => b.code === 'insufficient-history')).toBe(true);
      }
    });

    it('offers no date for a set that has never reported', async () => {
      // Mapped, fitted, silent. There is no first reading to count thirty days from.
      const { recommendations: recs } = await forAsset('DG-KOEL-30-005');
      expect(recs.some((r) => r.blockedBy.some((b) => b.code === 'insufficient-history'))).toBe(true);
      expect(recs.every((r) => r.estimatedReadyDate === null)).toBe(true);
    });

    it('says "no device" without reciting every signal that logger would have sent', async () => {
      // The action is "fit a logger", not "fit eight sensors", and nobody knows yet
      // which signals that logger will carry. A blocker list is only useful while
      // somebody still reads it.
      const { recommendations: recs } = await forAsset('DG-NODEVICE-007');
      expect(recs.every((r) => r.blockedBy.some((b) => b.code === 'no-device'))).toBe(true);
      expect(recs.some((r) => r.blockedBy.some((b) => b.code === 'missing-signals'))).toBe(false);
    });

    it('reports an unclassified asset as one fixable thing', async () => {
      const { equipmentClassSlug, recommendations: recs } = await forAsset('DG-UNKNOWN-006');
      expect(equipmentClassSlug).toBeNull();
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((r) => r.blockedBy[0].code === 'unclassified')).toBe(true);
    });

    it('separates "wait" from "there is nothing to wait for"', async () => {
      const { recommendations: recs } = await forAsset('DG-RETIRED-CLASS-009');
      expect(recs.every((r) => r.bucket === 'notApplicable')).toBe(true);
    });

    it('tells the truth about the CNC: the fleet cannot collect any of it', async () => {
      // The most useful thing this catalog does on day one is say plainly that a
      // machining centre needs a control interface or retrofit sensors, rather than
      // showing an empty screen the customer reads as "nothing works".
      const { recommendations: recs } = await forAsset('CNC-JYOTI-VMC-008');
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((r) => r.bucket === 'availableLater')).toBe(true);
      expect(recs.every((r) => r.blockedBy.length > 0)).toBe(true);
    });

    it('exercises every bucket and every blocker code across the fleet', async () => {
      // The fleet exists to make the whole answer space visible in one place. If a
      // code stops appearing, either the engine changed or the fixture rotted, and
      // both are worth failing on.
      const buckets = new Set<string>();
      const codes = new Set<string>();
      for (const asset of DEMO_FLEET) {
        const { recommendations: recs } = await forAsset(asset.externalId);
        for (const r of recs) {
          buckets.add(r.bucket);
          r.blockedBy.forEach((b) => codes.add(b.code));
        }
      }
      expect([...buckets].sort()).toEqual(['availableLater', 'availableNow', 'notApplicable']);
      expect([...codes].sort()).toEqual([
        'class-not-entitled', 'insufficient-history', 'missing-signals',
        'no-device', 'tier-too-low', 'unclassified',
      ]);
    }, 30_000);
  });
});
