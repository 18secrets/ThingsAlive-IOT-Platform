import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { PasswordService } from '../src/identity/services/password.service';
import { UserService } from '../src/identity/services/user.service';
import { ProvisioningService } from '../src/tenancy/services/provisioning.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Phone numbers: a real number, and one person's (dashboard testing, issue 1).
 *
 * Testing found a client could be created with any text as a mobile number, and two
 * people with the same one. Every test here tries the bad case and expects a refusal;
 * the database is tried directly too, because the next code path to write a phone
 * will not call these services.
 */
describeDb('phone numbers', () => {
  let ds: DataSource;
  let owner: DataSource;
  let users: UserService;
  let provisioning: ProvisioningService;

  const NOW = new Date('2026-10-13T09:00:00.000Z');
  const MIGRATION = 'PhoneUnclaimed1759700000000';
  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-chief', roles: ['ceo-manager'], isPlatformRole: false };
  const account = (tenantId: string, email: string, phone?: string) => ({
    tenantId, name: `${tenantId} Ltd`, superAdmin: { email, fullName: 'Chief Executive', phone },
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    users = new UserService(ds);
    provisioning = new ProvisioningService(ds, new PasswordService());
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'user_security_event', 'user_session', 'user_invitation', 'user_equipment_access',
      'user_plant_access', 'app_user', 'tenant_role', 'tenant_map', 'tenant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await provisioning.provision(master, account('acme', 'chief@acme.test', '+91 98765-49878'), NOW);
  });

  const phoneOf = async (email: string) =>
    (await owner.query(`SELECT phone FROM app_user WHERE email = $1`, [email]))[0]?.phone;

  it('stores a number one way, whatever spacing it was typed with', async () => {
    expect(await phoneOf('chief@acme.test')).toBe('+919876549878');
    await users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator', phone: '98450 12345' }, NOW);
    expect(await phoneOf('op@acme.test')).toBe('9845012345');
  });

  it('refuses something that is not a phone number', async () => {
    await expect(users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator', phone: '12345' }, NOW))
      .rejects.toThrow(BadRequestException);
    await expect(provisioning.provision(master, account('globex', 'boss@globex.test', 'call me'), NOW))
      .rejects.toThrow(BadRequestException);
    expect(await phoneOf('op@acme.test')).toBeUndefined();
  });

  it('refuses a number somebody else has, in any account and however it is spaced', async () => {
    await expect(provisioning.provision(master, account('globex', 'boss@globex.test', '+919876549878'), NOW))
      .rejects.toThrow(new ConflictException('+919876549878 already belongs to somebody else.'));
    await expect(users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator', phone: '+91 9876 549878' }, NOW))
      .rejects.toThrow(ConflictException);
    expect(Number((await owner.query(`SELECT count(*) AS n FROM tenant WHERE tenant_id = 'globex'`))[0].n)).toBe(0);
  });

  it("lets a super admin keep their own number, but not take somebody else's", async () => {
    await users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator', phone: '9845012345' }, NOW);
    await expect(provisioning.update(master, 'acme', { superAdmin: { phone: '+91 98765 49878' } })).resolves.toBeTruthy();
    await expect(provisioning.update(master, 'acme', { superAdmin: { phone: '98450-12345' } }))
      .rejects.toThrow(ConflictException);
    expect(await phoneOf('chief@acme.test')).toBe('+919876549878');
  });

  it('is refused by the database too, including against a number stored with spaces', async () => {
    await owner.query(`UPDATE app_user SET phone = '+91 98765 49878' WHERE email = 'chief@acme.test'`);
    await expect(owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, phone) VALUES ('acme', 'x@acme.test', 'X', 'operator', '+919876549878')`,
    )).rejects.toMatchObject({ code: '23505', constraint: 'uq_app_user_phone' });
  });

  it('makes the second of two overlapping writers wait for the first, then refuses it', async () => {
    const first = owner.createQueryRunner();
    const second = owner.createQueryRunner();
    try {
      await first.startTransaction();
      await first.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, phone) VALUES ('acme', 'a@acme.test', 'A', 'operator', '9000000001')`,
      );
      await second.startTransaction();
      const pending = second.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, phone) VALUES ('globex', 'b@globex.test', 'B', 'operator', '9000000001')`,
      ).then(() => 'committed', (e) => e);
      const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
      expect(early).toBe('waiting');
      await first.commitTransaction();
      expect(await pending).toMatchObject({ code: '23505', constraint: 'uq_app_user_phone' });
      await second.rollbackTransaction();
    } finally {
      await first.release();
      await second.release();
    }
  });

  describe('numbers that already repeat', () => {
    afterEach(async () => { await owner.runMigrations({ transaction: 'all' }); });

    it('applies over them and leaves them editable', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, phone) VALUES ('acme', 'twin@acme.test', 'Twin', 'operator', '+919876549878')`,
      );
      await owner.runMigrations({ transaction: 'all' });
      await owner.query(`UPDATE app_user SET full_name = 'Twin, renamed' WHERE email = 'twin@acme.test'`);
      expect(await phoneOf('twin@acme.test')).toBe('+919876549878');
    });
  });
});
