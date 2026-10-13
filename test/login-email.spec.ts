import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { PlatformStaffService } from '../src/identity/services/platform-staff.service';
import { UserService } from '../src/identity/services/user.service';
import { ProvisioningService } from '../src/tenancy/services/provisioning.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * One email, one login, across client users and staff (dashboard testing, issues 1 and 2).
 *
 * The failure being prevented is quiet: a client user and a staff member on the same
 * address both get created without complaint, and from then on sign-in picks the staff
 * credential and the client user is told their password is wrong. Nothing here asserts
 * that a trigger exists. Every test creates the clash and expects it to be refused.
 */
describeDb('login email shared by client users and staff', () => {
  let ds: DataSource;
  let owner: DataSource;
  let provisioning: ProvisioningService;
  let users: UserService;
  let staff: PlatformStaffService;

  const NOW = new Date('2026-10-13T09:00:00.000Z');
  const MIGRATION = 'LoginEmailUnclaimed1759500000000';

  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const acmeAdmin: RequestScope = {
    tenantId: 'acme', userId: 'u-chief', roles: ['ceo-manager'], isPlatformRole: false,
  };
  const account = (tenantId: string, email: string) => ({
    tenantId, name: `${tenantId} Ltd`, superAdmin: { email, fullName: 'Chief Executive' },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const passwords = new PasswordService();
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: 'test-secret-for-signing' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    provisioning = new ProvisioningService(ds, passwords);
    users = new UserService(ds);
    staff = new PlatformStaffService(ds, new PlatformCredentialService(ds, passwords, new JwtService({}), config));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'user_security_event', 'user_session', 'user_invitation',
      'user_equipment_access', 'user_plant_access', 'app_user', 'tenant_role', 'tenant_map', 'tenant',
      'platform_invitation', 'platform_session', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await provisioning.provision(master, account('acme', 'chief@acme.test'), NOW);
  });

  const logins = async (email: string) => {
    const [{ n }] = await owner.query(
      `SELECT (SELECT count(*) FROM app_user WHERE email = $1) + (SELECT count(*) FROM platform_user WHERE email = $1) AS n`,
      [email],
    );
    return Number(n);
  };

  describe('the services refuse before writing', () => {
    it('will not invite staff on an address a client user signs in with', async () => {
      await expect(
        staff.invite({ email: 'chief@acme.test', fullName: 'Chief Again', role: 'master-admin' }, 'u-master', NOW),
      ).rejects.toThrow(new ConflictException('chief@acme.test already has a login.'));
      expect(await logins('chief@acme.test')).toBe(1);
    });

    it('will not provision an account whose administrator is already staff', async () => {
      await staff.invite({ email: 'unity@things-alive.io', fullName: 'Unity Staff', role: 'master-admin' }, 'x', NOW);
      await expect(provisioning.provision(master, account('unity', 'unity@things-alive.io'), NOW))
        .rejects.toThrow(ConflictException);
      expect(await logins('unity@things-alive.io')).toBe(1);
    });

    it('will not invite a client user on a staff address', async () => {
      await staff.invite({ email: 'ops@things-alive.io', fullName: 'Ops', role: 'platform-support' }, 'x', NOW);
      await expect(users.invite(acmeAdmin, { email: 'ops@things-alive.io', fullName: 'Ops', roleSlug: 'operator' }, NOW))
        .rejects.toThrow(new ConflictException('ops@things-alive.io already has a login.'));
      expect(await logins('ops@things-alive.io')).toBe(1);
    });

    it('will not move a super admin onto a staff address', async () => {
      await staff.invite({ email: 'ops@things-alive.io', fullName: 'Ops', role: 'platform-support' }, 'x', NOW);
      await expect(provisioning.update(master, 'acme', { superAdmin: { email: 'ops@things-alive.io' } }))
        .rejects.toThrow(ConflictException);
      const [admin] = await owner.query(`SELECT email FROM app_user WHERE tenant_id = 'acme'`);
      expect(admin.email).toBe('chief@acme.test');
    });
  });

  describe('the database refuses what gets past the services', () => {
    it('refuses a staff row on a client address', async () => {
      await expect(ds.query(
        `INSERT INTO platform_user (email, full_name, role) VALUES ('chief@acme.test', 'Direct', 'master-admin')`,
      )).rejects.toMatchObject({ code: '23505', constraint: 'uq_login_email' });
    });

    it('refuses a client row on a staff address, inserted or renamed into', async () => {
      await owner.query(
        `INSERT INTO platform_user (email, full_name, role) VALUES ('ops@things-alive.io', 'Ops', 'platform-support')`,
      );
      await expect(owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug) VALUES ('acme', 'ops@things-alive.io', 'Ops', 'operator')`,
      )).rejects.toMatchObject({ code: '23505', constraint: 'uq_login_email' });
      await expect(owner.query(
        `UPDATE app_user SET email = 'ops@things-alive.io' WHERE email = 'chief@acme.test'`,
      )).rejects.toMatchObject({ code: '23505', constraint: 'uq_login_email' });
    });

    it('makes the second of two overlapping writers wait for the first, then refuses it', async () => {
      // Without the lock both transactions check, both see nothing committed, and both
      // commit. Holding the first open proves the second really waits for it.
      const first = owner.createQueryRunner();
      const second = owner.createQueryRunner();
      try {
        await first.startTransaction();
        await first.query(
          `INSERT INTO platform_user (email, full_name, role) VALUES ('race@things-alive.io', 'First', 'master-admin')`,
        );
        await second.startTransaction();
        const pending = second.query(
          `INSERT INTO app_user (tenant_id, email, full_name, role_slug) VALUES ('acme', 'race@things-alive.io', 'Second', 'operator')`,
        ).then(() => 'committed', (e) => e);
        const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
        expect(early).toBe('waiting');

        await first.commitTransaction();
        expect(await pending).toMatchObject({ code: '23505', constraint: 'uq_login_email' });
        await second.rollbackTransaction();
      } finally {
        await first.release();
        await second.release();
      }
      expect(await logins('race@things-alive.io')).toBe(1);
    });

    it('lets exactly one of a client and a staff creation fired together through, and the other gets a 409', async () => {
      for (const n of [1, 2, 3]) {
        const email = `together-${n}@things-alive.io`;
        const results = await Promise.allSettled([
          provisioning.provision(master, account(`together-${n}`, email), NOW),
          staff.invite({ email, fullName: 'Together', role: 'master-admin' }, 'x', NOW),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const [refused] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(refused.reason).toBeInstanceOf(ConflictException);
        expect(await logins(email)).toBe(1);
      }
    });
  });

  describe('addresses that already clash', () => {
    afterEach(async () => {
      await owner.runMigrations({ transaction: 'all' });
    });

    it('applies over them, leaves them editable, and still refuses a new clash', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      await owner.query(
        `INSERT INTO platform_user (email, full_name, role) VALUES ('chief@acme.test', 'Old Twin', 'master-admin')`,
      );
      await owner.runMigrations({ transaction: 'all' });

      await owner.query(`UPDATE app_user SET status = 'suspended' WHERE email = 'chief@acme.test'`);
      await owner.query(`UPDATE platform_user SET full_name = 'Renamed Twin' WHERE email = 'chief@acme.test'`);
      expect(await logins('chief@acme.test')).toBe(2);

      await owner.query(
        `INSERT INTO platform_user (email, full_name, role) VALUES ('ops@things-alive.io', 'Ops', 'platform-support')`,
      );
      await expect(owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug) VALUES ('acme', 'ops@things-alive.io', 'Ops', 'operator')`,
      )).rejects.toMatchObject({ code: '23505', constraint: 'uq_login_email' });
    });

    it('stops refusing once rolled back', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      await owner.query(
        `INSERT INTO platform_user (email, full_name, role) VALUES ('chief@acme.test', 'Twin', 'master-admin')`,
      );
      expect(await logins('chief@acme.test')).toBe(2);
      await owner.query(`DELETE FROM platform_user WHERE email = 'chief@acme.test'`);
    });
  });
});
