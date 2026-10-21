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
 * An edit changes what it was sent and nothing else (dashboard testing, issues 7 and 8).
 *
 * The request DTO carries every optional field as `undefined` when the body leaves it
 * out, and the authoring edits copied those onto the working version. Editing a
 * published scenario forked a new draft and wrote its class slug as NULL (a 500), and
 * editing any alert template renamed its class to "undefined" before checking the
 * signal against it. Only a request through the real validation pipe builds that DTO,
 * so these go over HTTP, sending exactly what the console's edit forms send.
 */
describeDb('catalog edits keep what they were not sent', () => {
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
        "scenario_definition", "alert_rule_template"
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

  it('edits a published scenario into a new draft that keeps its class', async () => {
    await as(http().post('/api/v1/catalog/scenarios')).send({
      slug: 'overheat-watch', equipmentClassSlug: CLASS_SLUG, name: 'Overheat Watch', requiredSignals: ['coolant_temp_c'],
    });
    await as(http().post('/api/v1/catalog/scenarios/overheat-watch/publish'));

    // What AddScenarioModal sends: no equipmentClassSlug.
    const edit = await as(http().patch('/api/v1/catalog/scenarios/overheat-watch')).send({
      name: 'Overheat Watch, reworded', severity: 'medium', tier: 1,
      requiredSignals: ['coolant_temp_c'], minimumHistoryDays: 0,
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({
      version: 2, status: 'draft', equipmentClassSlug: CLASS_SLUG, name: 'Overheat Watch, reworded',
    });

    const [published] = await owner.query(
      `SELECT name, status FROM scenario_definition WHERE slug = 'overheat-watch' AND version = 1`,
    );
    expect(published).toEqual({ name: 'Overheat Watch', status: 'published' });
  });

  it('edits a draft alert template without losing its class', async () => {
    await as(http().post('/api/v1/catalog/alert-templates')).send({
      slug: 'coolant-high', equipmentClassSlug: CLASS_SLUG, name: 'Coolant High',
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105 }, severity: 'medium',
    });

    const edit = await as(http().patch('/api/v1/catalog/alert-templates/coolant-high')).send({
      name: 'Coolant High', description: 'Coolant above its operating limit.',
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 110 }, severity: 'medium',
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ version: 1, equipmentClassSlug: CLASS_SLUG, params: { max: 110 } });
  });

  it('edits a published alert template into a new draft that keeps its class', async () => {
    await as(http().post('/api/v1/catalog/alert-templates')).send({
      slug: 'coolant-high', equipmentClassSlug: CLASS_SLUG, name: 'Coolant High',
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105 }, severity: 'medium',
    });
    await as(http().post('/api/v1/catalog/alert-templates/coolant-high/publish'));

    const edit = await as(http().patch('/api/v1/catalog/alert-templates/coolant-high')).send({
      name: 'Coolant Very High', trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 115 },
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ version: 2, status: 'draft', equipmentClassSlug: CLASS_SLUG });
  });

  it('edits a published class into a new draft that keeps the fields it was not sent', async () => {
    const [before] = await owner.query(
      `SELECT name, category, expected_signals FROM equipment_class_profile WHERE slug = $1 AND version = 1`, [CLASS_SLUG],
    );

    const edit = await as(http().patch(`/api/v1/catalog/equipment-classes/${CLASS_SLUG}`)).send({
      description: 'Reworded description only.',
    });
    expect(edit.status).toBe(200);

    const [after] = await owner.query(
      `SELECT name, category, expected_signals, description FROM equipment_class_profile WHERE slug = $1 AND version = 2`,
      [CLASS_SLUG],
    );
    expect(after).toMatchObject({
      name: before.name, category: before.category, expected_signals: before.expected_signals,
      description: 'Reworded description only.',
    });
  });
});
