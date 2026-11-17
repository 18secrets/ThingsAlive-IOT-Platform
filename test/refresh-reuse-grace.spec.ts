import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { REFRESH_REUSE_GRACE_MS } from '../src/identity/refresh-grace';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A just-rotated refresh token presented again by the same holder (test report MAJ-5,
 * "signed out after a few reloads"; grace approved 9 Nov 2026). On Development, 90 of
 * 239 "reuse detected" sign-outs came under two seconds after the same person's
 * successful refresh: two refreshes sent together as a page loads, or a reload that
 * unloaded before the new token was saved. Inside the minute, the old token gets a token
 * of its own in the same sign-in; past it, reuse is theft as before.
 */
describeDb('refresh tokens: the reuse grace', () => {
  let owner: DataSource;
  let ds: DataSource;
  let clients: CredentialService;
  let staff: PlatformCredentialService;

  const NOW = new Date('2026-11-09T09:00:00.000Z');
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const PASSWORD = 'Correct-Horse-1';
  const CLIENT = 'dana@acme.test';
  const STAFF = 'staff@things-alive.io';
  const reuseEvents = () => owner.query(`SELECT count(*)::int AS n FROM user_security_event WHERE type = 'session.reuse-detected'`)
    .then((r: { n: number }[]) => r[0].n);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: 'test-secret-for-signing', AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    clients = new CredentialService(ds, new PasswordService(), new JwtService({}), config);
    staff = new PlatformCredentialService(ds, new PasswordService(), new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_session', 'platform_session', 'user_security_event', 'app_user', 'platform_user', 'tenant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.query(`INSERT INTO tenant (tenant_id, name, status) VALUES ('acme', 'Acme', 'active')`);
    await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, password_hash) VALUES ('acme', $1, 'Dana', 'operator', 'active', $2)`,
      [CLIENT, new PasswordService().hash(PASSWORD, CLIENT)]);
    await staff.create({ email: STAFF, fullName: 'Staff Person', role: 'master-admin', password: PASSWORD });
  });

  describe('an account user', () => {
    it('two refreshes sent together with one token both succeed, and nobody is signed out', async () => {
      const first = await clients.signIn(CLIENT, PASSWORD, {}, NOW);
      const results = await Promise.allSettled([
        clients.refresh(first.refreshToken, {}, at(200)), clients.refresh(first.refreshToken, {}, at(300)),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // Each holder's new token still works, so neither tab is thrown out.
      for (const r of results) {
        await expect(clients.refresh((r as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken, {}, at(5_000))).resolves.toBeTruthy();
      }
      expect(await reuseEvents()).toBe(0);
    });

    it('a reload that lost the new token can present the old one within the minute', async () => {
      const first = await clients.signIn(CLIENT, PASSWORD, {}, NOW);
      await clients.refresh(first.refreshToken, {}, at(1_000));
      await expect(clients.refresh(first.refreshToken, {}, at(1_000 + REFRESH_REUSE_GRACE_MS - 1_000))).resolves.toBeTruthy();
      expect(await reuseEvents()).toBe(0);
    });

    it('the minute counts from the first rotation, not from the latest reuse', async () => {
      const first = await clients.signIn(CLIENT, PASSWORD, {}, NOW);
      await clients.refresh(first.refreshToken, {}, at(0));
      await clients.refresh(first.refreshToken, {}, at(50_000));
      // 70 s after it was first rotated: a copy, however recently it was last graced.
      await expect(clients.refresh(first.refreshToken, {}, at(70_000))).rejects.toThrow(UnauthorizedException);
      expect(await reuseEvents()).toBe(1);
    });

    it('a signed-out token gets no grace, however recent', async () => {
      const first = await clients.signIn(CLIENT, PASSWORD, {}, NOW);
      const second = await clients.refresh(first.refreshToken, {}, at(1_000));
      await clients.signOut(second.refreshToken, at(2_000));
      await expect(clients.refresh(first.refreshToken, {}, at(3_000))).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('staff', () => {
    it('two refreshes sent together with one token both succeed', async () => {
      const first = await staff.signIn(STAFF, PASSWORD, {}, NOW);
      const results = await Promise.allSettled([
        staff.refresh(first.refreshToken, {}, at(200)), staff.refresh(first.refreshToken, {}, at(300)),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    });

    it('past the minute, reuse is theft and the whole sign-in goes', async () => {
      const first = await staff.signIn(STAFF, PASSWORD, {}, NOW);
      const second = await staff.refresh(first.refreshToken, {}, at(0));
      await expect(staff.refresh(first.refreshToken, {}, at(REFRESH_REUSE_GRACE_MS + 1_000))).rejects.toThrow(UnauthorizedException);
      await expect(staff.refresh(second.refreshToken, {}, at(REFRESH_REUSE_GRACE_MS + 2_000))).rejects.toThrow(UnauthorizedException);
    });
  });
});
