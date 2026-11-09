import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { ProvisioningService } from '../src/tenancy/services/provisioning.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'AccountTimeZone1764000000000';

/**
 * The account's time zone (test report MIN-12): set by staff, read by everybody in the
 * account through /me, and refused by the row itself when it is not a zone.
 */
describeDb('account time zone', () => {
  let owner: DataSource;
  let ds: DataSource;
  let provisioning: ProvisioningService;
  let credentials: CredentialService;

  const master: RequestScope = { tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const account = (tenantId: string, extra: Record<string, unknown> = {}) => ({
    tenantId, name: tenantId, superAdmin: { email: `chief@${tenantId}.test`, fullName: 'Chief' }, ...extra,
  });
  const zoneOf = async (tenantId: string) =>
    (await owner.query(`SELECT time_zone FROM tenant WHERE tenant_id = $1`, [tenantId]))[0]?.time_zone;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    const passwords = new PasswordService();
    provisioning = new ProvisioningService(ds, passwords);
    const config = { get: (key: string) => ({ AUTH_JWT_SECRET: 'test-secret', AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key] } as unknown as ConfigService;
    credentials = new CredentialService(ds, passwords, new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_security_event', 'domain_event', 'user_invitation', 'app_user', 'tenant_role', 'tenant_map', 'tenant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  it('an account provisioned without one is on Asia/Kolkata, where every plant on the platform is today', async () => {
    const { tenant } = await provisioning.provision(master, account('acme'));
    expect(tenant.timeZone).toBe('Asia/Kolkata');
    expect(await zoneOf('acme')).toBe('Asia/Kolkata');
  });

  it('an account provisioned with one keeps it', async () => {
    await provisioning.provision(master, account('londonco', { timeZone: 'Europe/London' }));
    expect(await zoneOf('londonco')).toBe('Europe/London');
  });

  it('a name that is not a zone is refused at provisioning, and nothing of the account is left behind', async () => {
    await expect(provisioning.provision(master, account('typo', { timeZone: 'Asia/Kolkatta' })))
      .rejects.toBeInstanceOf(BadRequestException);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM tenant WHERE tenant_id = 'typo'`);
    expect(n).toBe(0);
  });

  it('staff can change it, and a bad name on change leaves the old one in place', async () => {
    await provisioning.provision(master, account('acme'));
    const updated = await provisioning.update(master, 'acme', { timeZone: 'Asia/Dubai' });
    expect(updated.timeZone).toBe('Asia/Dubai');
    await expect(provisioning.update(master, 'acme', { timeZone: 'GMT+99' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await zoneOf('acme')).toBe('Asia/Dubai');
  });

  it('the database refuses a bad zone even when the service is not the writer', async () => {
    await provisioning.provision(master, account('acme'));
    await expect(owner.query(`UPDATE tenant SET time_zone = 'Mars/Olympus_Mons' WHERE tenant_id = 'acme'`))
      .rejects.toThrow(/ck_tenant_time_zone/);
  });

  it('everybody in the account reads it from their own identity (/me)', async () => {
    const { superAdmin } = await provisioning.provision(master, account('acme', { timeZone: 'Asia/Singapore' }));
    const me = await credentials.ownIdentity({ tenantId: 'acme', userId: superAdmin.id, roles: ['ceo-manager'], isPlatformRole: false });
    expect(me?.tenantTimeZone).toBe('Asia/Singapore');
  });

  it('an unused account with a time zone can still be deleted', async () => {
    await provisioning.provision(master, account('mistake', { timeZone: 'Europe/London' }));
    await provisioning.suspend(master, 'mistake', 'created by mistake');
    await provisioning.remove(master, 'mistake');
    expect(await zoneOf('mistake')).toBeUndefined();
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const col = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'tenant' AND column_name = 'time_zone'`);
    expect(col).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'tenant' AND column_name = 'time_zone'`);
    expect(back).toHaveLength(1);
  });
});
