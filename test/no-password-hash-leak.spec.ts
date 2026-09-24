import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { AppUser } from '../src/identity/entities/app-user.entity';
import { TenantRole } from '../src/identity/entities/tenant-role.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';
const TENANT = 'acme';

/**
 * `IdentityController`'s `UserView` used to spread the whole `AppUser` entity into
 * every response, which meant `GET /identity/users` returned every user's password
 * hash to any caller holding `user.manage`. Fixed in `UserService.view()` by
 * selecting the view's declared fields instead of spreading the entity.
 *
 * This test is deliberately generic rather than asserting the fix's mechanism: it
 * walks every response body from every identity and platform-staff endpoint and
 * fails if a key literally named `passwordHash` appears anywhere in it, at any
 * depth. The next place somebody spreads an entity into a response is caught the
 * same way this one was found, not by remembering to extend a hand-written list.
 */
describeDb('no response leaks a password hash', () => {
  let ds: DataSource;
  let owner: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 30_000);

  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['app_user', 'tenant_role', 'platform_user', 'platform_invitation', 'platform_session']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  const leaks: string[] = [];

  const recordLeaks = (label: string, body: unknown): void => {
    for (const path of findKey(body, 'passwordHash')) leaks.push(`${label}: ${path}`);
  };

  it('across every identity and platform-staff endpoint', async () => {
    // ------------------------------------------------------------- tenant side
    const role = await owner.getRepository(TenantRole).save(owner.getRepository(TenantRole).create({
      tenantId: TENANT, slug: 'people-manager', name: 'People Manager',
      capabilities: ['user.manage'], scopeShape: 'tenant',
    }));
    const manager = await owner.getRepository(AppUser).save(owner.getRepository(AppUser).create({
      tenantId: TENANT, email: 'manager@acme.test', fullName: 'Manager', roleSlug: role.slug,
      status: 'active', passwordHash: 'irrelevant-for-this-test',
    }));
    const tenantToken = await app.get(JwtService).signAsync(
      { sub: manager.id, client_id: TENANT }, { secret: SECRET, issuer: ISSUER },
    );
    const tenantAuth = (req: request.Test) => req.set('Authorization', `Bearer ${tenantToken}`);

    const invite = await tenantAuth(request(app.getHttpServer()).post('/api/v1/identity/users'))
      .send({ email: 'new-hire@acme.test', fullName: 'New Hire', roleSlug: role.slug });
    recordLeaks('POST /identity/users', invite.body);
    const invitedId = invite.body.id;

    const list = await tenantAuth(request(app.getHttpServer()).get('/api/v1/identity/users'));
    recordLeaks('GET /identity/users', list.body);

    const setRole = await tenantAuth(request(app.getHttpServer()).put(`/api/v1/identity/users/${invitedId}/role`))
      .send({ roleSlug: role.slug });
    recordLeaks('PUT /identity/users/:id/role', setRole.body);

    const suspend = await tenantAuth(request(app.getHttpServer()).post(`/api/v1/identity/users/${invitedId}/suspend`))
      .send({ reason: 'testing' });
    recordLeaks('POST /identity/users/:id/suspend', suspend.body);

    const reinstate = await tenantAuth(request(app.getHttpServer()).post(`/api/v1/identity/users/${invitedId}/reinstate`));
    recordLeaks('POST /identity/users/:id/reinstate', reinstate.body);

    // ------------------------------------------------------------ platform side
    const platformToken = mintPlatformToken(
      { role: 'master-admin', subject: 'master-admin@things-alive.io' }, { secret: SECRET, issuer: ISSUER },
    ).token;
    const platformAuth = (req: request.Test) => req.set('Authorization', `Bearer ${platformToken}`);

    const staffInvite = await platformAuth(request(app.getHttpServer()).post('/api/v1/platform/staff'))
      .send({ email: 'new-staff@things-alive.io', fullName: 'New Staff', role: 'catalog-author' });
    recordLeaks('POST /platform/staff', staffInvite.body);
    const staffId = staffInvite.body.id;

    const staffList = await platformAuth(request(app.getHttpServer()).get('/api/v1/platform/staff'));
    recordLeaks('GET /platform/staff', staffList.body);

    const staffSuspend = await platformAuth(request(app.getHttpServer()).post(`/api/v1/platform/staff/${staffId}/suspend`))
      .send({ reason: 'testing' });
    recordLeaks('POST /platform/staff/:id/suspend', staffSuspend.body);

    const staffReinstate = await platformAuth(request(app.getHttpServer()).post(`/api/v1/platform/staff/${staffId}/reinstate`));
    recordLeaks('POST /platform/staff/:id/reinstate', staffReinstate.body);

    // Naming the offending endpoint and path matters more than the count.
    expect(leaks).toEqual([]);
  });
});

/** Every path at which `key` appears anywhere in `value`, at any depth. */
function findKey(value: unknown, key: string, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findKey(v, key, `${path}[${i}]`));
  const hits: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (k === key) hits.push(p);
    hits.push(...findKey(v, key, p));
  }
  return hits;
}
