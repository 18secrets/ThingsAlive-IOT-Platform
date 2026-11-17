import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-rating-names';
const ISSUER = 'things-alive-rating-names-test';

/**
 * The ratings a model can carry, as a list for the model form (Crompton POC, 11 Nov): the
 * screen offered nothing to choose from, and a name typed by hand that the server did not
 * know came back as a refusal listing all of them. These hold the list to the server's
 * own validation: every name it offers, the ratings save takes, in the unit it says.
 */
describeDb('GET /equipment-templates/rating-names', () => {
  let owner: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, { AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, CORS_ORIGINS: 'http://localhost:3000' });
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const bearer = (role: 'master-admin' | 'platform-support') =>
    `Bearer ${mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token}`;
  const http = () => request(app.getHttpServer());

  it('lists the motor ratings with their units and what each means', async () => {
    const res = await http().get('/api/v1/equipment-templates/rating-names').set('Authorization', bearer('master-admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'rated_current', unit: 'A' }),
      expect.objectContaining({ name: 'max_starts_per_hour', unit: 'starts' }),
    ]));
    for (const r of res.body) expect(typeof r.description === 'string' || r.description === null).toBe(true);
  });

  it('every name it lists, the ratings save takes, in the unit it gives', async () => {
    const names: { name: string; unit: string | null }[] =
      (await http().get('/api/v1/equipment-templates/rating-names').set('Authorization', bearer('master-admin'))).body;
    const model = await http().post('/api/v1/equipment-templates').set('Authorization', bearer('master-admin')).send({ name: 'Mini 1 HP' });
    expect(model.status).toBe(201);
    const ratings = names.map((r) => ({ name: r.name, value: 1, ...(r.unit ? { unit: r.unit } : {}), source: 'catalogue p.5' }));
    const saved = await http().put(`/api/v1/equipment-templates/${model.body.id}/ratings`)
      .set('Authorization', bearer('master-admin')).send({ ratings });
    expect(saved.status).toBe(200);
    expect(saved.body).toHaveLength(names.length);
  });

  it('is refused to a staff role without equipment-template.read', async () => {
    expect((await http().get('/api/v1/equipment-templates/rating-names').set('Authorization', bearer('platform-support'))).status).toBe(403);
  });
});
