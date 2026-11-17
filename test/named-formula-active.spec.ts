import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { NamedFormulaService } from '../src/catalog/services/named-formula.service';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'NamedFormulaActive1763600000000';
const SECRET = 'test-secret-named-formula-active';
const ISSUER = 'things-alive-named-formula-active-test';
const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

/**
 * Inactive named formulas (testing sheet TC_144/TC_151, 5 Nov 2026): the soft delete.
 *
 * Nothing is removed — `ta_app` still has no DELETE on the table, and these never ask it
 * to. An inactive formula leaves the picker and takes no new version; switching it is one
 * act over every version, and the database refuses a slug whose versions disagree.
 */
describeDb('named formulas: active and inactive', () => {
  let owner: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let service: NamedFormulaService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    service = new NamedFormulaService(ds.getRepository(NamedFormula));
    Object.assign(process.env, { AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, CORS_ORIGINS: 'http://localhost:3000' });
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    // The seeded library stays; these tests use their own slugs.
    await owner.query(`DELETE FROM "named_formula" WHERE "created_by" = 'deepak'`);
  });

  const draft = {
    name: 'Specific Fuel Consumption',
    expression: 'fuel_rate / power_output',
    inputs: [{ role: 'fuel_rate', dimension: 'L/h' }, { role: 'power_output', dimension: 'kW' }],
  };
  /** v1 published, v2 published: a formula with history. */
  const twoVersions = async (slug: string) => {
    await service.create(scope, slug, draft);
    await service.publish(scope, slug, 1);
    await service.create(scope, slug, { ...draft, description: 'v2' });
    await service.publish(scope, slug, 2);
  };
  const bearer = (role: 'master-admin' | 'catalog-author') =>
    `Bearer ${mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token}`;
  const post = (path: string, role: 'master-admin' | 'catalog-author' = 'master-admin') =>
    request(app.getHttpServer()).post(`/api/v1/platform/catalog/named-formulas/${path}`).set('Authorization', bearer(role));

  it('inactive takes every version out of the picker; active puts the newest back', async () => {
    await twoVersions('sfc-a');
    const versions = await service.setActive(scope, 'sfc-a', false, new Date('2026-11-05T10:00:00Z'));
    expect(versions.map((v) => [v.version, v.active, v.deactivatedBy])).toEqual([[2, false, 'deepak'], [1, false, 'deepak']]);
    expect((await service.listPublished()).map((f) => f.slug)).not.toContain('sfc-a');

    await service.setActive(scope, 'sfc-a', true);
    const back = (await service.listPublished()).filter((f) => f.slug === 'sfc-a');
    expect(back.map((f) => [f.version, f.active, f.deactivatedAt])).toEqual([[2, true, null]]);
  });

  it('nothing is deleted: the rows are all still there, inactive', async () => {
    await twoVersions('sfc-b');
    await service.setActive(scope, 'sfc-b', false);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM "named_formula" WHERE "slug" = 'sfc-b' AND NOT "active"`);
    expect(n).toBe(2);
  });

  it('an inactive formula takes no new version, from the service or past it', async () => {
    await twoVersions('sfc-c');
    await service.setActive(scope, 'sfc-c', false);
    await expect(service.create(scope, 'sfc-c', draft)).rejects.toThrow(/inactive/);
    // A writer that skips the service: an active v3 beside two inactive versions is refused at commit.
    await expect(ds.query(
      `INSERT INTO "named_formula" ("slug", "version", "name", "expression", "created_by") VALUES ('sfc-c', 3, 'x', 'a', 'deepak')`,
    )).rejects.toThrow(/ck_named_formula_one_state/);
  });

  it('the database refuses one version switched on its own', async () => {
    await twoVersions('sfc-d');
    await expect(ds.query(
      `UPDATE "named_formula" SET "active" = false, "deactivated_at" = now() WHERE "slug" = 'sfc-d' AND "version" = 1`,
    )).rejects.toThrow(/ck_named_formula_one_state/);
  });

  it('inactive needs a date it was made inactive', async () => {
    await twoVersions('sfc-e');
    await expect(ds.query(`UPDATE "named_formula" SET "active" = false WHERE "slug" = 'sfc-e'`))
      .rejects.toThrow(/ck_named_formula_deactivated/);
  });

  it('deactivate is idempotent: two at once both settle, the formula is inactive once, the first date stands', async () => {
    await twoVersions('sfc-f');
    const results = await Promise.allSettled([post('sfc-f/deactivate'), post('sfc-f/deactivate')]);
    expect(results.map((r) => r.status === 'fulfilled' && r.value.status)).toEqual([200, 200]);
    const rows = await owner.query(`SELECT DISTINCT "deactivated_at" FROM "named_formula" WHERE "slug" = 'sfc-f'`);
    expect(rows).toHaveLength(1);
    const again = await post('sfc-f/deactivate');
    expect(again.status).toBe(200);
    expect(new Date(again.body[0].deactivatedAt).getTime()).toBe(new Date(rows[0].deactivated_at).getTime());
  });

  it('a catalog author may make one inactive; only Master Admin makes it active again', async () => {
    await twoVersions('sfc-g');
    expect((await post('sfc-g/deactivate', 'catalog-author')).status).toBe(200);
    expect((await post('sfc-g/activate', 'catalog-author')).status).toBe(403);
    expect((await post('sfc-g/activate')).status).toBe(200);
    expect((await post('no-such-formula/deactivate')).status).toBe(404);
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const cols = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'named_formula' AND column_name = 'active'`);
    expect(cols).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'named_formula' AND column_name = 'active'`);
    expect(back).toHaveLength(1);
  });
});
