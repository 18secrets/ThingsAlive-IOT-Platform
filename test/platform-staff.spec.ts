import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { PlatformUser } from '../src/identity/entities/platform-user.entity';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { PlatformStaffService } from '../src/identity/services/platform-staff.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Task QPA2, part 1 — staff invitations and management.
 *
 * Mirrors platform-credentials.spec.ts (the login QPA1 already proved) and
 * identity.spec.ts (the invite pattern this borrows rather than reinvents). What
 * matters most: an invited staff member cannot sign in before accepting, an
 * invitation cannot be reused, and a suspended one is refused exactly like QPA1's
 * suspended-account tests already prove for a password alone.
 */
const SECRET = 'test-secret-for-signing';

describeDb('platform staff management', () => {
  let ds: DataSource;
  let owner: DataSource;
  let credentials: PlatformCredentialService;
  let staff: PlatformStaffService;

  const NOW = new Date('2026-09-24T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';

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
    staff = new PlatformStaffService(ds, credentials);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['platform_invitation', 'platform_session', 'user_security_event', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  describe('inviting', () => {
    it('creates an invited staff member with no password, and a token that accepts it', async () => {
      const invited = await staff.invite(
        { email: 'new-hire@things-alive.io', fullName: 'New Hire', role: 'catalog-author' }, 'inviter-id', NOW,
      );
      expect(invited.status).toBe('invited');

      const row = await owner.getRepository(PlatformUser).findOneByOrFail({ email: 'new-hire@things-alive.io' });
      expect(row.passwordHash).toBeNull();
      expect(row.invitedBy).toBe('inviter-id');

      const { token } = await credentials.issueInvitation(invited.id, 'inviter-id', NOW);
      expect(token).toBeTruthy();
    });

    it('refuses inviting an email that already has a platform credential', async () => {
      await staff.invite({ email: 'dup@things-alive.io', fullName: 'First', role: 'master-admin' }, 'x', NOW);
      await expect(
        staff.invite({ email: 'dup@things-alive.io', fullName: 'Second', role: 'master-admin' }, 'x', NOW),
      ).rejects.toThrow(/already has a platform credential/);
    });

    it('cannot sign in until the invitation is accepted', async () => {
      await staff.invite({ email: 'pending@things-alive.io', fullName: 'Pending', role: 'catalog-author' }, 'x', NOW);
      await expect(credentials.signIn('pending@things-alive.io', 'anything at all', {}, NOW)).rejects.toThrow();
    });
  });

  describe('accepting', () => {
    it('sets a password, activates the account, and signs in', async () => {
      const invited = await staff.invite(
        { email: 'accept-me@things-alive.io', fullName: 'Accept Me', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);

      const result = await credentials.acceptInvitation(token, PASSWORD, {}, NOW);
      expect(result.accessToken).toBeTruthy();

      const user = await owner.getRepository(PlatformUser).findOneByOrFail({ id: invited.id });
      expect(user.status).toBe('active');
      expect(user.passwordHash).toBeTruthy();
      expect(user.activatedAt).toEqual(NOW);

      // Now an ordinary sign-in works.
      await expect(credentials.signIn('accept-me@things-alive.io', PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });

    it('cannot be used twice', async () => {
      const invited = await staff.invite(
        { email: 'once-only@things-alive.io', fullName: 'Once Only', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);

      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);
      await expect(credentials.acceptInvitation(token, 'A-Different-1', {}, NOW))
        .rejects.toThrow(/no longer valid/);
    });

    it('refuses a missing or expired token with the same message a bad one gets', async () => {
      await expect(credentials.acceptInvitation('not-a-real-token', PASSWORD, {}, NOW))
        .rejects.toThrow(/no longer valid/);

      const invited = await staff.invite(
        { email: 'expired@things-alive.io', fullName: 'Expired', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);
      const fifteenDaysLater = new Date(NOW.getTime() + 15 * 86_400_000);
      await expect(credentials.acceptInvitation(token, PASSWORD, {}, fifteenDaysLater))
        .rejects.toThrow(/no longer valid/);
    });

    it('re-inviting retires the outstanding invitation, so only the newest token works', async () => {
      const invited = await staff.invite(
        { email: 're-invite@things-alive.io', fullName: 'Re Invite', role: 'catalog-author' }, 'x', NOW,
      );
      const first = await credentials.issueInvitation(invited.id, 'x', NOW);
      const second = await credentials.issueInvitation(invited.id, 'x', NOW);

      await expect(credentials.acceptInvitation(first.token, PASSWORD, {}, NOW)).rejects.toThrow(/no longer valid/);
      await expect(credentials.acceptInvitation(second.token, PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });
  });

  describe('role, suspend and reinstate', () => {
    it('changes a staff member\'s role', async () => {
      const invited = await staff.invite(
        { email: 'promote@things-alive.io', fullName: 'Promote', role: 'catalog-author' }, 'x', NOW,
      );
      const updated = await staff.setRole(invited.id, 'platform-support');
      expect(updated.role).toBe('platform-support');
    });

    it('a suspended platform user is refused, and reinstating lets them back in', async () => {
      const invited = await staff.invite(
        { email: 'suspend-invite@things-alive.io', fullName: 'Suspend Me', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);
      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);

      await staff.suspend(invited.id, 'left the company', NOW);
      await expect(credentials.signIn('suspend-invite@things-alive.io', PASSWORD, {}, NOW))
        .rejects.toThrow(/suspended/);

      await staff.reinstate(invited.id);
      await expect(credentials.signIn('suspend-invite@things-alive.io', PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });

    it('suspending revokes every live session', async () => {
      const invited = await staff.invite(
        { email: 'revoke-me@things-alive.io', fullName: 'Revoke Me', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);
      const session = await credentials.acceptInvitation(token, PASSWORD, {}, NOW);

      await staff.suspend(invited.id, 'left the company', NOW);
      await expect(credentials.refresh(session.refreshToken, {}, NOW)).rejects.toThrow();
    });

    it('reinstating somebody who never accepted goes back to invited, not active', async () => {
      const invited = await staff.invite(
        { email: 'never-accepted@things-alive.io', fullName: 'Never Accepted', role: 'catalog-author' }, 'x', NOW,
      );
      await staff.suspend(invited.id, 'changed my mind', NOW);
      const reinstated = await staff.reinstate(invited.id);
      expect(reinstated.status).toBe('invited');
    });

    it('requires a reason to suspend somebody', async () => {
      const invited = await staff.invite(
        { email: 'no-reason@things-alive.io', fullName: 'No Reason', role: 'catalog-author' }, 'x', NOW,
      );
      await expect(staff.suspend(invited.id, '')).rejects.toThrow(/reason is required/);
    });
  });

  describe('listing', () => {
    it('never returns the password hash', async () => {
      const invited = await staff.invite(
        { email: 'listed@things-alive.io', fullName: 'Listed', role: 'catalog-author' }, 'x', NOW,
      );
      const { token } = await credentials.issueInvitation(invited.id, 'x', NOW);
      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);

      const rows = await staff.list();
      const row = rows.find((r) => r.email === 'listed@things-alive.io')!;
      expect(row).toBeDefined();
      expect((row as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    });
  });

  describe('the migration', () => {
    it('has a down path that leaves platform_invitation and the invite columns behind', async () => {
      // The migration-capable connection, the same reason library-structure.spec.ts
      // and signal-binding.spec.ts run their down-path test against the owner
      // connection: `ta_app` (what `ds` connects as) has no grant on "migrations".
      const [{ count: before }] = await owner.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'platform_invitation'`,
      );
      expect(before).toBe(1);

      await undoMigrationNamed(owner, 'PlatformStaffInvitations1758000000000');

      const [{ count: after }] = await owner.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'platform_invitation'`,
      );
      expect(after).toBe(0);
      const [{ count: columnCount }] = await owner.query(
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'platform_user' AND column_name = 'invited_by'`,
      );
      expect(columnCount).toBe(0);

      await owner.runMigrations({ transaction: 'all' });
    });
  });

  describe('the endpoints, end to end', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = SECRET;
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      process.env.AUTH_JWT_ISSUER = 'things-alive-platform-test';
      app = await createApp({ database: true });
      await app.init();
    }, 30_000);

    afterAll(async () => { await app?.close(); });

    const bearer = (role: 'master-admin' | 'platform-support' | 'catalog-author') =>
      mintPlatformToken(
        { role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: 'things-alive-platform-test' },
      ).token;

    it('invites, accepts, and signs in over HTTP — master admin only can invite', async () => {
      const invite = await request(app.getHttpServer())
        .post('/api/v1/platform/staff')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .send({ email: 'http-invite@things-alive.io', fullName: 'HTTP Invite', role: 'catalog-author' });
      expect(invite.status).toBe(201);
      expect(invite.body.invitationToken).toBeTruthy();

      const accept = await request(app.getHttpServer())
        .post('/api/v1/platform/auth/accept-invitation')
        .send({ token: invite.body.invitationToken, password: PASSWORD });
      expect(accept.status).toBe(201);

      const signIn = await request(app.getHttpServer())
        .post('/api/v1/platform/auth/sign-in')
        .send({ email: 'http-invite@things-alive.io', password: PASSWORD });
      expect(signIn.status).toBe(201);
    });

    it('refuses a non-master-admin platform role on every staff route', async () => {
      for (const role of ['platform-support', 'catalog-author'] as const) {
        const list = await request(app.getHttpServer())
          .get('/api/v1/platform/staff')
          .set('Authorization', `Bearer ${bearer(role)}`);
        expect(list.status).toBe(403);

        const invite = await request(app.getHttpServer())
          .post('/api/v1/platform/staff')
          .set('Authorization', `Bearer ${bearer(role)}`)
          .send({ email: `blocked-${role}@things-alive.io`, fullName: 'Blocked', role: 'catalog-author' });
        expect(invite.status).toBe(403);
      }
    });

    it('lists every staff member with role and status', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/platform/staff')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .send({ email: 'listed-http@things-alive.io', fullName: 'Listed HTTP', role: 'platform-support' });

      const list = await request(app.getHttpServer())
        .get('/api/v1/platform/staff')
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(list.status).toBe(200);
      const row = list.body.find((r: { email: string }) => r.email === 'listed-http@things-alive.io');
      expect(row).toMatchObject({ role: 'platform-support', status: 'invited' });
    });

    it('suspends and reinstates over HTTP', async () => {
      const invite = await request(app.getHttpServer())
        .post('/api/v1/platform/staff')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .send({ email: 'http-suspend@things-alive.io', fullName: 'HTTP Suspend', role: 'catalog-author' });
      const id = invite.body.id;

      const suspend = await request(app.getHttpServer())
        .post(`/api/v1/platform/staff/${id}/suspend`)
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .send({ reason: 'left the company' });
      expect(suspend.status).toBe(201);
      expect(suspend.body.status).toBe('suspended');

      const reinstate = await request(app.getHttpServer())
        .post(`/api/v1/platform/staff/${id}/reinstate`)
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(reinstate.status).toBe(201);
      expect(reinstate.body.status).toBe('invited');
    });
  });
});
