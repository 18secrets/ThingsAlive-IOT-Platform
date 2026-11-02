import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, IsNull } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { UserSecurityEvent } from '../src/identity/entities/user-security-event.entity';
import { UserSession } from '../src/identity/entities/user-session.entity';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { RoleService } from '../src/identity/services/role.service';
import { UserService } from '../src/identity/services/user.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A second browser tab in the same sign-in (test report MAJ-5).
 *
 * Sessions are per tab, and a tab cannot borrow another's refresh token: tokens
 * rotate, so whichever tab refreshed second would present a retired token and reuse
 * detection would throw both out. A fork is a second row in the same family — its own
 * token to rotate, the same sign-in to end. These tests attempt each way that could
 * go wrong and expect the service to refuse it.
 */
describeDb('session fork', () => {
  let ds: DataSource;
  let owner: DataSource;
  let users: UserService;
  let credentials: CredentialService;

  const NOW = new Date('2026-10-30T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';
  const SECRET = 'test-secret-for-signing';
  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    users = new UserService(ds);
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: SECRET, AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    credentials = new CredentialService(ds, new PasswordService(), new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  let userId: string;
  let dana: RequestScope;

  beforeEach(async () => {
    for (const t of ['user_security_event', 'user_session', 'user_invitation',
      'user_equipment_access', 'user_plant_access', 'app_user', 'tenant_role']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await new RoleService(ds).provisionDefaults('acme', 'u-master', NOW);
    userId = (await users.invite(boss, { email: 'dana@acme.test', fullName: 'Dana', roleSlug: 'operator' }, NOW)).id;
    dana = { tenantId: 'acme', userId, roles: ['operator'], isPlatformRole: false };
  });

  const signIn = async () => {
    const { token } = await credentials.issueInvitation(boss, userId, 'invite', NOW);
    return credentials.acceptInvitation(token, PASSWORD, {}, NOW);
  };
  const sidOf = (accessToken: string) => new JwtService({}).verify(accessToken, { secret: SECRET }).sid as string;

  it('gives the new tab its own refresh token in the same sign-in, and both tabs refresh without tripping reuse detection', async () => {
    const tabA = await signIn();
    const tabB = await credentials.forkSession(dana, tabA.accessToken, {}, NOW);
    expect(tabB.refreshToken).not.toBe(tabA.refreshToken);
    expect(sidOf(tabB.accessToken)).toBe(sidOf(tabA.accessToken));

    const [a, b] = await Promise.allSettled([
      credentials.refresh(tabA.refreshToken, {}, NOW), credentials.refresh(tabB.refreshToken, {}, NOW),
    ]);
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const events = await owner.getRepository(UserSecurityEvent).find();
    expect(events.some((e) => e.type === 'session.reuse-detected')).toBe(false);
    expect(events.filter((e) => e.type === 'session.forked')).toHaveLength(1);
  });

  it('signing out in either tab ends the other: one sign-in, however many tabs', async () => {
    const tabA = await signIn();
    const tabB = await credentials.forkSession(dana, tabA.accessToken, {}, NOW);
    await credentials.signOut(tabB.refreshToken, NOW);
    await expect(credentials.refresh(tabA.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
  });

  it('a token reused in one tab revokes every tab, as it would with one', async () => {
    const tabA = await signIn();
    const tabB = await credentials.forkSession(dana, tabA.accessToken, {}, NOW);
    await credentials.refresh(tabA.refreshToken, {}, NOW);
    await expect(credentials.refresh(tabA.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
    await expect(credentials.refresh(tabB.refreshToken, {}, NOW)).rejects.toThrow(UnauthorizedException);
  });

  it('does not outlive the sign-in it came from: a fork expires with the row it was forked from', async () => {
    const tabA = await signIn();
    const later = new Date(NOW.getTime() + 10 * 86_400_000);
    await credentials.forkSession(dana, tabA.accessToken, {}, later);
    const rows = await owner.getRepository(UserSession).find({ where: { userId, revokedAt: IsNull(), rotatedAt: IsNull() } });
    expect(new Set(rows.map((r) => r.expiresAt.getTime())).size).toBe(1);
  });

  it('refuses to fork a sign-in that has ended, a staff token, and a token naming no sign-in', async () => {
    const tabA = await signIn();
    await credentials.signOut(tabA.refreshToken, NOW);
    await expect(credentials.forkSession(dana, tabA.accessToken, {}, NOW)).rejects.toThrow(UnauthorizedException);

    await expect(credentials.forkSession({ ...dana, isPlatformRole: true }, tabA.accessToken, {}, NOW))
      .rejects.toThrow(BadRequestException);

    const noSid = new JwtService({}).sign({ sub: userId, client_id: 'acme' }, { secret: SECRET });
    await expect(credentials.forkSession(dana, noSid, {}, NOW)).rejects.toThrow(UnauthorizedException);
    // A token's sign-in belongs to its own user: Sam's scope cannot fork Dana's.
    const sam = await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'operator' }, NOW);
    const danaAgain = await signIn();
    await expect(credentials.forkSession({ ...dana, userId: sam.id }, danaAgain.accessToken, {}, NOW))
      .rejects.toThrow(UnauthorizedException);
  });
});
