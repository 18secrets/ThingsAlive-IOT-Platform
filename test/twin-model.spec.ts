import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ASSET_STORAGE, AssetStorage, ObjectHead } from '../src/assets/asset-storage';
import { RequestScope } from '../src/auth/types/request-scope';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClassModelService } from '../src/catalog/services/class-model.service';
import { ModelBounds } from '../src/catalog/visual/model-anchor-rules';
import { ClientEquipmentClassVisualAnchor } from '../src/client-catalog/entities/client-equipment-class-visual-anchor.entity';
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { ClassUpgradeService } from '../src/client-catalog/services/class-upgrade.service';
import { ClientCatalogService } from '../src/client-catalog/services/client-catalog.service';
import { ClientModelService } from '../src/client-catalog/services/client-model.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { mintPlatformToken } from '../src/platform/platform-token';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'TwinModel1761400000000';
const SECRET = 'test-secret-twin-model';
const ISSUER = 'things-alive-twin-model-test';
const S3_ENV = {
  ASSET_S3_ENDPOINT: 'http://127.0.0.1:9',
  ASSET_S3_BUCKET: 'ta-twin-models',
  ASSET_S3_ACCESS_KEY_ID: 'AKIATESTTWINMODEL',
  ASSET_S3_SECRET_ACCESS_KEY: 'secret-that-must-never-be-returned',
  ASSET_S3_REGION: 'auto',
};
const CLASS = 'twin-model-class';
const platform: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
const acme: RequestScope = { tenantId: 'acme', userId: '00000000-0000-4000-8000-0000000000d1', roles: ['super admin'], isPlatformRole: false };
const SIGNALS = [
  { signal: 'coolant_temp_c', unit: 'degC', required: true },
  { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
];
const GLB = 'model/gltf-binary';
const BOX: ModelBounds = { min: [-2, 0, -1], max: [2, 3, 1] };

/**
 * The 3-D twin's backend (task QTWIN1): the model tier, 3-D anchors held inside the
 * model's bounds by the database, geometry_version, the tenant tray and `twin_model`.
 * No bucket: presigning is the real SDK, the one network call (HEAD) is faked — the
 * way test/class-visuals.spec.ts does it.
 */
describeDb('the 3-D twin: model tier, anchors, tray', () => {
  let owner: DataSource;
  let app: INestApplication;
  let authoring: CatalogAuthoringService;
  let models: ClassModelService;
  let tenantModels: ClientModelService;
  let copies: CopyOnGrantService;
  let storage: AssetStorage;
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
    models = app.get(ClassModelService);
    tenantModels = app.get(ClientModelService);
    copies = app.get(CopyOnGrantService);
    storage = app.get(ASSET_STORAGE);
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
    headResult = { contentType: GLB, size: 4096 };
  });

  const draft = () => authoring.createClass(platform, CLASS, { name: 'Twin model class', expectedSignals: SIGNALS });
  const upload = async (version: number, bounds: ModelBounds = BOX, geometryChanged?: boolean) => {
    await models.issueUploadUrl(platform, CLASS, version, GLB);
    return models.confirm(platform, CLASS, version, bounds, geometryChanged);
  };
  /** A draft with a confirmed model. */
  const withModel = async () => { await draft(); return upload(1); };
  const at = (signal: string, x = 0, y = 1, z = 0) => ({ signal, x, y, z, label: null });
  const rawAnchor = (signal: string, x: number, y = 1, z = 0, version = 1) => owner.query(
    `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, tier, signal, pos_x, pos_y, pos_z)
       VALUES ($1, $2, 'model', $3, $4, $5, $6)`, [CLASS, version, signal, x, y, z],
  );
  const bearerPlatform = () => mintPlatformToken({ role: 'master-admin', subject: 'deepak@things-alive.io' }, { secret: SECRET, issuer: ISSUER }).token;
  const bearerTenant = (tenant: string) => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000d1', client_id: tenant, roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER },
  );
  const granted = async () => {
    await withModel();
    await models.replaceAnchors(platform, CLASS, 1, [at('coolant_temp_c', 1, 2, 0), at('oil_pressure_kpa', -1, 1, 0.5)]);
    await authoring.publishClass(platform, CLASS);
    return copies.copyForTenant('acme', CLASS, 'deepak');
  };
  const inAcme = <R>(fn: (m: import('typeorm').EntityManager) => Promise<R>) => withTenantId(app.get(DataSource), 'acme', fn);

  // =============================================================== refusals
  describe('refused, by attempting', () => {
    it('1. an anchor outside the bounds — by the trigger, by the service, and at the boundary', async () => {
      await withModel();
      await expect(rawAnchor('coolant_temp_c', 5)).rejects.toThrow(/ck_class_anchor_fits: anchor for "coolant_temp_c" .* outside the model's bounds/);
      await expect(models.replaceAnchors(platform, CLASS, 1, [at('coolant_temp_c', 5)]))
        .rejects.toThrow(/has x 5, outside the model's bounds \(-2 to 2\)/);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/platform/catalog/equipment-classes/${CLASS}/1/model/anchors`)
        .set('Authorization', `Bearer ${bearerPlatform()}`)
        .send({ anchors: [{ signal: 'coolant_temp_c', x: 0, y: 9, z: 0 }] });
      expect(res.status).toBe(400);
      expect(await owner.query(`SELECT count(*)::int AS n FROM equipment_class_visual_anchor`)).toEqual([{ n: 0 }]);
    });

    it('2. an anchor on a model whose upload is not confirmed — refused by the trigger and the service', async () => {
      await draft();
      await models.issueUploadUrl(platform, CLASS, 1, GLB);
      await expect(rawAnchor('coolant_temp_c', 0)).rejects.toThrow(/ck_class_anchor_fits: anchor for "coolant_temp_c" needs a confirmed model/);
      await expect(models.replaceAnchors(platform, CLASS, 1, [at('coolant_temp_c')])).rejects.toThrow(/has no confirmed model/);
    });

    it('3. a schematic anchor with a position, and a model anchor with hotspots — refused by the CHECK', async () => {
      await withModel();
      await owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, width_px, height_px)
           VALUES ($1, 1, 'schematic', 'class-visuals/x.png', 'image/png', 10, 10)`, [CLASS],
      );
      await expect(owner.query(
        `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, signal, hotspot_x, hotspot_y, pos_x)
           VALUES ($1, 1, 'coolant_temp_c', 10, 10, 1)`, [CLASS],
      )).rejects.toThrow(/ck_class_anchor_position/);
      await expect(owner.query(
        `INSERT INTO equipment_class_visual_anchor (class_slug, class_version, tier, signal, hotspot_x, hotspot_y, pos_x, pos_y, pos_z)
           VALUES ($1, 1, 'model', 'coolant_temp_c', 10, 10, 0, 1, 0)`, [CLASS],
      )).rejects.toThrow(/ck_class_anchor_position/);
    });

    it('4. a GLB on a schematic row, an image on a model row — refused by the CHECK; an image type at the upload URL too', async () => {
      await draft();
      await expect(owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, width_px, height_px)
           VALUES ($1, 1, 'schematic', 'k.glb', $2, 10, 10)`, [CLASS, GLB],
      )).rejects.toThrow(/ck_class_visual_content_type/);
      await expect(owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier, pending_key, pending_content_type)
           VALUES ($1, 1, 'model', 'k.png', 'image/png')`, [CLASS],
      )).rejects.toThrow(/ck_class_visual_pending_content_type/);
      await expect(models.issueUploadUrl(platform, CLASS, 1, 'image/png'))
        .rejects.toThrow(/Content type "image\/png" is not an allowed model type/);
    });

    it('a confirmed model without its box is refused by the CHECK — half a model is a broken twin', async () => {
      await draft();
      await expect(owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, geometry_version)
           VALUES ($1, 1, 'model', 'k.glb', $2, 1)`, [CLASS, GLB],
      )).rejects.toThrow(/ck_class_visual_confirmed/);
    });

    it('5. an anchor naming an undeclared signal — at the PUT, and at publish', async () => {
      await withModel();
      await expect(models.replaceAnchors(platform, CLASS, 1, [at('exhaust_temp_c')]))
        .rejects.toThrow(/model anchor for signal "exhaust_temp_c", which the class does not declare/);
      await rawAnchor('exhaust_temp_c', 0);
      await expect(authoring.publishClass(platform, CLASS)).rejects.toThrow(/model anchor for signal "exhaust_temp_c"/);
    });

    it('6. a publish with a model upload issued and never confirmed is refused; a class with no model publishes', async () => {
      await draft();
      await models.issueUploadUrl(platform, CLASS, 1, GLB);
      await expect(authoring.publishClass(platform, CLASS)).rejects.toThrow(/model upload was issued but never confirmed/);
      await models.remove(platform, CLASS, 1);
      await expect(authoring.publishClass(platform, CLASS)).resolves.toMatchObject({ status: 'published' });
    });

    it('a model cannot be uploaded to a published version', async () => {
      await draft();
      await authoring.publishClass(platform, CLASS);
      await expect(models.issueUploadUrl(platform, CLASS, 1, GLB)).rejects.toThrow(/is published; .*immutable/);
    });
  });

  // ============================================================== geometry
  it('7. geometry_version: 1 at first confirm; kept for a declared-unchanged re-upload with the same box; bumped when the box moves', async () => {
    const first = await withModel();
    expect(first).toMatchObject({ state: 'ready', geometryVersion: 1, bounds: BOX, contentType: GLB });
    expect(first.modelUrl).toMatch(/X-Amz-Signature=/);
    expect(first.modelUrl).not.toContain(S3_ENV.ASSET_S3_SECRET_ACCESS_KEY);
    expect((await upload(1, BOX, false)).geometryVersion).toBe(1);
    // Declared unchanged, but the box moved: markers placed on the old box may not fit.
    expect((await upload(1, { min: [-2, 0, -1], max: [2, 4, 1] }, false)).geometryVersion).toBe(2);
    // Same box, nothing declared: changed is the default.
    expect((await upload(1, { min: [-2, 0, -1], max: [2, 4, 1] })).geometryVersion).toBe(3);
  });

  it('8. a fork carries the model, its geometry version and its anchors, sharing the bytes', async () => {
    await withModel();
    await models.replaceAnchors(platform, CLASS, 1, [at('coolant_temp_c', 1, 2, 0)]);
    await authoring.publishClass(platform, CLASS);
    await authoring.editClass(platform, CLASS, { description: 'v2' });
    const v2 = await models.read(CLASS, 2);
    expect(v2).toMatchObject({ state: 'ready', geometryVersion: 1, bounds: BOX });
    expect(v2.anchors).toEqual([{ signal: 'coolant_temp_c', x: 1, y: 2, z: 0, label: null }]);
    const keys = await owner.query(`SELECT DISTINCT asset_key FROM equipment_class_visual WHERE tier = 'model'`);
    expect(keys).toHaveLength(1);
  });

  // ========================================================= grant, tenant
  describe('copy on grant, the tenant, the tray', () => {
    it('9. a grant copies the model anchors beside the schematic ones, not the GLB; the inventory audit still passes', async () => {
      const result = await granted();
      expect(result.modelAnchorsCopied).toBe(2);
      const rows = await inAcme((m) => m.getRepository(ClientEquipmentClassVisualAnchor).find({ order: { signal: 'ASC' } }));
      expect(rows.map((r) => [r.tier, r.signal, r.posX, r.placementCustom, r.needsRecheck])).toEqual([
        ['model', 'coolant_temp_c', 1, false, false], ['model', 'oil_pressure_kpa', -1, false, false],
      ]);
      const live = await findClassReferencingTables(owner.manager);
      expect(auditClassContentTables(live, CLASS_CONTENT_INVENTORY)).toEqual([]);
    });

    it('10. a signal the tenant added waits in the tray — never on a nearby anchor', async () => {
      await granted();
      await app.get(ClientCatalogService).editClass(acme, CLASS, {
        expectedSignals: [...SIGNALS, { signal: 'exhaust_temp_c', unit: 'degC', required: false }],
      });
      const read = await tenantModels.read(acme, CLASS);
      expect(read.tray).toEqual([{ signal: 'exhaust_temp_c', needsRecheck: false }]);
      expect(read.anchors.map((a) => a.signal)).toEqual(['coolant_temp_c', 'oil_pressure_kpa']);
    });

    it('11. a moved or added anchor becomes the account\'s own; one left where it was keeps its flags', async () => {
      await granted();
      await app.get(ClientCatalogService).editClass(acme, CLASS, {
        expectedSignals: [...SIGNALS, { signal: 'exhaust_temp_c', unit: 'degC', required: false }],
      });
      const read = await tenantModels.replaceAnchors(acme, CLASS, [
        at('coolant_temp_c', 1, 2, 0), at('oil_pressure_kpa', -1.5, 1, 0.5), at('exhaust_temp_c', 0, 2.5, 0),
      ]);
      expect(Object.fromEntries(read.anchors.map((a) => [a.signal, a.placementCustom]))).toEqual({
        coolant_temp_c: false, oil_pressure_kpa: true, exhaust_temp_c: true,
      });
      expect(read.tray).toEqual([]);
      await expect(tenantModels.replaceAnchors(acme, CLASS, [at('coolant_temp_c', 0, 0, 7)])).rejects.toThrow(/outside the model's bounds/);
    });

    it('12. a tenant cannot read another tenant\'s model anchors — directly, and over HTTP', async () => {
      await granted();
      expect(await withTenantId(app.get(DataSource), 'globex', (m) => m.getRepository(ClientEquipmentClassVisualAnchor).count())).toBe(0);
      const globex = await request(app.getHttpServer()).get(`/api/v1/my-catalog/equipment-classes/${CLASS}/model`)
        .set('Authorization', `Bearer ${await bearerTenant('globex')}`);
      expect(globex.status).toBe(404);
      const own = await request(app.getHttpServer()).get(`/api/v1/my-catalog/equipment-classes/${CLASS}/model`)
        .set('Authorization', `Bearer ${await bearerTenant('acme')}`);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ state: 'ready', geometryVersion: 1, tray: [] });
      expect(own.body.anchors).toHaveLength(2);
    });

    it('13. a tenant anchor outside the bounds is refused by the trigger; the same anchor awaiting recheck is accepted', async () => {
      await granted();
      const insert = (recheck: boolean) => inAcme((m) => m.query(
        `INSERT INTO client_equipment_class_visual_anchor
           (tenant_id, client_equipment_class_slug, tier, signal, pos_x, pos_y, pos_z, placement_custom, needs_recheck, template_version)
         VALUES ('acme', $1, 'model', 'exhaust_temp_c', 9, 1, 0, true, $2, 1)`, [CLASS, recheck],
      ));
      await expect(insert(false)).rejects.toThrow(/ck_client_anchor_fits: anchor for "exhaust_temp_c" .* outside the model's bounds/);
      await expect(insert(true)).resolves.toBeDefined();
    });
  });

  // ================================================================ upgrade
  describe('a class upgrade under a placed marker', () => {
    /** acme holds v1 and has moved the oil marker; v2 is published with `bounds`. */
    const upgradeTo = async (reupload: ModelBounds | null) => {
      await granted();
      await tenantModels.replaceAnchors(acme, CLASS, [at('coolant_temp_c', 1, 2, 0), at('oil_pressure_kpa', -1.5, 1, 0.5)]);
      await authoring.editClass(platform, CLASS, { description: 'v2' });
      if (reupload) await upload(2, reupload);
      await models.replaceAnchors(platform, CLASS, 2, [at('coolant_temp_c', 1.5, 2.5, 0), at('oil_pressure_kpa', 0, 0, 0)]);
      await authoring.publishClass(platform, CLASS);
      const upgrades = app.get(ClassUpgradeService);
      const preview = await upgrades.preview(acme, CLASS);
      await upgrades.apply(acme, CLASS, 2);
      return { preview, read: await tenantModels.read(acme, CLASS) };
    };

    it('14. a new geometry_version: the hand-placed marker is kept, marked, and moved to the tray; class markers follow', async () => {
      const { preview, read } = await upgradeTo({ min: [-3, 0, -1], max: [3, 4, 1] });
      expect(preview.modelAnchors).toEqual({ added: [], removed: [], keptCustom: ['oil_pressure_kpa'], needsRecheck: ['oil_pressure_kpa'] });
      expect(read.geometryVersion).toBe(2);
      const bySignal = Object.fromEntries(read.anchors.map((a) => [a.signal, a]));
      expect(bySignal.oil_pressure_kpa).toMatchObject({ x: -1.5, y: 1, z: 0.5, placementCustom: true, needsRecheck: true });
      expect(bySignal.coolant_temp_c).toMatchObject({ x: 1.5, y: 2.5, placementCustom: false, needsRecheck: false });
      expect(read.tray).toEqual([{ signal: 'oil_pressure_kpa', needsRecheck: true }]);
    });

    it('15. the same geometry_version: nothing is marked', async () => {
      const { preview, read } = await upgradeTo(null);
      expect(preview.modelAnchors.needsRecheck).toEqual([]);
      expect(read.anchors.every((a) => !a.needsRecheck)).toBe(true);
      expect(read.tray).toEqual([]);
    });

    it('16. confirming the marker clears the flag and returns it to the model', async () => {
      await upgradeTo({ min: [-3, 0, -1], max: [3, 4, 1] });
      const read = await tenantModels.confirmAnchor(acme, CLASS, 'oil_pressure_kpa');
      expect(read.anchors.find((a) => a.signal === 'oil_pressure_kpa')).toMatchObject({ x: -1.5, needsRecheck: false });
      expect(read.tray).toEqual([]);
    });

    it('a marker the new geometry no longer contains cannot be confirmed — it has to be moved', async () => {
      await upgradeTo({ min: [0, 0, -1], max: [3, 4, 1] });
      await expect(tenantModels.confirmAnchor(acme, CLASS, 'oil_pressure_kpa')).rejects.toThrow(/Move it instead/);
    });
  });

  // ============================================================ concurrency
  it('17. two confirms of the same marker together both settle; the flag is cleared and there is one row', async () => {
    await granted();
    await inAcme((m) => m.query(`UPDATE client_equipment_class_visual_anchor SET needs_recheck = true, placement_custom = true WHERE signal = 'oil_pressure_kpa'`));
    const results = await Promise.allSettled([
      tenantModels.confirmAnchor(acme, CLASS, 'oil_pressure_kpa'), tenantModels.confirmAnchor(acme, CLASS, 'oil_pressure_kpa'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await inAcme((m) => m.query(`SELECT needs_recheck FROM client_equipment_class_visual_anchor WHERE signal = 'oil_pressure_kpa'`));
    expect(rows).toEqual([{ needs_recheck: false }]);
  });

  it('18. two whole-set saves together both settle, and the stored set is exactly one of them', async () => {
    await granted();
    const a = [at('coolant_temp_c', 1, 1, 0)];
    const b = [at('coolant_temp_c', -1, 2, 0), at('oil_pressure_kpa', 0, 0.5, 0)];
    const results = await Promise.allSettled([tenantModels.replaceAnchors(acme, CLASS, a), tenantModels.replaceAnchors(acme, CLASS, b)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const stored = (await tenantModels.read(acme, CLASS)).anchors.map((x) => ({ signal: x.signal, x: x.x, y: x.y, z: x.z, label: x.label }));
    expect([JSON.stringify(a), JSON.stringify(b)]).toContain(JSON.stringify(stored));
  });

  // =================================================================== page
  describe('the twin_model widget', () => {
    const machineWithTwin = async () => {
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
      await inAcme((m) => m.query(
        `INSERT INTO client_equipment_class_layout (tenant_id, client_equipment_class_slug, widget_type, widget_key, position, size)
           VALUES ('acme', $1, 'twin_model', 'twin', 1, 'full')`, [CLASS],
      ));
      const page = await app.get(PageService).machinePage(acme, { sourceSystem: 'iot-platform-1', externalId: 'DG-1' });
      return page.widgets[0];
    };

    it('19. renders per machine: signed URL, geometry, markers with readiness, the tray with recheck markers', async () => {
      await granted();
      await inAcme((m) => m.query(`UPDATE client_equipment_class_visual_anchor SET needs_recheck = true, placement_custom = true WHERE signal = 'oil_pressure_kpa'`));
      const twin = await machineWithTwin();
      expect(twin).toMatchObject({ widgetType: 'twin_model', readiness: 'ready' });
      const data = twin.data as any;
      expect(data.modelUrl).toMatch(/X-Amz-Signature=/);
      expect(data).toMatchObject({ contentType: GLB, geometryVersion: 1, bounds: BOX });
      // No device fitted: the marker stays on the model, saying why it has no value.
      expect(data.anchors).toEqual([expect.objectContaining({
        signal: 'coolant_temp_c', x: 1, y: 2, z: 0, readiness: 'not_configured', reason: 'unbound', value: null, unit: 'degC',
      })]);
      expect(data.unplacedSignals).toEqual([expect.objectContaining({ signal: 'oil_pressure_kpa', needsRecheck: true, readiness: 'not_configured' })]);
    });

    /** A published class, granted, with whatever model row `insertModel` writes for v1. */
    const grantedWith = async (insertModel?: string) => {
      await draft();
      await authoring.publishClass(platform, CLASS);
      // INSERT into a published version is still open (PublishedClassImmutable1759300000000);
      // the fixture uses it to reach states the service cannot produce on a published class.
      if (insertModel) await owner.query(insertModel, [CLASS, GLB]);
      await copies.copyForTenant('acme', CLASS, 'deepak');
    };

    it('20. no model: unfilled, saying no_model — the reader falls back to the schematic or the list', async () => {
      await grantedWith();
      expect(await machineWithTwin()).toMatchObject({ readiness: 'not_available', reason: 'no_model', data: null });
    });

    it('20. an upload never confirmed: unfilled, saying upload_pending', async () => {
      await grantedWith(`INSERT INTO equipment_class_visual (class_slug, class_version, tier, pending_key, pending_content_type)
                           VALUES ($1, 1, 'model', 'class-models/x.glb', $2)`);
      expect(await machineWithTwin()).toMatchObject({ readiness: 'not_available', reason: 'upload_pending', data: null });
    });

    it('20. storage unconfigured: unfilled, saying assets_unavailable', async () => {
      await grantedWith(`INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, geometry_version,
                             bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z)
                           VALUES ($1, 1, 'model', 'class-models/x.glb', $2, 1, -1, -1, -1, 1, 1, 1)`);
      const configured = Object.getOwnPropertyDescriptor(storage, 'configured')!;
      Object.defineProperty(storage, 'configured', { value: false, configurable: true });
      try {
        expect(await machineWithTwin()).toMatchObject({ readiness: 'not_available', reason: 'assets_unavailable', data: null });
        expect((await tenantModels.read(acme, CLASS)).state).toBe('assets_unavailable');
      } finally {
        Object.defineProperty(storage, 'configured', configured);
      }
    });
  });

  // ============================================================== migration
  describe('the migration', () => {
    afterAll(() => owner.runMigrations({ transaction: 'all' }));

    it('21. down is refused while a model exists — removing a tier a twin shows is a decision, not a rollback', async () => {
      await withModel();
      await expect(undoMigrationNamed(owner, MIGRATION)).rejects.toThrow();
      await owner.runMigrations({ transaction: 'all' });
    }, 60_000);

    it('has a down path, named by its own migration, that leaves the schematic exactly as it was', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      const cols = await owner.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('equipment_class_visual', 'equipment_class_visual_anchor', 'client_equipment_class_visual_anchor')
           AND column_name IN ('tier', 'pos_x', 'pos_y', 'pos_z', 'geometry_version', 'bounds_min_x')
         ORDER BY table_name, column_name`);
      // `tier` on the visual is QREC0c's own column; only the anchors' is this migration's.
      expect(cols).toEqual([{ column_name: 'tier' }]);
      const fns = await owner.query(`SELECT proname FROM pg_proc WHERE proname IN ('ck_model_anchor_fits', 'trg_class_anchor_fits', 'trg_client_anchor_fits')`);
      expect(fns).toEqual([]);
      await draft();
      await expect(owner.query(
        `INSERT INTO equipment_class_visual (class_slug, class_version, tier) VALUES ($1, 1, 'model')`, [CLASS],
      )).rejects.toThrow(/ck_class_visual_tier/);
      await expect(owner.query(
        `INSERT INTO equipment_class_layout (class_slug, class_version, widget_type, widget_key, position, size)
           VALUES ($1, 1, 'twin_model', 'twin', 1, 'full')`, [CLASS],
      )).rejects.toThrow(/ck_class_layout_widget_type/);
      await owner.runMigrations({ transaction: 'all' });
    }, 60_000);
  });
});

/** The model reads with no storage configured at all. */
describeDb('the 3-D twin with no storage configured', () => {
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

  it('the API boots, a confirmed model reads assets_unavailable, and an upload is refused naming why', async () => {
    await app.get(CatalogAuthoringService).createClass(platform, CLASS, { name: 'x', expectedSignals: SIGNALS });
    await owner.query(
      `INSERT INTO equipment_class_visual (class_slug, class_version, tier, asset_key, content_type, geometry_version,
           bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z)
         VALUES ($1, 1, 'model', 'class-models/x.glb', $2, 1, -1, -1, -1, 1, 1, 1)`, [CLASS, GLB],
    );
    const models = app.get(ClassModelService);
    expect((await models.read(CLASS, 1)).state).toBe('assets_unavailable');
    await expect(models.issueUploadUrl(platform, CLASS, 1, GLB)).rejects.toThrow(/assets_unavailable/);
  });
});
