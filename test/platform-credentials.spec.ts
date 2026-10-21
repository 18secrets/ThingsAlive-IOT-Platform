import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { PlatformSession } from '../src/identity/entities/platform-session.entity';
import { PlatformUser } from '../src/identity/entities/platform-user.entity';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { main as staffBootstrap } from '../src/database/seeds/staff-bootstrap';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Task QPA1 — the Things Alive login.
 *
 * Mirrors credentials.spec.ts (the tenant side) and platform-token.spec.ts (the
 * stateless bootstrap token, which this must not disturb). What matters most here is
 * the refusals: a wrong password, a lockout, a suspended account and a revoked
 * session all have to fail loudly, and the one credential nobody can revoke — the
 * CLI-minted bootstrap token — has to keep working exactly as it did before.
 */
const SECRET = 'test-secret-for-signing';

describeDb('platform staff sign-in', () => {
  let ds: DataSource;
  let owner: DataSource;
  let credentials: PlatformCredentialService;

  const NOW = new Date('2026-09-22T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';
  const EMAIL = 'staff@things-alive.io';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const config = {
      get: (key: string) => ({
        AUTH_JWT_SECRET: SECRET,
        AUTH_TENANT_CLAIM: 'client_id',
      } as Record<string, string>)[key],
    } as unknown as ConfigService;
    credentials = new PlatformCredentialService(ds, new PasswordService(), new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['platform_session', 'user_security_event', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  const createStaff = async (overrides: Partial<{ email: string; role: 'master-admin' }> = {}) =>
    credentials.create({
      email: overrides.email ?? EMAIL,
      fullName: 'Staff Person',
      role: overrides.role ?? 'master-admin',
      password: PASSWORD,
    });

  describe('signing in', () => {
    it('gives the same answer for a wrong password and an address nobody has', async () => {
      await createStaff();
      await expect(credentials.signIn(EMAIL, 'not the password', {}, NOW))
        .rejects.toThrow('Email or password is incorrect.');
      await expect(credentials.signIn('nobody@things-alive.io', PASSWORD, {}, NOW))
        .rejects.toThrow('Email or password is incorrect.');
    });

    it('locks after five failures, and a locked account refuses even the right password', async () => {
      await createStaff();
      for (let i = 0; i < 5; i += 1) {
        await expect(credentials.signIn(EMAIL, 'wrong', {}, NOW)).rejects.toThrow();
      }
      // The correct password now fails too — that is what a lockout is.
      await expect(credentials.signIn(EMAIL, PASSWORD, {}, NOW))
        .rejects.toThrow(/Try again in 15 minutes/);

      const later = new Date(NOW.getTime() + 16 * 60_000);
      await expect(credentials.signIn(EMAIL, PASSWORD, {}, later)).resolves.toBeTruthy();
    });

    it('forgets the failures once somebody gets in', async () => {
      await createStaff();
      await expect(credentials.signIn(EMAIL, 'wrong', {}, NOW)).rejects.toThrow();
      await expect(credentials.signIn(EMAIL, 'wrong again', {}, NOW)).rejects.toThrow();
      await credentials.signIn(EMAIL, PASSWORD, {}, NOW);
      const user = await owner.getRepository(PlatformUser).findOneByOrFail({ email: EMAIL });
      expect(user.failedAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });

    it('refuses a suspended account, even with the right password', async () => {
      const user = await createStaff();
      await owner.getRepository(PlatformUser).update(user.id, {
        status: 'suspended', suspendedAt: NOW, suspendedReason: 'left the company',
      });
      await expect(credentials.signIn(EMAIL, PASSWORD, {}, NOW)).rejects.toThrow(/suspended/);
    });
  });

  describe('staying signed in', () => {
    it('rotates the refresh token on every use', async () => {
      await createStaff();
      const first = await credentials.signIn(EMAIL, PASSWORD, {}, NOW);
      const second = await credentials.refresh(first.refreshToken, {}, NOW);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).toBeTruthy();
    });

    it('treats a reused refresh token as theft and revokes the whole family', async () => {
      await createStaff();
      const first = await credentials.signIn(EMAIL, PASSWORD, {}, NOW);
      const second = await credentials.refresh(first.refreshToken, {}, NOW);

      await expect(credentials.refresh(first.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
      await expect(credentials.refresh(second.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
    });

    it('ends every token from one sign-in when somebody signs out', async () => {
      await createStaff();
      const session = await credentials.signIn(EMAIL, PASSWORD, {}, NOW);
      await credentials.signOut(session.refreshToken, NOW);
      await expect(credentials.refresh(session.refreshToken, {}, NOW)).rejects.toThrow();
    });
  });

  describe('changing a password', () => {
    it('requires the current password, and signs every session out afterwards', async () => {
      await createStaff();
      const session = await credentials.signIn(EMAIL, PASSWORD, {}, NOW);

      await expect(credentials.changePassword(
        (await owner.getRepository(PlatformUser).findOneByOrFail({ email: EMAIL })).id,
        'wrong current password', 'A-Different-1', {}, NOW,
      )).rejects.toThrow(/incorrect/);

      const user = await owner.getRepository(PlatformUser).findOneByOrFail({ email: EMAIL });
      await credentials.changePassword(user.id, PASSWORD, 'A-Different-1', {}, NOW);

      // The session from before the change is dead.
      await expect(credentials.refresh(session.refreshToken, {}, NOW)).rejects.toThrow();
      // The new password works; the old one does not.
      await expect(credentials.signIn(EMAIL, PASSWORD, {}, NOW)).rejects.toThrow();
      await expect(credentials.signIn(EMAIL, 'A-Different-1', {}, NOW)).resolves.toBeTruthy();
    });
  });

  describe('bootstrapping the first account', () => {
    it('refuses a second run once any platform user exists', async () => {
      // staff-bootstrap.ts connects through the module-level `dataSource` singleton
      // (src/database/data-source.ts), which reads DB_* from process.env at import
      // time — the same env `npm run test:db` already exports for this file's own
      // connections, so it targets the same database.
      const first = await staffBootstrap([
        '--email', 'first@things-alive.io', '--name', 'First Admin', '--password', PASSWORD,
      ]);
      expect(first).toBe(0);

      const second = await staffBootstrap([
        '--email', 'second@things-alive.io', '--name', 'Second Admin', '--password', PASSWORD,
      ]);
      expect(second).toBe(1);

      const count = await owner.getRepository(PlatformUser).count();
      expect(count).toBe(1);
    });
  });

  describe('the guard, end to end', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = SECRET;
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      // Set explicitly rather than deleted: a developer's own .env (never committed)
      // may already define AUTH_JWT_ISSUER, and dotenv fills in only what is missing,
      // so deleting it here is not reliably undone. Setting it to a known value and
      // minting against the same value keeps this test independent of that file.
      process.env.AUTH_JWT_ISSUER = 'things-alive-platform-test';
      // DB_* is already set by the environment `npm run test:db` was invoked with
      // (see test/db.ts); `createApp` reads it fresh via `dataSourceOptions()`.
      app = await createApp({ database: true });
      await app.init();
    }, 30_000);

    afterAll(async () => { await app?.close(); });

    it('signs in over HTTP, and a revoked session refuses the still-live access token', async () => {
      await createStaff({ email: 'guard@things-alive.io' });

      const signIn = await request(app.getHttpServer())
        .post('/api/v1/platform/auth/sign-in')
        .send({ email: 'guard@things-alive.io', password: PASSWORD });
      expect(signIn.status).toBe(201);
      const { accessToken, refreshToken } = signIn.body;

      const ok = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.isPlatformRole).toBe(true);

      await request(app.getHttpServer())
        .post('/api/v1/platform/auth/sign-out')
        .send({ refreshToken });

      const refused = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(refused.status).toBe(401);
    });

    it('refuses a live access token the moment the account is suspended', async () => {
      const user = await createStaff({ email: 'suspend-me@things-alive.io' });

      const signIn = await request(app.getHttpServer())
        .post('/api/v1/platform/auth/sign-in')
        .send({ email: 'suspend-me@things-alive.io', password: PASSWORD });
      const { accessToken } = signIn.body;

      await owner.getRepository(PlatformUser).update(user.id, {
        status: 'suspended', suspendedAt: NOW, suspendedReason: 'left the company',
      });

      const refused = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(refused.status).toBe(401);
    });

    it('an account-less bootstrap token still passes the guard', async () => {
      const { token } = mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io' },
        { secret: SECRET, issuer: 'things-alive-platform-test' },
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.isPlatformRole).toBe(true);

      // No row exists for it and none is looked up: there is no platform_session with
      // this id at all, which is exactly the point.
      const noSuchSession = await owner.getRepository(PlatformSession).count();
      expect(noSuchSession).toBe(0);
    });
  });
});
