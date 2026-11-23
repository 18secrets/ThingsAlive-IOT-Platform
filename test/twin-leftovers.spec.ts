import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { S3AssetStorage, READ_URL_WINDOW_SECONDS } from '../src/assets/asset-storage';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { LayoutInput, SiteTwinService } from '../src/site-twin/site-twin.service';
import { createTestDataSource, describeDb } from './db';

const SRC = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
// Scoped to the excavator alone, so never shown the generator or its room.
const narrow: RequestScope = { ...acme, userId: 'u-narrow', equipmentIds: ['EX-1'] };
const demo: RequestScope = { tenantId: 'demo-construction', userId: 'u-demo', roles: ['admin'], isPlatformRole: false };

jest.setTimeout(60_000);

/**
 * What was left open on the site twin in the testing notes of 5 Nov: a scoped save that
 * deleted a structure its user was never shown, road progress the composer made up on a
 * real account, and a model URL that changed on every read. Each is shown by doing the
 * thing that went wrong and reading what is left.
 */
describeDb('site twin: the leftovers of 5 Nov', () => {
  let owner: DataSource;
  let app: INestApplication;
  let twins: SiteTwinService;
  let plantId: string;
  let demoPlantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, {
      AUTH_JWT_SECRET: 'test-secret-twin-leftovers', AUTH_JWT_ISSUER: 'twin-leftovers-test', CORS_ORIGINS: 'http://localhost:3000',
    });
    app = await createApp({ database: true });
    await app.init();
    twins = app.get(SiteTwinService);

    for (const t of ['acme', 'demo-construction']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    [{ id: plantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'yard', 'Yard') RETURNING id`);
    [{ id: demoPlantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name) VALUES ('demo-construction', 'ring', 'Ring road') RETURNING id`,
    );
    // The class slug alone says what a machine is when its class has no category.
    const machine = (tenant: string, id: string, slug: string, plant: string) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, plant_id, tier, readiness, updated_by)
         VALUES ($1, $2, $3, $3, $4, $5, 'standard', '{}'::jsonb, 'u')`, [tenant, SRC, id, slug, plant],
    );
    await machine('acme', 'GEN-1', 'prime-diesel-generator', plantId);
    await machine('acme', 'EX-1', 'hydraulic-excavator', plantId);
    await machine('demo-construction', 'EX-9', 'hydraulic-excavator', demoPlantId);
  }, 90_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const room = { key: 'gen-room', label: 'Generator room', kind: 'generator_room' as const, x: 30, z: 15, widthM: 16, depthM: 10 };
  const yard = { key: 'yard', label: 'Yard', kind: 'work_area' as const, x: -30, z: 0, widthM: 20, depthM: 20 };
  const layout = (over: Partial<LayoutInput>): LayoutInput => ({
    expectedVersion: 0, extent: { widthM: 100, depthM: 60 }, zones: [], placements: [], ...over,
  });
  const zoneKeys = async (scope: RequestScope) => (await twins.read(scope, plantId)).zones.map((z) => z.key).sort();

  describe('a scoped save keeps the structures its user was not shown', () => {
    it('saved by someone scoped to the excavator, the generator room is still there', async () => {
      await twins.save(acme, plantId, layout({
        expectedVersion: (await twins.read(acme, plantId)).version,
        zones: [room, yard],
        placements: [{ sourceSystem: SRC, externalId: 'GEN-1', x: 30, z: 15, headingDeg: 0 }],
      }));
      // They never see it, so they cannot send it back.
      expect(await zoneKeys(narrow)).toEqual(['yard']);
      await twins.save(narrow, plantId, layout({
        expectedVersion: (await twins.read(narrow, plantId)).version,
        zones: [{ ...yard, label: 'Excavation yard' }],
        placements: [{ sourceSystem: SRC, externalId: 'EX-1', x: -30, z: 0, headingDeg: 90 }],
      }));
      expect(await zoneKeys(acme)).toEqual(['gen-room', 'yard']);
      const zones = (await twins.read(acme, plantId)).zones;
      expect(zones.find((z) => z.key === 'yard')!.label).toBe('Excavation yard');
    });

    it('a zone they could see and left out is still theirs to remove', async () => {
      await twins.save(narrow, plantId, layout({ expectedVersion: (await twins.read(narrow, plantId)).version, zones: [] }));
      expect(await zoneKeys(acme)).toEqual(['gen-room']);
    });

    it('someone who sees the whole site still removes the room by leaving it out', async () => {
      await twins.save(acme, plantId, layout({ expectedVersion: (await twins.read(acme, plantId)).version, zones: [] }));
      expect(await zoneKeys(acme)).toEqual([]);
    });
  });

  describe('road progress on a proposal', () => {
    const roads = (l: LayoutInput) => l.zones.filter((z) => z.kind === 'road').map((z) => z.progressPct ?? null);

    it('a real account\'s proposal reports no progress nobody gave', async () => {
      const proposal = await twins.propose(acme, plantId);
      expect(roads(proposal).length).toBeGreaterThan(0);
      expect(roads(proposal).every((p) => p === null)).toBe(true);
    });

    it('arranged around a drawing, the person\'s own figure is kept', async () => {
      const drawn = { key: 'my-road', label: 'Haul road', kind: 'road' as const, x: 0, z: -20, widthM: 40, depthM: 8, progressPct: 30 };
      const proposal = await twins.propose(acme, plantId, new Set(), { extent: { widthM: 120, depthM: 80 }, zones: [drawn] });
      expect(proposal.zones.find((z) => z.key === 'my-road')!.progressPct).toBe(30);
    });

    it('the demo site keeps its staged look', async () => {
      const proposal = await twins.propose(demo, demoPlantId);
      expect(roads(proposal)).toEqual(expect.arrayContaining([100, 45, 0]));
    });
  });

  describe('a model\'s URL holds still', () => {
    const storage = new S3AssetStorage({
      endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'visuals', accessKeyId: 'test-key',
      secretAccessKey: 'test-secret', region: 'auto', publicBaseUrl: null, keyPrefix: '',
    });
    const window = READ_URL_WINDOW_SECONDS * 1000;
    const start = new Date(Math.ceil(Date.UTC(2026, 10, 23, 9) / window) * window);

    it('two reads in the same window get the same URL, so the browser can cache the model', async () => {
      const a = await storage.readUrl('class/excavator/model.glb', new Date(start.getTime() + 1_000));
      const b = await storage.readUrl('class/excavator/model.glb', new Date(start.getTime() + window - 1_000));
      expect(a).toBe(b);
      expect(a).not.toContain('test-secret');
    });

    it('the next window signs a new one, still good for the whole lifetime from its start', async () => {
      const a = await storage.readUrl('class/excavator/model.glb', new Date(start.getTime() + 1_000));
      const b = await storage.readUrl('class/excavator/model.glb', new Date(start.getTime() + window + 1_000));
      expect(a).not.toBe(b);
      expect(new URL(b).searchParams.get('X-Amz-Expires')).toBe('900');
    });
  });
});
