import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

/**
 * A staff member's new role takes effect at once (tester bug TC_149). The role rides
 * in the access token, so changing it reached nobody already signed in: they kept the
 * old pages, and a demoted Master Admin kept Master Admin's reach, until the token ran
 * out. The change now ends their sessions. Asserted over HTTP by presenting the old
 * tokens after the change and expecting the refusal.
 */
const SECRET = 'test-secret-staff-role-change';
const ISSUER = 'things-alive-staff-role-change-test';
const PASSWORD = 'Correct-Horse-1';

describeDb('changing a staff member\'s role ends their sessions (TC_149)', () => {
  let owner: DataSource;
  let app: INestApplication;
  let platformToken: string;
  const http = () => request(app.getHttpServer());

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
    platformToken = mintPlatformToken(
      { role: 'master-admin', subject: 'ops@things-alive.io' }, { secret: SECRET, issuer: ISSUER },
    ).token;
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  type Session = { accessToken: string; refreshToken: string };
  const asPlatform = (req: request.Test) => req.set('Authorization', `Bearer ${platformToken}`);
  const permissions = (accessToken: string) =>
    http().get('/api/v1/me/permissions').set('Authorization', `Bearer ${accessToken}`);
  const setRole = (id: string, role: string) => asPlatform(http().put(`/api/v1/platform/staff/${id}/role`)).send({ role });

  let n = 0;
  const signedInStaff = async (role: string) => {
    n += 1;
    const email = `staff${n}@role.example`;
    const invited = await asPlatform(http().post('/api/v1/platform/staff')).send({ email, fullName: `Staff ${n}`, role });
    expect(invited.status).toBe(201);
    const session = (await http().post('/api/v1/platform/auth/accept-invitation')
      .send({ token: invited.body.invitationToken, password: PASSWORD })).body as Session;
    return { id: invited.body.id as string, email, session };
  };

  it('TC_149: after the change, the old access token is refused and the refresh says why', async () => {
    const { id, session } = await signedInStaff('platform-support');
    expect((await permissions(session.accessToken)).body.capabilities['catalog.write']).toBe(false);

    expect((await setRole(id, 'catalog-author')).status).toBe(200);

    expect((await permissions(session.accessToken)).status).toBe(401);
    const refused = await http().post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toBe('Your role was changed. Please sign in again.');
  });

  it('signing in again carries the new role', async () => {
    const { id, email } = await signedInStaff('platform-support');
    await setRole(id, 'catalog-author');

    const again = (await http().post('/api/v1/auth/sign-in').send({ email, password: PASSWORD })).body as Session;
    expect((await permissions(again.accessToken)).body.capabilities['catalog.write']).toBe(true);
  });

  it('a demoted Master Admin loses Master Admin\'s reach at once, not when the token runs out', async () => {
    const { id, session } = await signedInStaff('master-admin');
    const staffList = () => http().get('/api/v1/platform/staff').set('Authorization', `Bearer ${session.accessToken}`);
    expect((await staffList()).status).toBe(200);

    await setRole(id, 'platform-support');

    expect((await staffList()).status).toBe(401);
  });

  it('choosing the role they already hold changes nothing and ends nothing', async () => {
    const { id, session } = await signedInStaff('catalog-author');

    expect((await setRole(id, 'catalog-author')).body.role).toBe('catalog-author');

    expect((await permissions(session.accessToken)).status).toBe(200);
  });
});
