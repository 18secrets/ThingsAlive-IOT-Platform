import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientCatalogEntitlement } from '../src/catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogService } from '../src/catalog/services/catalog.service';
import { RecommendationService } from '../src/catalog/services/recommendation.service';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Which scenarios an asset can run, and why not (task P1-10).
 *
 * Every assertion below is about metadata the platform recorded: a class binding, a
 * sensor map, a declared requirement, the age of the oldest reading. Nothing is
 * inferred from the shape of the data, because a recommendation engine that guesses
 * produces a list that is confidently wrong — and the customer's first experience of
 * the product is activating something that then never fires.
 */
describeDb('recommendations', () => {
  let ds: DataSource;
  let owner: DataSource;
  let service: RecommendationService;

  const SOURCE = 'iot-platform-1';
  const NOW = new Date('2026-09-12T00:00:00.000Z');

  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const catalog = new CatalogService(
      ds.getRepository(EquipmentClassProfile),
      ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias),
      ds.getRepository(ClientCatalogEntitlement),
    );
    service = new RecommendationService(ds, catalog);
  });

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'sensor_map_projection', 'device_projection',
      'equipment_profile', 'client_catalog_entitlement', 'scenario_definition',
      'equipment_class_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }

    await owner.getRepository(EquipmentClassProfile).save({
      slug: 'diesel-generator', version: 1, status: 'published', name: 'Diesel generator',
      description: null, category: 'power', expectedSignals: [], failureModes: [],
      defaultThresholds: {}, publishedAt: NOW,
    });
    await owner.getRepository(ScenarioDefinition).save([
      // Needs one signal, no history. The simple case.
      define('fuel-theft', ['fuel_level'], 0, 1),
      // Needs a signal the asset does not report.
      define('coolant-loss', ['coolant_temp'], 0, 1),
      // Needs history the asset has not accumulated.
      define('load-drift', ['fuel_level'], 30, 1),
      // Needs a tier the asset is not on.
      define('bearing-failure', ['fuel_level'], 0, 3),
    ]);
    await owner.getRepository(ClientCatalogEntitlement).save({
      tenantId: 'acme', equipmentClassSlug: 'diesel-generator', grantedBy: 'u-master', note: null,
    });
  });

  const define = (slug: string, requiredSignals: string[], minimumHistoryDays: number, tier: any) => ({
    slug, version: 1, equipmentClassSlug: 'diesel-generator', status: 'published' as any,
    name: slug, description: null, severity: 'high' as any, tier,
    requiredSignals, minimumHistoryDays, parameters: [], publishedAt: NOW,
  });

  /** An asset with a device, a sensor map and some history. */
  async function seedAsset(opts: {
    externalId: string;
    signals?: string[];
    tier?: any;
    classSlug?: string | null;
    firstReadingDaysAgo?: number | null;
    withDevice?: boolean;
  }) {
    const imei = `imei-${opts.externalId}`;
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: SOURCE, externalId: opts.externalId,
        equipmentClassSlug: opts.classSlug === undefined ? 'diesel-generator' : opts.classSlug,
        classVersion: 1, tier: opts.tier ?? 'standard', commissionedAt: null,
        serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
      });
      if (opts.withDevice === false) return;

      await m.getRepository(DeviceProjection).save({
        sourceSystem: SOURCE, externalId: `dev-${opts.externalId}`, tenantId: 'acme',
        payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: `c-${opts.externalId}`,
        status: 'live', imei, equipmentExternalId: opts.externalId, name: null,
      });
      for (const signal of opts.signals ?? ['fuel_level']) {
        await m.getRepository(SensorMapProjection).save({
          sourceSystem: SOURCE, externalId: `${imei}-${signal}`, tenantId: 'acme',
          payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: `c-${signal}`,
          status: 'live', imei, signal, sensorName: signal, unit: null,
        });
      }
      if (opts.firstReadingDaysAgo != null) {
        const at = new Date(NOW.getTime() - opts.firstReadingDaysAgo * 86_400_000);
        await m.getRepository(TelemetryReading).save({
          tenantId: 'acme', imei, signal: 'fuel_level', value: 50, unit: '%',
          sourceTimestamp: at, receivedAt: at, source: 'live',
        });
      }
    });
  }

  const bucketOf = (recs: any[], slug: string) => recs.find((r) => r.scenarioSlug === slug);

  it('marks a scenario available when every declared requirement is met', async () => {
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: 60 });
    const { recommendations } = await service.forEquipment(acme, SOURCE, 'DG-1', NOW);
    expect(bucketOf(recommendations, 'fuel-theft').bucket).toBe('availableNow');
    expect(bucketOf(recommendations, 'fuel-theft').blockedBy).toEqual([]);
  });

  it('names the missing sensor rather than just saying no', async () => {
    // "Not enough data" gives an operator nothing to do. A signal name tells them
    // which sensor to fit.
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: 60 });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'coolant-loss');
    expect(rec.bucket).toBe('availableLater');
    expect(rec.blockedBy).toEqual([{ code: 'missing-signals', signals: ['coolant_temp'] }]);
    expect(rec.estimatedReadyDate).toBeNull();
  });

  it('dates the wait when time is the only thing missing', async () => {
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: 10 });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'load-drift');
    expect(rec.bucket).toBe('availableLater');
    expect(rec.blockedBy).toEqual([{ code: 'insufficient-history', haveDays: 10, needDays: 30 }]);
    // First reading was 10 days ago and it needs 30, so 20 days from now.
    expect(rec.estimatedReadyDate).toBe('2026-10-02T00:00:00.000Z');
  });

  it('offers no date when the blockage is not time', async () => {
    // A date next to a missing sensor is a promise nobody is keeping.
    await seedAsset({ externalId: 'DG-1', signals: [], firstReadingDaysAgo: 10 });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'load-drift');
    expect(rec.estimatedReadyDate).toBeNull();
    expect(rec.blockedBy.map((b: any) => b.code).sort()).toEqual(['insufficient-history', 'missing-signals']);
  });

  it('offers no date when no reading has ever arrived', async () => {
    // There is no start date to count from, and inventing one puts a confident date
    // on a screen that nothing is working towards.
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: null });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'load-drift');
    expect(rec.bucket).toBe('availableLater');
    expect(rec.estimatedReadyDate).toBeNull();
  });

  it('reports the service tier as the blocker when that is what it is', async () => {
    await seedAsset({ externalId: 'DG-1', tier: 'basic', firstReadingDaysAgo: 60 });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'bearing-failure');
    expect(rec.blockedBy).toEqual([{ code: 'tier-too-low', have: 'basic', needs: 3 }]);
  });

  it('tells an unclassified asset what to do instead of showing nothing', async () => {
    // The ordinary state on day one. An empty list reads as "nothing is available for
    // this machine", which is the wrong conclusion to leave a customer with.
    await seedAsset({ externalId: 'DG-1', classSlug: null, firstReadingDaysAgo: 60 });
    const { equipmentClassSlug, recommendations } = await service.forEquipment(acme, SOURCE, 'DG-1', NOW);
    expect(equipmentClassSlug).toBeNull();
    expect(recommendations).toHaveLength(4);
    expect(recommendations.every((r) => r.blockedBy[0].code === 'unclassified')).toBe(true);
  });

  it('reports notApplicable when the class is not entitled, not an empty list', async () => {
    await owner.query(`UPDATE client_catalog_entitlement SET revoked_at = now()`);
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: 60 });
    const { recommendations } = await service.forEquipment(acme, SOURCE, 'DG-1', NOW);
    expect(recommendations.every((r) => r.bucket === 'notApplicable')).toBe(true);
  });

  it('says there is no device when there is no device', async () => {
    await seedAsset({ externalId: 'DG-1', withDevice: false });
    const rec = bucketOf((await service.forEquipment(acme, SOURCE, 'DG-1', NOW)).recommendations, 'fuel-theft');
    expect(rec.blockedBy.map((b: any) => b.code)).toContain('no-device');
  });

  it('does not see another tenant equipment profile', async () => {
    await seedAsset({ externalId: 'DG-1', firstReadingDaysAgo: 60 });
    const other: RequestScope = { ...acme, tenantId: 'globex', userId: 'u-globex' };
    // globex has no entitlement and no profile row; the answer is an unclassified
    // asset with an empty catalog, never acme's classification.
    const { equipmentClassSlug, recommendations } = await service.forEquipment(other, SOURCE, 'DG-1', NOW);
    expect(equipmentClassSlug).toBeNull();
    expect(recommendations).toEqual([]);
  });
});
