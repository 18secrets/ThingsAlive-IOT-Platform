import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';

/**
 * The sensor-review endpoint, through the route (task QFIX-SENSORS).
 *
 * All twelve tests in catalog-import-sensor-review.spec.ts call the service directly,
 * so the controller binding was never exercised — and the endpoint 500'd on a body
 * that arrived undefined, in front of the library team. Every case here goes through
 * HTTP, the app built by the same `createApp` the service runs, global pipe included.
 */
describeDb('catalog import: sensor review over HTTP', () => {
  let owner: DataSource;
  let app: INestApplication;
  let templates: CatalogTemplateService;
  let batchId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    templates = new CatalogTemplateService();

    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 30_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const bearer = (role: 'master-admin' | 'platform-support') =>
    mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token;

  const sensors = () => request(app.getHttpServer())
    .post(`/api/v1/platform/catalog/imports/${batchId}/sensors`)
    .set('Authorization', `Bearer ${bearer('master-admin')}`);

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "sensor", "sensor_category"
       RESTART IDENTITY CASCADE`,
    );
    // The plain template, with nothing catalogued: its sensor_capability row names
    // "Coolant Temp Probe" in category "Engine", so the batch proposes both.
    const upload = await request(app.getHttpServer())
      .post('/api/v1/platform/catalog/imports')
      .set('Authorization', `Bearer ${bearer('master-admin')}`)
      .attach('file', await templates.build(new Date('2026-10-05T00:00:00Z')), 'library.xlsx');
    expect(upload.status).toBe(201);
    batchId = upload.body.id;
  });

  const text = (res: request.Response) => JSON.stringify(res.body);

  it('1. no body at all is a 400 naming the three fields, not a 500', async () => {
    const res = await sensors();
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/approveCategories.*approve.*dismiss/);
  });

  it('2. an empty object is a 400 — an approval that approves nothing is a mistake', async () => {
    const res = await sensors().send({});
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/approveCategories.*approve.*dismiss/);
  });

  it('2b. three empty arrays are the same mistake', async () => {
    const res = await sensors().send({ approveCategories: [], approve: [], dismiss: [] });
    expect(res.status).toBe(400);
  });

  it('3. a typo\'d field is a 400 naming it, not a silent no-op', async () => {
    const res = await sensors().send({ approveCategory: [{ slug: 'engine' }] });
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/approveCategory should not exist/);
  });

  it('4. an entry without a slug is a 400 naming the array and the index', async () => {
    const res = await sensors().send({ approve: [{ slug: 'coolant-temp-probe' }, {}] });
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/approve\.1\.slug/);
  });

  it('5. a well-formed approval succeeds, and the sensor and its category exist afterwards', async () => {
    const res = await sensors().send({
      approveCategories: [{ slug: 'engine' }], approve: [{ slug: 'coolant-temp-probe' }],
    });
    // 201, the status this route has always returned (no @HttpCode) — kept, because
    // the library team's client already reads it; see the QFIX-SENSORS report.
    expect(res.status).toBe(201);
    expect(res.body.proposedSensors).toEqual([]);

    const [sensor] = await owner.query(`SELECT slug FROM sensor WHERE slug = 'coolant-temp-probe'`);
    expect(sensor).toBeDefined();
    const [category] = await owner.query(`SELECT count(*)::int AS n FROM sensor_category`);
    expect(category.n).toBe(1);
  });

  it('6. a caller without catalog.write is refused with 403, not 500', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/platform/catalog/imports/${batchId}/sensors`)
      .set('Authorization', `Bearer ${bearer('platform-support')}`)
      .send({ approve: [{ slug: 'coolant-temp-probe' }] });
    expect(res.status).toBe(403);
  });
});
