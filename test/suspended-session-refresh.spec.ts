import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

/**
 * A reload after a suspension ends the session, and says why (tester bugs TC_136,
 * TC_137). Sign-in refused a suspended organisation; refresh did not, so a reload
 * renewed the tokens, the next call was refused, and the console sat on "Restoring
 * your session…" for good. Asserted over HTTP, the way a reload meets it: by
 * presenting the refresh token after the suspension and expecting the refusal.
 *
 * Also the name behind GET /me (TC_135): Session Diagnostics showed only the id.
 */
const SECRET = 'test-secret-suspended-session-refresh';
const ISSUER = 'things-alive-suspended-session-test';
const PASSWORD = 'Correct-Horse-1';

describeDb('a suspension ends the session at the next refresh (TC_136, TC_137)', () => {
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
  const refresh = (refreshToken: string) => http().post('/api/v1/auth/refresh').send({ refreshToken });
  const me = (accessToken: string) => http().get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);

  /** A fresh account and its super admin, signed in through the real invitation path. */
  let n = 0;
  const signedInAccount = async () => {
    n += 1;
    const tenantId = `suspend-${n}`;
    const provisioned = await asPlatform(http().post('/api/v1/accounts')).send({
      tenantId, name: `Suspend ${n}`, superAdmin: { email: `boss${n}@suspend.example`, fullName: `Boss ${n}` },
    });
    expect(provisioned.status).toBe(201);
    const accepted = await http().post('/api/v1/auth/accept-invitation')
      .send({ token: provisioned.body.invitationToken, password: PASSWORD });
    expect(accepted.status).toBe(201);
    return { tenantId, roles: provisioned.body.roles as string[], boss: accepted.body as Session, email: `boss${n}@suspend.example` };
  };

  it('TC_137: the organisation suspended, the next refresh is refused with the reason sign-in gives', async () => {
    const { tenantId, boss } = await signedInAccount();
    expect((await refresh(boss.refreshToken)).status).toBe(201);
    const current = (await http().post('/api/v1/auth/sign-in').send({ email: `boss${n}@suspend.example`, password: PASSWORD })).body as Session;

    expect((await asPlatform(http().post(`/api/v1/accounts/${tenantId}/suspend`)).send({ reason: 'unpaid' })).status).toBe(201);

    const refused = await refresh(current.refreshToken);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/organisation's account is suspended/);
  });

  it('TC_137: reinstating the organisation does not revive the sessions the suspension ended', async () => {
    const { tenantId, boss, email } = await signedInAccount();
    await asPlatform(http().post(`/api/v1/accounts/${tenantId}/suspend`)).send({ reason: 'unpaid' });
    expect((await refresh(boss.refreshToken)).status).toBe(401);

    expect((await asPlatform(http().post(`/api/v1/accounts/${tenantId}/reinstate`))).status).toBe(201);

    // The old refresh token stays dead; signing in again is the way back.
    expect((await refresh(boss.refreshToken)).status).toBe(401);
    expect((await http().post('/api/v1/auth/sign-in').send({ email, password: PASSWORD })).status).toBe(201);
  });

  it('TC_136: a person suspended by their administrator is refused at the next refresh, and told so', async () => {
    const { boss, roles } = await signedInAccount();
    const asBoss = (req: request.Test) => req.set('Authorization', `Bearer ${boss.accessToken}`);
    const invited = await asBoss(http().post('/api/v1/identity/users'))
      .send({ email: `operator${n}@suspend.example`, fullName: 'Operator', roleSlug: roles[roles.length - 1] });
    expect(invited.status).toBe(201);
    const operator = (await http().post('/api/v1/auth/accept-invitation')
      .send({ token: invited.body.invitationToken, password: PASSWORD })).body as Session;
    expect((await me(operator.accessToken)).status).toBe(200);

    expect((await asBoss(http().post(`/api/v1/identity/users/${invited.body.id}/suspend`)).send({ reason: 'left' })).status).toBe(201);

    const refused = await refresh(operator.refreshToken);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/has been suspended/);
    expect((await me(operator.accessToken)).status).toBe(401);
  });

  it('TC_136: a Things Alive staff member suspended from the Staff page is refused at the next refresh, and told so', async () => {
    const invited = await asPlatform(http().post('/api/v1/platform/staff'))
      .send({ email: 'support@suspend.example', fullName: 'Support Person', role: 'platform-support' });
    expect(invited.status).toBe(201);
    const staff = (await http().post('/api/v1/platform/auth/accept-invitation')
      .send({ token: invited.body.invitationToken, password: PASSWORD })).body as Session;
    expect((await me(staff.accessToken)).body).toMatchObject({ email: 'support@suspend.example', fullName: 'Support Person' });

    expect((await asPlatform(http().post(`/api/v1/platform/staff/${invited.body.id}/suspend`)).send({ reason: 'left' })).status).toBe(201);

    const refused = await refresh(staff.refreshToken);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/has been suspended/);
    expect((await me(staff.accessToken)).status).toBe(401);
  });

  it('a revoked session of an account that is not suspended still reads "sign in again"', async () => {
    const { boss } = await signedInAccount();
    await http().post('/api/v1/auth/sign-out').send({ refreshToken: boss.refreshToken });
    const refused = await refresh(boss.refreshToken);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toBe('Please sign in again.');
  });

  it('an active account in an active organisation still refreshes', async () => {
    const { boss } = await signedInAccount();
    const renewed = await refresh(boss.refreshToken);
    expect(renewed.status).toBe(201);
    expect((await me(renewed.body.accessToken)).status).toBe(200);
  });

  it('TC_135: GET /me names the person behind the token', async () => {
    const { boss, email } = await signedInAccount();
    const res = await me(boss.accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email, fullName: `Boss ${n}` });
  });

  it('TC_135: a token that names no account row reads as nulls, not a failure', async () => {
    const res = await me(platformToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: 'ops@things-alive.io', email: null, fullName: null });
  });
});
