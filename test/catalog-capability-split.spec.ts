import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';
const CLASS_SLUG = 'diesel-generator';

/**
 * Task QPA2, part 2 — catalog.write covers loading content, catalog.publish covers
 * shipping it. Proven end to end, the same workbook-import round trip
 * catalog-import-apply.spec.ts already uses: a catalog-author can upload, diff and
 * apply (all catalog.write), and is refused the one act catalog.publish gates.
 */
describeDb('catalog capability split: write vs. publish', () => {
  let ds: DataSource;
  let owner: DataSource;
  let app: INestApplication;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    templates = new CatalogTemplateService();

    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 30_000);

  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
  });

  const bearer = (role: 'master-admin' | 'catalog-author') =>
    mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token;

  const uploadAndApply = async (role: 'master-admin' | 'catalog-author') => {
    const buffer = await templates.build(new Date('2026-09-24T00:00:00.000Z'));
    const upload = await request(app.getHttpServer())
      .post('/api/v1/platform/catalog/imports')
      .set('Authorization', `Bearer ${bearer(role)}`)
      .attach('file', buffer, `${role}.xlsx`);
    expect(upload.status).toBe(201);

    const apply = await request(app.getHttpServer())
      .post(`/api/v1/platform/catalog/imports/${upload.body.id}/apply`)
      .set('Authorization', `Bearer ${bearer(role)}`);
    expect(apply.status).toBe(201);
    return apply.body;
  };

  it('a catalog-author can upload, diff and apply a workbook — every import route is catalog.write', async () => {
    const buffer = await templates.build(new Date('2026-09-24T00:00:00.000Z'));
    const upload = await request(app.getHttpServer())
      .post('/api/v1/platform/catalog/imports')
      .set('Authorization', `Bearer ${bearer('catalog-author')}`)
      .attach('file', buffer, 'author.xlsx');
    expect(upload.status).toBe(201);

    const diff = await request(app.getHttpServer())
      .get(`/api/v1/platform/catalog/imports/${upload.body.id}`)
      .set('Authorization', `Bearer ${bearer('catalog-author')}`);
    expect(diff.status).toBe(200);

    const apply = await request(app.getHttpServer())
      .post(`/api/v1/platform/catalog/imports/${upload.body.id}/apply`)
      .set('Authorization', `Bearer ${bearer('catalog-author')}`);
    expect(apply.status).toBe(201);
    expect(apply.body.classes[CLASS_SLUG]).toMatchObject({ action: 'create' });
  });

  it('applying writes a draft — a catalog-author is refused publishing it', async () => {
    await uploadAndApply('catalog-author');

    const publish = await request(app.getHttpServer())
      .post(`/api/v1/catalog/equipment-classes/${CLASS_SLUG}/publish`)
      .set('Authorization', `Bearer ${bearer('catalog-author')}`);
    expect(publish.status).toBe(403);
  });

  it('master admin holds both: can apply and then publish the same class', async () => {
    await uploadAndApply('master-admin');

    const publish = await request(app.getHttpServer())
      .post(`/api/v1/catalog/equipment-classes/${CLASS_SLUG}/publish`)
      .set('Authorization', `Bearer ${bearer('master-admin')}`);
    expect(publish.status).toBe(201);
    expect(publish.body.status).toBe('published');
  });

  it('master admin can publish a class a catalog-author applied — the block is on publishing, not on this class', async () => {
    await uploadAndApply('catalog-author');

    const publish = await request(app.getHttpServer())
      .post(`/api/v1/catalog/equipment-classes/${CLASS_SLUG}/publish`)
      .set('Authorization', `Bearer ${bearer('master-admin')}`);
    expect(publish.status).toBe(201);
    expect(publish.body.status).toBe('published');
  });
});
