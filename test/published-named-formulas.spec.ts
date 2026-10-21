import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * The published half of the formula catalogue, read by an account (QGEN2's
 * bind-named-formula picker).
 *
 * A client may now list formulas it could bind, and nothing else: no draft, and one
 * entry per formula, its newest published version, because that is the one a binding
 * takes. The authoring list stays Things Alive's — asked by the same client, it is
 * refused, so this route is the only one an account reads the library through.
 */
const SECRET = 'test-secret-published-formulas';
const ISSUER = 'things-alive-published-formulas-test';

describeDb('published named formulas, read by an account', () => {
  let owner: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();

    // One formula published twice and drafting a third, and one that was never published.
    const row = (slug: string, version: number, status: 'published' | 'draft') => owner.query(
      `INSERT INTO named_formula (slug, version, name, expression, inputs, status, published_at, compiled_plan, compiler_version, result_unit)
       VALUES ($1, $2, $3, 'fuel_in', '[{"role":"fuel_in","dimension":"L/h"}]'::jsonb, $4,
               CASE WHEN $4 = 'published' THEN now() END, CASE WHEN $4 = 'published' THEN '{}'::jsonb END,
               CASE WHEN $4 = 'published' THEN 'qgeo1.0.0' END, 'L/h')`,
      [slug, version, `${slug} v${version}`, status],
    );
    await row('zz_fuel_burn', 1, 'published');
    await row('zz_fuel_burn', 2, 'published');
    await row('zz_fuel_burn', 3, 'draft');
    await row('zz_never_published', 1, 'draft');
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const client = () => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000f1', client_id: 'acme', roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
  );

  it('lists each published formula once, at its newest published version, and no draft', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/catalog/named-formulas').set('Authorization', `Bearer ${await client()}`);
    expect(res.status).toBe(200);
    const ours = res.body.filter((f: { slug: string }) => f.slug.startsWith('zz_'));
    expect(ours.map((f: { slug: string; version: number; status: string }) => [f.slug, f.version, f.status]))
      .toEqual([['zz_fuel_burn', 2, 'published']]);
    expect(res.body.every((f: { status: string }) => f.status === 'published')).toBe(true);
  });

  it('still refuses the same account the authoring list, drafts and all', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/platform/catalog/named-formulas').set('Authorization', `Bearer ${await client()}`);
    expect(res.status).toBe(403);
  });
});
