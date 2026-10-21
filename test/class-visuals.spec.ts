import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ASSET_STORAGE, AssetStorage, ObjectHead, S3AssetStorage, assetConfigFrom } from '../src/assets/asset-storage';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassVisual, EquipmentClassVisualAnchor } from '../src/catalog/entities/equipment-class-visual.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClassVisualService } from '../src/catalog/services/class-visual.service';
import { mergeTenantAnchors, TenantAnchor } from '../src/catalog/visual/anchor-rules';
import { ClientEquipmentClassVisualAnchor } from '../src/client-catalog/entities/client-equipment-class-visual-anchor.entity';
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { ClientCatalogService } from '../src/client-catalog/services/client-catalog.service';
import { ClientVisualService } from '../src/client-catalog/services/client-visual.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { mintPlatformToken } from '../src/platform/platform-token';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ClassVisuals1758500000000';
const SECRET = 'test-secret-class-visuals';
const ISSUER = 'things-alive-class-visuals-test';
const S3_ENV = {
  ASSET_S3_ENDPOINT: 'http://127.0.0.1:9',
  ASSET_S3_BUCKET: 'ta-class-visuals',
  ASSET_S3_ACCESS_KEY_ID: 'AKIATESTVISUALS',
  ASSET_S3_SECRET_ACCESS_KEY: 'secret-that-must-never-be-returned',
  ASSET_S3_REGION: 'auto',
};
const CLASS = 'visual-test-class';
const platform: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
const acme: RequestScope = { tenantId: 'acme', userId: '00000000-0000-4000-8000-0000000000d1', roles: ['super admin'], isPlatformRole: false };
const SIGNALS = [
  { signal: 'coolant_temp_c', unit: 'degC', required: true },
  { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
];
const PNG = 'image/png';

/**
 * Class visuals — tier 0, the schematic — their anchors, and the storage behind them
 * (task QREC0c). No bucket is needed: presigning is computed offline by the SDK and is
 * tested for real; the one network call (HEAD, at confirm) goes through the storage
 * interface and is faked here.
 */
describeDb('class visuals, anchors and asset storage', () => {
  let owner: DataSource;
  let app: INestApplication;
  let authoring: CatalogAuthoringService;
  let visuals: ClassVisualService;
  let tenantVisuals: ClientVisualService;
  let copies: CopyOnGrantService;
  let storage: AssetStorage;
  /** What the fake HEAD reports for the next confirm. */
  let headResult: ObjectHead | null;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, S3_ENV, {
      AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, AUTH_TENANT_CLAIM: 'client_id', CORS_ORIGINS: 'http://localhost:3000',
    });
    delete process.env.ASSET_S3_PUBLIC_BASE_URL;
    app = await createApp({ database: true });
    await app.init();
    authoring = app.get(CatalogAuthoringService);
    visuals = app.get(ClassVisualService);
    tenantVisuals = app.get(ClientVisualService);
    copies = app.get(CopyOnGrantService);
    storage = app.get(ASSET_STORAGE);
    // The one network call, faked: everything else in the storage is the real SDK.
    storage.head = async () => headResult;
  }, 60_000);

  afterAll(async () => {
    await app?.close(); await owner?.destroy();
    for (const k of Object.keys(S3_ENV)) delete process.env[k];
  });

  beforeEach(async () => {
    await owner.query(`
      TRUNCATE TABLE "client_equipment_class_visual_anchor", "equipment_class_visual_anchor", "equipment_class_visual",
        "client_equipment_class_layout", "client_formula", "client_scenario", "client_equipment_class",
        "equipment_class_formula", "equipment_class_sensor_requirement", "equipment_class_profile", "equipment_profile"
      RESTART IDENTITY CASCADE`);
    headResult = { contentType: PNG, size: 1024 };
  });

  const draft = () => authoring.createClass(platform, CLASS, { name: 'Visual test class', expectedSignals: SIGNALS });
  /** A draft with a confirmed image. */
  const withImage = async () => {
    await draft();
    const issued = await visuals.issueUploadUrl(platform, CLASS, 1, PNG);
    await visuals.confirm(platform, CLASS, 1, 1200, 800);
    return issued;
  };
  const anchor = (signal: string, hotspotX = 40, hotspotY = 60) => ({ signal, hotspotX, hotspotY, label: null });
  const bearerPlatform = () => mintPlatformToken({ role: 'master-admin', subject: 'deepak@things-alive.io' }, { secret: SECRET, issuer: ISSUER }).token;
  const bearerTenant = (tenant: string) => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000d1', client_id: tenant, roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER },
  );

  // =============================================================== refusals
  describe('refused, naming what', () => {
    it('1. an anchor naming a signal the class does not declare — at the PUT, and at publish', async () => {
      await withImage();
      await expect(visuals.replaceAnchors(platform, CLASS, 1, [anchor('exhaust_temp_c')]))
        .rejects.toThrow(/anchor for signal "exhaust_temp_c", which the class does not declare/);
      // Written past the PUT (as any other path could): publish refuses it too.
      await owner.query(
        `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, signal, hotspot_x, hotspot_y) VALUES ($1, 1, 'exhaust_temp_c', 10, 10)`,
        [CLASS],
      );
      await expect(authoring.publishClass(platform, CLASS)).rejects.toThrow(/anchor for signal "exhaust_temp_c"/);
    });

    it('2. an anchor on a class version with no visual — the database refuses it, and so does the PUT', async () => {
      await draft();
      await expect(visuals.replaceAnchors(platform, CLASS, 1, [anchor('coolant_temp_c')]))
        .rejects.toThrow(/has no visual; an anchor needs an image to sit on/);
      await expect(owner.query(
        `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, signal, hotspot_x, hotspot_y) VALUES ($1, 1, 'coolant_temp_c', 10, 10)`,
        [CLASS],
      )).rejects.toThrow(/fk_class_anchor_visual/);
    });

    it('3. hotspot_x of 101 — refused by the CHECK, by the service, and at the boundary', async () => {
      await withImage();
      await expect(owner.query(
        `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, signal, hotspot_x, hotspot_y) VALUES ($1, 1, 'coolant_temp_c', 101, 10)`,
        [CLASS],
      )).rejects.toThrow(/ck_class_anchor_x/);
      await expect(visuals.replaceAnchors(platform, CLASS, 1, [anchor('coolant_temp_c', 101)]))
        .rejects.toThrow(/hotspot_x 101; it must be a percentage, 0 to 100/);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/platform/catalog/equipment-classes/${CLASS}/1/anchors`)
        .set('Authorization', `Bearer ${bearerPlatform()}`)
        .send({ anchors: [{ signal: 'coolant_temp_c', hotspotX: 101, hotspotY: 10 }] });
      expect(res.status).toBe(400);
    });

    it('a tier outside the CHECK is refused by the database', async () => {
      await draft();
      await expect(owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier) VALUES ($1, 1, 'glb')`, [CLASS],
      )).rejects.toThrow(/ck_class_visual_tier/);
    });

    it('5. no upload URL for a published version — published content is immutable', async () => {
      await draft();
      await authoring.publishClass(platform, CLASS);
      await expect(visuals.issueUploadUrl(platform, CLASS, 1, PNG)).rejects.toThrow(/is published; .*immutable/);
    });

    it('6. a content type outside the set is refused, naming it', async () => {
      await draft();
      await expect(visuals.issueUploadUrl(platform, CLASS, 1, 'image/gif'))
        .rejects.toThrow(/Content type "image\/gif" is not an allowed visual type/);
    });
  });

  // ============================================================ publishing
  it('4. a class with no visual publishes normally', async () => {
    await draft();
    await expect(authoring.publishClass(platform, CLASS)).resolves.toMatchObject({ status: 'published' });
  });

  describe('upload: presigned PUT, then confirm', () => {
    it('issuing records only the pending key; confirm records the asset once the object is there', async () => {
      await draft();
      const issued = await visuals.issueUploadUrl(platform, CLASS, 1, PNG);
      expect(issued).toMatchObject({ method: 'PUT', headers: { 'Content-Type': PNG } });
      expect(issued.key).toMatch(new RegExp(`^class-visuals/${CLASS}/v1/[0-9a-f-]+\\.png$`));
      // A real presigned PUT, computed offline by the SDK — signed, scoped to the key.
      expect(issued.uploadUrl).toContain(issued.key);
      expect(issued.uploadUrl).toMatch(/X-Amz-Signature=/);
      expect(issued.uploadUrl).not.toContain(S3_ENV.ASSET_S3_SECRET_ACCESS_KEY);

      expect((await visuals.read(CLASS, 1)).state).toBe('upload_pending');

      headResult = null;
      await expect(visuals.confirm(platform, CLASS, 1, 1200, 800)).rejects.toThrow(/Nothing was uploaded to class-visuals\//);
      headResult = { contentType: 'image/jpeg', size: 1024 };
      await expect(visuals.confirm(platform, CLASS, 1, 1200, 800)).rejects.toThrow(/is "image\/jpeg", not the "image\/png"/);
      headResult = { contentType: PNG, size: 0 };
      await expect(visuals.confirm(platform, CLASS, 1, 1200, 800)).rejects.toThrow(/0 bytes/);

      headResult = { contentType: PNG, size: 2048 };
      const read = await visuals.confirm(platform, CLASS, 1, 1200, 800);
      expect(read).toMatchObject({ state: 'ready', width: 1200, height: 800, contentType: PNG });
      const row = await owner.query(`SELECT asset_key, pending_key, size_bytes FROM equipment_class_visual`);
      expect(row[0]).toMatchObject({ asset_key: issued.key, pending_key: null });
    });

    it('a publish with an upload issued and never confirmed is refused — it would be pending forever', async () => {
      await draft();
      await visuals.issueUploadUrl(platform, CLASS, 1, PNG);
      await expect(authoring.publishClass(platform, CLASS)).rejects.toThrow(/upload was issued but never confirmed/);
    });

    it('12. the read returns a signed URL — never the secret, never the bucket\'s raw endpoint', async () => {
      const issued = await withImage();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/platform/catalog/equipment-classes/${CLASS}/1/visual`)
        .set('Authorization', `Bearer ${bearerPlatform()}`);
      expect(res.status).toBe(200);
      const url: string = res.body.imageUrl;
      expect(url).toContain(issued.key);
      expect(url).toMatch(/X-Amz-Signature=/);
      expect(url).toMatch(/X-Amz-Expires=900/);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(S3_ENV.ASSET_S3_SECRET_ACCESS_KEY);
      // The raw endpoint never appears as a bare value — only inside a signed URL.
      expect(Object.values(res.body)).not.toContain(S3_ENV.ASSET_S3_ENDPOINT);

      // With a CDN in front, the CDN URL instead.
      const cdn = new S3AssetStorage(assetConfigFrom({ ...S3_ENV, ASSET_S3_PUBLIC_BASE_URL: 'https://cdn.example.com/' })!);
      expect(await cdn.readUrl(issued.key)).toBe(`https://cdn.example.com/${issued.key}`);
    });
  });

  // ============================================================== anchors
  it('7. PUT anchors replaces the set; a removed anchor is gone', async () => {
    await withImage();
    await visuals.replaceAnchors(platform, CLASS, 1, [anchor('coolant_temp_c'), anchor('oil_pressure_kpa', 70, 20)]);
    const read = await visuals.replaceAnchors(platform, CLASS, 1, [anchor('oil_pressure_kpa', 75, 25)]);
    expect(read.anchors).toEqual([{ signal: 'oil_pressure_kpa', hotspotX: 75, hotspotY: 25, label: null }]);
    expect(read.unplacedSignals).toEqual(['coolant_temp_c']);
    expect(await owner.query(`SELECT signal FROM equipment_class_visual_anchor`)).toEqual([{ signal: 'oil_pressure_kpa' }]);
  });

  it('two anchor sets saved at once both settle, and the stored set is exactly one of them', async () => {
    await withImage();
    const a = [anchor('coolant_temp_c', 10, 10)];
    const b = [anchor('coolant_temp_c', 90, 90), anchor('oil_pressure_kpa', 50, 50)];
    const results = await Promise.allSettled([
      visuals.replaceAnchors(platform, CLASS, 1, a), visuals.replaceAnchors(platform, CLASS, 1, b),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const stored = (await visuals.read(CLASS, 1)).anchors;
    expect([JSON.stringify(a), JSON.stringify(b)]).toContain(JSON.stringify(stored));
  });

  it('a fork shares the image bytes and carries the anchors; DELETE removes the row and keeps the bytes', async () => {
    const issued = await withImage();
    await visuals.replaceAnchors(platform, CLASS, 1, [anchor('coolant_temp_c')]);
    await authoring.publishClass(platform, CLASS);
    await authoring.editClass(platform, CLASS, { description: 'v2' });

    const v2 = await visuals.read(CLASS, 2);
    expect(v2).toMatchObject({ state: 'ready', width: 1200 });
    const [row] = await owner.query(`SELECT asset_key FROM equipment_class_visual WHERE class_version = 2`);
    expect(row.asset_key).toBe(issued.key);
    expect(v2.anchors.map((x) => x.signal)).toEqual(['coolant_temp_c']);

    await visuals.remove(platform, CLASS, 2);
    expect((await visuals.read(CLASS, 2)).state).toBe('no_visual');
    // v1 — published, sharing the same object — is untouched.
    expect((await visuals.read(CLASS, 1)).state).toBe('ready');
    // And the published version's rows cannot be changed by any path.
    await expect(owner.query(`UPDATE equipment_class_visual SET width_px = 1 WHERE class_version = 1`))
      .rejects.toThrow(/ck_class_content_draft_only/);
  });

  // ========================================================= grant, tenant
  describe('copy on grant, and the tenant', () => {
    const granted = async () => {
      await withImage();
      await visuals.replaceAnchors(platform, CLASS, 1, [anchor('coolant_temp_c', 30, 40), anchor('oil_pressure_kpa', 60, 70)]);
      await authoring.publishClass(platform, CLASS);
      return copies.copyForTenant('acme', CLASS, 'deepak');
    };

    it('8. copy-on-grant carries the anchors, not the image; the inventory audit passes with the new entries', async () => {
      const result = await granted();
      expect(result.anchorsCopied).toBe(2);
      const rows = await withTenantId(app.get(DataSource), 'acme', (m) => m.getRepository(ClientEquipmentClassVisualAnchor).find());
      expect(rows.map((r) => [r.signal, r.placementCustom])).toEqual(expect.arrayContaining([['coolant_temp_c', false], ['oil_pressure_kpa', false]]));

      const live = await findClassReferencingTables(owner.manager);
      expect(live).toEqual(expect.arrayContaining(['equipment_class_visual', 'equipment_class_visual_anchor']));
      expect(auditClassContentTables(live, CLASS_CONTENT_INVENTORY)).toEqual([]);
      expect(CLASS_CONTENT_INVENTORY.find((e) => e.table === 'equipment_class_visual_anchor')?.disposition).toBe('copy');
      const visual = CLASS_CONTENT_INVENTORY.find((e) => e.table === 'equipment_class_visual');
      expect(visual?.disposition).toBe('exclude');
      expect(visual?.reason).toBeTruthy();
    });

    it('9. a signal the tenant added has no anchor: it is unplaced — never put on a nearby anchor', async () => {
      await granted();
      await app.get(ClientCatalogService).editClass(acme, CLASS, {
        expectedSignals: [...SIGNALS, { signal: 'exhaust_temp_c', unit: 'degC', required: false }],
      });
      const read = await tenantVisuals.read(acme, CLASS);
      expect(read.unplacedSignals).toEqual(['exhaust_temp_c']);
      expect(read.anchors.map((a) => a.signal)).not.toContain('exhaust_temp_c');
      expect(read.anchors).toHaveLength(2);
    });

    it('a tenant placement is marked custom; one left where it was keeps its flag', async () => {
      await granted();
      await app.get(ClientCatalogService).editClass(acme, CLASS, {
        expectedSignals: [...SIGNALS, { signal: 'exhaust_temp_c', unit: 'degC', required: false }],
      });
      const read = await tenantVisuals.replaceAnchors(acme, CLASS, [
        anchor('coolant_temp_c', 30, 40), // unchanged
        anchor('oil_pressure_kpa', 65, 70), // moved
        anchor('exhaust_temp_c', 80, 10), // placed from the tray
      ]);
      expect(Object.fromEntries(read.anchors.map((a) => [a.signal, a.placementCustom]))).toEqual({
        coolant_temp_c: false, oil_pressure_kpa: true, exhaust_temp_c: true,
      });
      expect(read.unplacedSignals).toEqual([]);
    });

    it('10. a new class version preserves a tenant-placed anchor and keeps it marked — the merge is a pure function', () => {
      const copy: TenantAnchor[] = [
        { signal: 'coolant_temp_c', hotspotX: 30, hotspotY: 40, label: null, placementCustom: false },
        { signal: 'oil_pressure_kpa', hotspotX: 65, hotspotY: 70, label: null, placementCustom: true },
        { signal: 'exhaust_temp_c', hotspotX: 80, hotspotY: 10, label: null, placementCustom: true },
      ];
      const next = [
        { signal: 'coolant_temp_c', hotspotX: 35, hotspotY: 45, label: 'Coolant' },
        { signal: 'oil_pressure_kpa', hotspotX: 10, hotspotY: 10, label: 'Oil' },
        { signal: 'fuel_level_pct', hotspotX: 50, hotspotY: 90, label: null },
      ];
      expect(mergeTenantAnchors(copy, next)).toEqual([
        { signal: 'coolant_temp_c', hotspotX: 35, hotspotY: 45, label: 'Coolant', placementCustom: false },
        { signal: 'exhaust_temp_c', hotspotX: 80, hotspotY: 10, label: null, placementCustom: true },
        { signal: 'fuel_level_pct', hotspotX: 50, hotspotY: 90, label: null, placementCustom: false },
        { signal: 'oil_pressure_kpa', hotspotX: 65, hotspotY: 70, label: null, placementCustom: true },
      ]);
    });

    it('13. a tenant cannot read another tenant\'s anchors — directly, and over HTTP', async () => {
      await granted();
      const seenByGlobex = await withTenantId(app.get(DataSource), 'globex', (m) =>
        m.getRepository(ClientEquipmentClassVisualAnchor).count());
      expect(seenByGlobex).toBe(0);
      const asGlobex = `Bearer ${await bearerTenant('globex')}`;
      const res = await request(app.getHttpServer()).get(`/api/v1/my-catalog/equipment-classes/${CLASS}/visual`).set('Authorization', asGlobex);
      expect(res.status).toBe(404);
      const asAcme = `Bearer ${await bearerTenant('acme')}`;
      const own = await request(app.getHttpServer()).get(`/api/v1/my-catalog/equipment-classes/${CLASS}/visual`).set('Authorization', asAcme);
      expect(own.status).toBe(200);
      expect(own.body.anchors).toHaveLength(2);
    });

    it('the schematic widget renders per machine: readiness from coverage, unplaced signals beside it', async () => {
      await granted();
      // The class requires both sensors — what coverage reads to call a signal unbound
      // rather than merely not required.
      for (const s of SIGNALS) {
        await owner.query(
          `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit)
             VALUES ($1, 1, $2, $3)`, [CLASS, s.signal, s.unit],
        );
      }
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, origin, status)
           VALUES ('acme', 'iot-platform-1', 'DG-1', $1, 1, 'standard', '{}'::jsonb, 'client', 'active')`, [CLASS],
      );
      await withTenantId(app.get(DataSource), 'acme', (m) => m.query(
        `INSERT INTO client_equipment_class_layout (tenant_id, client_equipment_class_slug, widget_type, widget_key, position, size)
           VALUES ('acme', $1, 'schematic', 'twin', 1, 'full')`, [CLASS],
      ));
      const page = await app.get(PageService).machinePage(acme, { sourceSystem: 'iot-platform-1', externalId: 'DG-1' });
      const [twin] = page.widgets;
      expect(twin.readiness).toBe('ready');
      const data = twin.data as { imageUrl: string; anchors: { signal: string; readiness: string; reason: string; value: number | null }[] };
      expect(data.imageUrl).toMatch(/X-Amz-Signature=/);
      // No device is fitted: every marker stays on the image, saying why it has no value.
      expect(data.anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ signal: 'coolant_temp_c', readiness: 'not_configured', reason: 'unbound', value: null }),
      ]));
    });
  });

  // ================================================================ migration
  describe('the migration', () => {
    afterAll(() => owner.runMigrations({ transaction: 'all' }));

    it('applies over a tenant copy that existed beforehand — the copy simply has no anchors yet', async () => {
      await draft();
      await authoring.publishClass(platform, CLASS);
      await copies.copyForTenant('acme', CLASS, 'deepak');
      await undoMigrationNamed(owner, MIGRATION);
      await owner.runMigrations({ transaction: 'all' });
      const read = await tenantVisuals.read(acme, CLASS);
      expect(read).toMatchObject({ state: 'no_visual', anchors: [], unplacedSignals: ['coolant_temp_c', 'oil_pressure_kpa'] });
    }, 60_000);

    it('has a down path, named by its own migration, that leaves none of its tables behind', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      const tables = await owner.query(`
        SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('equipment_class_visual', 'equipment_class_visual_anchor', 'client_equipment_class_visual_anchor')`);
      expect(tables).toEqual([]);
    }, 60_000);
  });
});

/** Test 11 needs an app booted with no storage configured at all. */
describeDb('class visuals with no storage configured', () => {
  let owner: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (const k of Object.keys(S3_ENV)) delete process.env[k];
    Object.assign(process.env, { AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, CORS_ORIGINS: 'http://localhost:3000' });
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  it('11. the API boots, the storage says it is unconfigured, and a confirmed visual reads assets_unavailable', async () => {
    const storage = app.get<AssetStorage>(ASSET_STORAGE);
    expect(storage.configured).toBe(false);
    const authoring = app.get(CatalogAuthoringService);
    await authoring.createClass(platform, CLASS, { name: 'x', expectedSignals: SIGNALS });
    // A visual uploaded while a bucket existed, and the bucket since unconfigured.
    await owner.query(
      `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, width_px, height_px)
         VALUES ($1, 1, 'schematic', 'class-visuals/x.png', 'image/png', 10, 10)`, [CLASS],
    );
    expect((await app.get(ClassVisualService).read(CLASS, 1)).state).toBe('assets_unavailable');
    await expect(app.get(ClassVisualService).issueUploadUrl(platform, CLASS, 1, PNG)).rejects.toThrow(/assets_unavailable/);
    expect(await owner.getRepository(EquipmentClassVisual).count()).toBe(1);
    expect(await owner.getRepository(EquipmentClassVisualAnchor).count()).toBe(0);
  });
});
