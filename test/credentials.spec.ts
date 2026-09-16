import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, IsNull } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AppUser } from '../src/identity/entities/app-user.entity';
import { UserSecurityEvent } from '../src/identity/entities/user-security-event.entity';
import { UserSession } from '../src/identity/entities/user-session.entity';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { RoleService } from '../src/identity/services/role.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { UserService } from '../src/identity/services/user.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

describe('password policy', () => {
  const passwords = new PasswordService();

  it('requires one of each character class', () => {
    expect(() => passwords.assertAcceptable('alllowercase1!')).toThrow(/uppercase/);
    expect(() => passwords.assertAcceptable('ALLUPPERCASE1!')).toThrow(/lowercase/);
    expect(() => passwords.assertAcceptable('NoDigitsHere!')).toThrow(/number/);
    expect(() => passwords.assertAcceptable('NoSpecial123')).toThrow(/special character/);
    expect(() => passwords.assertAcceptable('Correct-Horse-1')).not.toThrow();
  });

  it('refuses the handful anybody tries first', () => {
    expect(() => passwords.assertAcceptable('Password1!')).toThrow(/first anybody tries/);
  });

  it('refuses a password containing the person\'s own address', () => {
    expect(() => passwords.assertAcceptable('Dana-loves-cats1', 'dana@acme.test'))
      .toThrow(/should not contain your own email/);
  });

  it('caps the length, which is not a strength rule', () => {
    // bcrypt ignores everything past 72 bytes, and an unbounded input is a cheap way
    // to make the server do work on request.
    expect(() => passwords.assertAcceptable('x'.repeat(500))).toThrow(/too long/);
  });

  it('treats a missing hash as "no password works", not "any password works"', () => {
    // The invited-user case. Every caller would otherwise have to remember it.
    expect(passwords.verify('anything', null)).toBe(false);
  });

  it('hashes differently every time, and verifies either way', () => {
    const a = passwords.hash('Correct-Horse-1');
    const b = passwords.hash('Correct-Horse-1');
    expect(a).not.toBe(b);
    expect(passwords.verify('Correct-Horse-1', a)).toBe(true);
    expect(passwords.verify('Correct-Horse-1', b)).toBe(true);
    expect(passwords.verify('wrong', a)).toBe(false);
  });
});

