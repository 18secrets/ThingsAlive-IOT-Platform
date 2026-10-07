import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

/**
 * D-003, phase 1 manual testing (T1): after signing out, a client's access token kept
 * working for the rest of its hour. Platform tokens were already refused on the next
 * request (QPA1); client tokens carried no session to check. Asserted over HTTP, the
 * way the console meets it, by attempting the request after the sign-in has ended.
 */
const SECRET = 'test-secret-tenant-session-revocation';
const ISSUER = 'things-alive-tenant-session-test';
const PASSWORD = 'Correct-Horse-1';

describeDb('client sign-out ends the access token too (D-003)', () => {
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

  /** A fresh account and its super admin, signed in through the real invitation path. */
  let n = 0;
  const signedInAdmin = async () => {
    n += 1;
    const provisioned = await http().post('/api/v1/accounts').set('Authorization', `Bearer ${platformToken}`).send({
      tenantId: `revoke-${n}`, name: `Revoke ${n}`, superAdmin: { email: `admin${n}@revoke.example`, fullName: 'Admin' },
    });
    expect(provisioned.status).toBe(201);
    const accepted = await http().post('/api/v1/auth/accept-invitation')
      .send({ token: provisioned.body.invitationToken, password: PASSWORD });
    expect(accepted.status).toBe(201);
    return { ...accepted.body as { accessToken: string; refreshToken: string }, email: `admin${n}@revoke.example` };
  };
  const me = (accessToken: string) => http().get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
  const signOut = (refreshToken: string) => http().post('/api/v1/auth/sign-out').send({ refreshToken });
  const refresh = (refreshToken: string) => http().post('/api/v1/auth/refresh').send({ refreshToken });

  it('the access token names its sign-in', async () => {
    const { accessToken } = await signedInAdmin();
    const payload = new JwtService({}).verify(accessToken, { secret: SECRET, issuer: ISSUER });
    const [row] = await owner.query(`SELECT family FROM user_session WHERE user_id = $1`, [payload.sub]);
    expect(payload.sid).toBe(row.family);
  });

  it('after sign-out, the still-unexpired access token is refused', async () => {
    const { accessToken, refreshToken } = await signedInAdmin();
    expect((await me(accessToken)).status).toBe(200);
    expect((await signOut(refreshToken)).status).toBe(201);
    const refused = await me(accessToken);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/sign-in has ended/);
  });

  it('a refresh is the same sign-in: both access tokens work, and one sign-out refuses both', async () => {
    const first = await signedInAdmin();
    const second = (await refresh(first.refreshToken)).body as { accessToken: string; refreshToken: string };
    expect((await me(first.accessToken)).status).toBe(200);
    expect((await me(second.accessToken)).status).toBe(200);

    await signOut(second.refreshToken);
    expect((await me(first.accessToken)).status).toBe(401);
    expect((await me(second.accessToken)).status).toBe(401);
  });

  it('a reused refresh token revokes the family, and its access token with it', async () => {
    const { accessToken, refreshToken } = await signedInAdmin();
    expect((await refresh(refreshToken)).status).toBe(201);
    // Presenting the retired token again is the theft signal.
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await me(accessToken)).status).toBe(401);
  });

  it('signing out on one device leaves another sign-in of the same person working', async () => {
    const laptop = await signedInAdmin();
    const phone = (await http().post('/api/v1/auth/sign-in').send({ email: laptop.email, password: PASSWORD })).body;
    await signOut(laptop.refreshToken);
    expect((await me(laptop.accessToken)).status).toBe(401);
    expect((await me(phone.accessToken)).status).toBe(200);
  });

  it('a token without a sid — issued before this change — still works until it expires', async () => {
    const { accessToken } = await signedInAdmin();
    const { sub, client_id } = new JwtService({}).verify(accessToken, { secret: SECRET, issuer: ISSUER });
    const legacy = new JwtService({}).sign({ sub, client_id }, { secret: SECRET, issuer: ISSUER, expiresIn: 3600 });
    expect((await me(legacy)).status).toBe(200);
  });
});
