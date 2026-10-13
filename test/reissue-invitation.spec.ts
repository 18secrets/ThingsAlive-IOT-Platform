import { BadRequestException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { AppUser } from '../src/identity/entities/app-user.entity';
import { TenantRole } from '../src/identity/entities/tenant-role.entity';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { PlatformStaffService } from '../src/identity/services/platform-staff.service';
import { UserService } from '../src/identity/services/user.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A new invitation for somebody who lost theirs (dashboard testing, issue 4).
 *
 * Before this, a lost token meant a new account, and the person's real email was
 * already taken by the abandoned one. What has to hold: the new link works, the old
 * one stops working, nobody who has set a password can be handed a link that would
 * reset it, and two re-sends at once leave exactly one live link.
 */
const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';

describeDb('re-sending a lost invitation', () => {
  let ds: DataSource;
  let owner: DataSource;
  let platformCredentials: PlatformCredentialService;
  let staff: PlatformStaffService;
  let credentials: CredentialService;
  let users: UserService;

  const NOW = new Date('2026-10-13T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';
  const TENANT = 'acme';
  const manager: RequestScope = {
    tenantId: TENANT, userId: 'u-manager', roles: ['people-manager'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const passwords = new PasswordService();
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: SECRET, AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    platformCredentials = new PlatformCredentialService(ds, passwords, new JwtService({}), config);
    staff = new PlatformStaffService(ds, platformCredentials);
    credentials = new CredentialService(ds, passwords, new JwtService({}), config);
    users = new UserService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_security_event', 'user_session', 'user_invitation', 'user_equipment_access',
      'user_plant_access', 'app_user', 'tenant_role', 'platform_invitation', 'platform_session', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(TenantRole).save(owner.getRepository(TenantRole).create({
      tenantId: TENANT, slug: 'people-manager', name: 'People Manager',
      capabilities: ['user.manage'], scopeShape: 'tenant',
    }));
    await owner.getRepository(TenantRole).save(owner.getRepository(TenantRole).create({
      tenantId: TENANT, slug: 'operator', name: 'Operator', capabilities: [], scopeShape: 'tenant',
    }));
  });

  const liveStaffLinks = async (email: string) => Number((await owner.query(
    `SELECT count(*) AS n FROM platform_invitation i JOIN platform_user u ON u.id = i.platform_user_id
      WHERE u.email = $1 AND i.consumed_at IS NULL`, [email]))[0].n);
  const liveClientLinks = async (email: string) => Number((await owner.query(
    `SELECT count(*) AS n FROM user_invitation i JOIN app_user u ON u.id = i.user_id
      WHERE u.email = $1 AND i.consumed_at IS NULL AND i.purpose = 'invite'`, [email]))[0].n);

  /**
   * Holds one re-send half done, the way the service does it: the person's row locked
   * and a new link inserted, not yet committed. The second re-send must queue behind
   * it and then retire that link. Firing two calls together rarely lands in this
   * window, so the window is held open on purpose.
   */
  const whileAnotherResendIsOpen = async (
    lockAndInsert: (q: import('typeorm').QueryRunner) => Promise<void>,
    resend: () => Promise<unknown>,
  ) => {
    const held = owner.createQueryRunner();
    try {
      await held.startTransaction();
      await lockAndInsert(held);
      const pending = resend().then(() => 'done', (e) => e);
      const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
      expect(early).toBe('waiting');
      await held.commitTransaction();
      expect(await pending).toBe('done');
    } finally {
      await held.release();
    }
  };

  describe('staff', () => {
    const inviteStaff = async (email: string) => {
      const user = await staff.invite({ email, fullName: 'Lost Token', role: 'platform-support' }, 'u-master', NOW);
      const first = await platformCredentials.issueInvitation(user.id, 'u-master', NOW);
      return { user, first };
    };

    it('issues a link that works and retires the lost one', async () => {
      const { user, first } = await inviteStaff('sbi@things-alive.io');
      const again = await platformCredentials.reissueInvitation(user.id, 'u-master', NOW);
      expect(again.email).toBe('sbi@things-alive.io');

      await expect(platformCredentials.acceptInvitation(first.token, PASSWORD, {}, NOW))
        .rejects.toThrow(UnauthorizedException);
      await expect(platformCredentials.acceptInvitation(again.token, PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });

    it('refuses once a password is set, and while suspended', async () => {
      const { user, first } = await inviteStaff('done@things-alive.io');
      await platformCredentials.acceptInvitation(first.token, PASSWORD, {}, NOW);
      await expect(platformCredentials.reissueInvitation(user.id, 'u-master', NOW))
        .rejects.toThrow(new BadRequestException('done@things-alive.io has already set a password. A new invitation cannot replace it.'));

      const { user: parked } = await inviteStaff('parked@things-alive.io');
      await staff.suspend(parked.id, 'left before starting');
      await expect(platformCredentials.reissueInvitation(parked.id, 'u-master', NOW))
        .rejects.toThrow(/is suspended\. Reinstate them/);
      expect(await liveStaffLinks('done@things-alive.io')).toBe(0);
    });

    it('leaves exactly one live link when two re-sends are fired together', async () => {
      const { user } = await inviteStaff('twice@things-alive.io');
      const results = await Promise.allSettled([
        platformCredentials.reissueInvitation(user.id, 'u-master', NOW),
        platformCredentials.reissueInvitation(user.id, 'u-master', NOW),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await liveStaffLinks('twice@things-alive.io')).toBe(1);
    });

    it('queues behind a re-send already in progress and retires its link', async () => {
      const { user } = await inviteStaff('queued@things-alive.io');
      await whileAnotherResendIsOpen(async (q) => {
        await q.query(`SELECT id FROM platform_user WHERE id = $1 FOR UPDATE`, [user.id]);
        await q.query(`UPDATE platform_invitation SET consumed_at = now() WHERE platform_user_id = $1 AND consumed_at IS NULL`, [user.id]);
        await q.query(
          `INSERT INTO platform_invitation (platform_user_id, token_hash, expires_at, created_by)
            VALUES ($1, 'held-open', now() + interval '1 day', 'other-admin')`, [user.id]);
      }, () => platformCredentials.reissueInvitation(user.id, 'u-master', NOW));
      expect(await liveStaffLinks('queued@things-alive.io')).toBe(1);
    });
  });

  describe('client users', () => {
    const inviteClient = async (email: string) => {
      const user = await users.invite(manager, { email, fullName: 'Lost Token', roleSlug: 'operator' }, NOW);
      const first = await credentials.issueInvitation(manager, user.id, 'invite', NOW);
      return { user, first };
    };

    it('issues a link that works and retires the lost one', async () => {
      const { user, first } = await inviteClient('op@acme.test');
      const again = await credentials.reissueInvitation(manager, user.id, NOW);
      expect(again.email).toBe('op@acme.test');

      await expect(credentials.acceptInvitation(first.token, PASSWORD, {}, NOW)).rejects.toThrow();
      await expect(credentials.acceptInvitation(again.token, PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });

    it('refuses once a password is set, and while suspended', async () => {
      const { user, first } = await inviteClient('done@acme.test');
      await credentials.acceptInvitation(first.token, PASSWORD, {}, NOW);
      await expect(credentials.reissueInvitation(manager, user.id, NOW))
        .rejects.toThrow(/already set a password\. They need "forgot password" instead/);

      const { user: parked } = await inviteClient('parked@acme.test');
      await users.suspend(manager, parked.id, 'left before starting');
      await expect(credentials.reissueInvitation(manager, parked.id, NOW)).rejects.toThrow(/is suspended/);
    });

    it('cannot re-send for somebody in another account', async () => {
      const { user } = await inviteClient('mine@acme.test');
      const stranger: RequestScope = { ...manager, tenantId: 'globex' };
      await expect(credentials.reissueInvitation(stranger, user.id, NOW)).rejects.toThrow(/No such person/);
      expect(await liveClientLinks('mine@acme.test')).toBe(1);
    });

    it('leaves exactly one live link when two re-sends are fired together', async () => {
      const { user } = await inviteClient('twice@acme.test');
      const results = await Promise.allSettled([
        credentials.reissueInvitation(manager, user.id, NOW),
        credentials.reissueInvitation(manager, user.id, NOW),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await liveClientLinks('twice@acme.test')).toBe(1);
    });

    it('queues behind a re-send already in progress and retires its link', async () => {
      const { user } = await inviteClient('queued@acme.test');
      await whileAnotherResendIsOpen(async (q) => {
        await q.query(`SELECT id FROM app_user WHERE id = $1 FOR UPDATE`, [user.id]);
        await q.query(`UPDATE user_invitation SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);
        await q.query(
          `INSERT INTO user_invitation (tenant_id, user_id, token_hash, purpose, expires_at, created_by)
            VALUES ($1, $2, 'held-open', 'invite', now() + interval '1 day', 'other-manager')`, [TENANT, user.id]);
      }, () => credentials.reissueInvitation(manager, user.id, NOW));
      expect(await liveClientLinks('queued@acme.test')).toBe(1);
    });
  });

  describe('over HTTP', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = SECRET;
      process.env.AUTH_JWT_ISSUER = ISSUER;
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      app = await createApp({ database: true });
      await app.init();
    }, 30_000);

    afterAll(async () => { await app?.close(); });

    const platformBearer = (role: 'master-admin' | 'platform-support') =>
      mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token;

    it('re-sends a staff invitation for master admin only', async () => {
      const user = await staff.invite({ email: 'http@things-alive.io', fullName: 'HTTP', role: 'catalog-author' }, 'x', NOW);

      const refused = await request(app.getHttpServer())
        .post(`/api/v1/platform/staff/${user.id}/resend-invitation`)
        .set('Authorization', `Bearer ${platformBearer('platform-support')}`);
      expect(refused.status).toBe(403);

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/platform/staff/${user.id}/resend-invitation`)
        .set('Authorization', `Bearer ${platformBearer('master-admin')}`);
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({ email: 'http@things-alive.io' });
      expect(sent.body.invitationToken).toBeTruthy();
    });

    it('re-sends a client user invitation inside the account', async () => {
      const managerRow = await owner.getRepository(AppUser).save(owner.getRepository(AppUser).create({
        tenantId: TENANT, email: 'manager@acme.test', fullName: 'Manager', roleSlug: 'people-manager',
        status: 'active', passwordHash: 'irrelevant-for-this-test',
      }));
      const token = await app.get(JwtService).signAsync(
        { sub: managerRow.id, client_id: TENANT }, { secret: SECRET, issuer: ISSUER },
      );
      const invited = await users.invite(manager, { email: 'http@acme.test', fullName: 'HTTP', roleSlug: 'operator' }, NOW);

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/identity/users/${invited.id}/resend-invitation`)
        .set('Authorization', `Bearer ${token}`);
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({ email: 'http@acme.test' });
      expect(sent.body.invitationToken).toBeTruthy();
    });
  });
});