describeDb('credentials', () => {
  let ds: DataSource;
  let owner: DataSource;
  let users: UserService;
  let roles: RoleService;
  let credentials: CredentialService;
  let resolver: ScopeResolverService;

  const NOW = new Date('2026-09-13T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    users = new UserService(ds);
    roles = new RoleService(ds);
    resolver = new ScopeResolverService(ds);

    const config = {
      get: (key: string) => ({
        AUTH_JWT_SECRET: 'test-secret-for-signing',
        AUTH_TENANT_CLAIM: 'client_id',
      } as Record<string, string>)[key],
    } as unknown as ConfigService;
    credentials = new CredentialService(ds, new PasswordService(), new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  let userId: string;

  beforeEach(async () => {
    for (const t of ['user_security_event', 'user_session', 'user_invitation',
      'user_equipment_access', 'user_plant_access', 'app_user', 'tenant_role']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await roles.provisionDefaults('acme', 'u-master', NOW);
    const invited = await users.invite(
      boss, { email: 'dana@acme.test', fullName: 'Dana', roleSlug: 'operator' }, NOW,
    );
    userId = invited.id;
  });

  const accept = async (password = PASSWORD) => {
    const { token } = await credentials.issueInvitation(boss, userId, 'invite', NOW);
    return credentials.acceptInvitation(token, password, {}, NOW);
  };

  const events = () =>
    owner.getRepository(UserSecurityEvent).find({ order: { at: 'ASC' } });

  describe('accepting an invitation', () => {
    it('sets a password, activates the account and signs in', async () => {
      const result = await accept();
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.user.email).toBe('dana@acme.test');

      const user = await owner.getRepository(AppUser).findOneByOrFail({ id: userId });
      expect(user.status).toBe('active');
      expect(user.passwordHash).toBeTruthy();
      // Never the password itself, and never anything derived from it in plain form.
      expect(user.passwordHash).not.toContain(PASSWORD);
    });

    it('issues an access token the platform guard will accept', async () => {
      const { accessToken } = await accept();
      const payload = new JwtService({}).verify(accessToken, { secret: 'test-secret-for-signing' });
      expect(payload.sub).toBe(userId);
      expect(payload.client_id).toBe('acme');
      // Thin on purpose. The existing platform puts the whole user record in its
      // token, which is how a year-old token still describes somebody's job.
      expect(payload.roles).toBeUndefined();
      expect(payload.user).toBeUndefined();
      expect(payload.exp - payload.iat).toBe(3600);
    });

    it('burns the token, so a forwarded invitation email is useless twice', async () => {
      const { token } = await credentials.issueInvitation(boss, userId, 'invite', NOW);
      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);
      await expect(credentials.acceptInvitation(token, 'another password here', {}, NOW))
        .rejects.toThrow(/no longer valid/);
    });

    it('retires the previous invitation when a new one is sent', async () => {
      const first = await credentials.issueInvitation(boss, userId, 'invite', NOW);
      await credentials.issueInvitation(boss, userId, 'invite', NOW);
      // Re-sending because the first went astray is precisely an attempt to stop the
      // first one working.
      await expect(credentials.acceptInvitation(first.token, PASSWORD, {}, NOW))
        .rejects.toThrow(/no longer valid/);
    });

    it('refuses an expired one, and says the same thing as for a wrong one', async () => {
      const { token } = await credentials.issueInvitation(boss, userId, 'invite', NOW);
      const later = new Date(NOW.getTime() + 15 * 86_400_000);
      await expect(credentials.acceptInvitation(token, PASSWORD, {}, later))
        .rejects.toThrow(/no longer valid/);
      // Missing, consumed and expired are one message: which of the three it is tells
      // a guesser something and the rightful holder nothing they can act on.
      await expect(credentials.acceptInvitation('made-up-token', PASSWORD, {}, NOW))
        .rejects.toThrow(/no longer valid/);
    });

    it('applies the password policy at the point it is set', async () => {
      const { token } = await credentials.issueInvitation(boss, userId, 'invite', NOW);
      await expect(credentials.acceptInvitation(token, 'short', {}, NOW))
        .rejects.toThrow(BadRequestException);
      // And the token survives a rejected password, so the person can try again.
      await expect(credentials.acceptInvitation(token, PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });
  });

  describe('signing in', () => {
    beforeEach(async () => { await accept(); });

    it('gives the same answer for a wrong password and an address nobody has', async () => {
      const wrong = credentials.signIn('dana@acme.test', 'not the password', {}, NOW);
      const missing = credentials.signIn('nobody@acme.test', PASSWORD, {}, NOW);
      await expect(wrong).rejects.toThrow('Email or password is incorrect.');
      await expect(missing).rejects.toThrow('Email or password is incorrect.');
    });

    it('records the attempt for an address nobody has, which is the useful row', async () => {
      await expect(credentials.signIn('nobody@acme.test', PASSWORD, {}, NOW)).rejects.toThrow();
      const [row] = (await events()).filter((e) => e.emailAttempted === 'nobody@acme.test');
      expect(row.type).toBe('login.failed');
      // No tenant and no user: by definition there is no account to attribute it to,
      // and two hundred of these overnight is the thing worth seeing.
      expect(row.tenantId).toBeNull();
      expect(row.userId).toBeNull();
    });

    it('locks after five failures and says how long', async () => {
      for (let i = 0; i < 5; i += 1) {
        await expect(credentials.signIn('dana@acme.test', 'wrong', {}, NOW)).rejects.toThrow();
      }
      // The correct password now fails too — that is what a lockout is.
      await expect(credentials.signIn('dana@acme.test', PASSWORD, {}, NOW))
        .rejects.toThrow(/Try again in 15 minutes/);

      const later = new Date(NOW.getTime() + 16 * 60_000);
      await expect(credentials.signIn('dana@acme.test', PASSWORD, {}, later)).resolves.toBeTruthy();
    });

    it('forgets the failures once somebody gets in', async () => {
      await expect(credentials.signIn('dana@acme.test', 'wrong', {}, NOW)).rejects.toThrow();
      await credentials.signIn('dana@acme.test', PASSWORD, {}, NOW);
      const user = await owner.getRepository(AppUser).findOneByOrFail({ id: userId });
      expect(user.failedAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });

    it('tells a suspended person why, but only after the password is right', async () => {
      await users.suspend(boss, userId, 'left the company', NOW);
      // Wrong password first: this must not become a way to ask whether a suspended
      // account exists at an address.
      await expect(credentials.signIn('dana@acme.test', 'wrong', {}, NOW))
        .rejects.toThrow('Email or password is incorrect.');
      await expect(credentials.signIn('dana@acme.test', PASSWORD, {}, NOW))
        .rejects.toThrow(/suspended/);
    });

    it('refuses somebody who has never accepted their invitation', async () => {
      const other = await users.invite(
        boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'operator' }, NOW,
      );
      expect(other.passwordHash).toBeNull();
      await expect(credentials.signIn('sam@acme.test', PASSWORD, {}, NOW))
        .rejects.toThrow('Email or password is incorrect.');
    });
  });

  describe('staying signed in', () => {
    it('rotates the refresh token on every use', async () => {
      const first = await accept();
      const second = await credentials.refresh(first.refreshToken, {}, NOW);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).toBeTruthy();
    });

    it('treats a reused token as theft and revokes the whole family', async () => {
      const first = await accept();
      const second = await credentials.refresh(first.refreshToken, {}, NOW);

      // The rightful holder has `second`. Anybody presenting `first` has a copy.
      await expect(credentials.refresh(first.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
      // Both are now dead: the thief is out, and the victim signs in again. That is
      // the trade, and it is the only moment a stolen refresh token is detectable.
      await expect(credentials.refresh(second.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);

      expect((await events()).some((e) => e.type === 'session.reuse-detected')).toBe(true);
    });

    it('ends every token from one sign-in when somebody signs out', async () => {
      const session = await accept();
      const refreshed = await credentials.refresh(session.refreshToken, {}, NOW);
      await credentials.signOut(refreshed.refreshToken, NOW);
      await expect(credentials.refresh(refreshed.refreshToken, {}, NOW)).rejects.toThrow();
    });

    it('closes every way back in when somebody is suspended', async () => {
      const session = await accept();
      await users.suspend(boss, userId, 'left the company', NOW);

      await expect(credentials.refresh(session.refreshToken, {}, NOW)).rejects.toThrow();
      // And the access token they still hold stops working at the guard, because
      // scope is resolved per request rather than trusted from the token.
      await expect(resolver.resolve('acme', userId)).rejects.toThrow(UnauthorizedException);

      const live = await owner.getRepository(UserSession).count({ where: { userId, revokedAt: IsNull() } });
      expect(live).toBe(0);
    });

    it('ends every session when a password is set', async () => {
      const session = await accept();
      const { token } = await credentials.issueInvitation(boss, userId, 'reset', NOW);
      await credentials.acceptInvitation(token, 'A-Different-1', {}, NOW);
      // Setting a password is what somebody does when they think one is compromised.
      // Leaving old sessions alive would make the act useless in exactly that case.
      await expect(credentials.refresh(session.refreshToken, {}, NOW)).rejects.toThrow();
    });
  });

  describe('forgetting a password', () => {
    beforeEach(async () => { await accept(); });

    it('answers identically whether or not the address exists', async () => {
      const known = await credentials.requestReset('dana@acme.test', {}, NOW);
      const unknown = await credentials.requestReset('nobody@acme.test', {}, NOW);
      // A token for one, nothing for the other — and the route returns neither, so
      // the two are indistinguishable from outside.
      expect(known.token).toBeTruthy();
      expect(unknown.token).toBeUndefined();
    });

    it('expires in hours rather than the fortnight an invitation gets', async () => {
      const { token } = await credentials.requestReset('dana@acme.test', {}, NOW);
      const later = new Date(NOW.getTime() + 3 * 3_600_000);
      await expect(credentials.acceptInvitation(token!, 'a different long password', {}, later))
        .rejects.toThrow(/no longer valid/);
    });

    it('will not help somebody who has been suspended', async () => {
      await users.suspend(boss, userId, 'left the company', NOW);
      expect((await credentials.requestReset('dana@acme.test', {}, NOW)).token).toBeUndefined();
    });
  });
});
