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
 * A chain written through the API is the chain that gets stored (dashboard testing,
 * issue 11).
 *
 * The request DTO typed `nodes` as a bare array, and the validation pipe's implicit
 * conversion stored every stage as an empty array: `[[]]`. The console's chain editor
 * crashed opening one, which is the blank page testing reported. Only a request
 * through the real pipe shows it, so these go over HTTP with what the editor sends.
 */
describeDb('causal chains written over HTTP', () => {
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
        "sensor_role_capability", "equipment_class_profile", "sensor",
        "scenario_definition", "alert_rule_template", "causal_chain"
       RESTART IDENTITY CASCADE`,
    );
    await owner.query(`INSERT INTO "sensor" (sensor_name, slug) VALUES ('Coolant Temp Probe', 'coolant-temp-probe')`);

    const buffer = await templates.build(new Date('2026-09-24T00:00:00.000Z'));
    const upload = await as(request(app.getHttpServer()).post('/api/v1/platform/catalog/imports'))
      .attach('file', buffer, 'catalog.xlsx');
    await as(request(app.getHttpServer()).post(`/api/v1/platform/catalog/imports/${upload.body.id}/apply`));
    await as(request(app.getHttpServer()).post(`/api/v1/catalog/equipment-classes/${CLASS_SLUG}/publish`));
  });

  const token = mintPlatformToken(
    { role: 'master-admin', subject: 'master-admin@things-alive.io' }, { secret: SECRET, issuer: ISSUER },
  ).token;
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const http = () => request(app.getHttpServer());


  const stage = {
    signal: 'coolant_temp_c', label: 'Coolant under load', intercept: 20, warnAbove: 5, criticalAbove: 10,
    direction: 'above', drivers: [{ signal: 'engine_load_pct', coefficient: 0.5, lagSeconds: 60 }],
  };

  it('stores the stages it was sent, on create and on replacing a draft', async () => {
    const create = await as(http().post('/api/v1/intelligence/chains/engine-temp-chain')).send({
      equipmentClassSlug: CLASS_SLUG, name: 'Engine Temperature Warning Chain', nodes: [stage],
    });
    expect(create.status).toBe(201);
    expect(create.body.nodes).toEqual([stage]);

    const replaced = await as(http().post('/api/v1/intelligence/chains/engine-temp-chain')).send({
      equipmentClassSlug: CLASS_SLUG, name: 'Engine Temperature Warning Chain',
      nodes: [{ ...stage, warnAbove: 6, criticalAbove: 12 }],
    });
    expect(replaced.status).toBe(201);

    const [row] = await owner.query(`SELECT nodes FROM causal_chain WHERE slug = 'engine-temp-chain'`);
    expect(row.nodes).toEqual([{ ...stage, warnAbove: 6, criticalAbove: 12 }]);
  });

  it('refuses a stage with no signal, and a stage carrying a field it does not know', async () => {
    const noSignal = await as(http().post('/api/v1/intelligence/chains/broken')).send({
      equipmentClassSlug: CLASS_SLUG, name: 'Broken', nodes: [{ ...stage, signal: '' }],
    });
    expect(noSignal.status).toBe(400);

    const stray = await as(http().post('/api/v1/intelligence/chains/broken')).send({
      equipmentClassSlug: CLASS_SLUG, name: 'Broken', nodes: [{ ...stage, colour: 'red' }],
    });
    expect(stray.status).toBe(400);
    expect(Number((await owner.query(`SELECT count(*) AS n FROM causal_chain`))[0].n)).toBe(0);
  });
});
