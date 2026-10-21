import {
  BadRequestException, ConflictException, INestApplication, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { PlatformStaffService } from '../src/identity/services/platform-staff.service';
import { UserService } from '../src/identity/services/user.service';
import { ProvisioningService } from '../src/tenancy/services/provisioning.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Deleting what testing left behind (dashboard testing, issue 6).
 *
 * Every delete here can destroy something real if it reaches the wrong row, so each
 * one is tested by trying the forbidden case and expecting a refusal: a tool mapping
 * a device still uses, a person who has signed in, an account's only super admin,
 * an account that has been used. The application role cannot delete these rows except
 * through the guarded functions, and that is tested too, because the next code path
 * to delete a row will not call these services.
 */
const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';

describeDb('deleting what was never used', () => {
  let ds: DataSource;
  let owner: DataSource;
  let catalog: DeviceCatalogService;
  let staff: PlatformStaffService;
  let platformCredentials: PlatformCredentialService;
  let users: UserService;
  let credentials: CredentialService;
  let provisioning: ProvisioningService;

  const NOW = new Date('2026-10-13T09:00:00.000Z');
  const PASSWORD = 'Correct-Horse-1';
  const MIGRATION = 'DeleteGuards1759600000000';
  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-chief', roles: ['ceo-manager'], isPlatformRole: false };
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
      get: (key: string) => ({ AUTH_JWT_SECRET: SECRET, AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    platformCredentials = new PlatformCredentialService(ds, passwords, new JwtService({}), config);
    staff = new PlatformStaffService(ds, platformCredentials);
    credentials = new CredentialService(ds, passwords, new JwtService({}), config);
    users = new UserService(ds);
    provisioning = new ProvisioningService(ds, passwords);
    catalog = new DeviceCatalogService(ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'user_security_event', 'user_session', 'user_invitation', 'user_equipment_access',
      'user_plant_access', 'app_user', 'tenant_role', 'tenant_parameter', 'tenant_map', 'plant', 'tenant',
      'platform_invitation', 'platform_session', 'platform_user', 'device_inventory', 'tool_mapping']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await provisioning.provision(master, account('acme', 'chief@acme.test'), NOW);
  });

  const count = async (sql: string, params: unknown[] = []) => Number((await owner.query(sql, params))[0].n);

  describe('tool mappings', () => {
    const mapping = async () => (await owner.query(
      `INSERT INTO tool_mapping (tool_name) VALUES ('Excavator kit') RETURNING id`))[0].id as string;

    it('deletes one no device uses', async () => {
      const id = await mapping();
      await catalog.deleteToolMapping(id);
      expect(await count(`SELECT count(*) AS n FROM tool_mapping`)).toBe(0);
      await expect(catalog.deleteToolMapping(id)).rejects.toThrow(NotFoundException);
    });

    it('refuses while a device uses it, and leaves the device assigned', async () => {
      const id = await mapping();
      await owner.query(`INSERT INTO device_inventory (imei, tool_mapping_id) VALUES ('861000000000001', $1)`, [id]);

      await expect(catalog.deleteToolMapping(id)).rejects.toThrow(ConflictException);
      await expect(owner.query(`DELETE FROM tool_mapping WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: '23503', constraint: 'fk_device_inventory_tool_mapping' });
      await expect(ds.query(`DELETE FROM tool_mapping WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
      expect(await count(`SELECT count(*) AS n FROM device_inventory WHERE tool_mapping_id = $1`, [id])).toBe(1);
    });
  });

  describe('staff', () => {
    it('deletes an invitation nobody accepted, and frees the email', async () => {
      const invited = await staff.invite({ email: 'gone@things-alive.io', fullName: 'Gone', role: 'catalog-author' }, 'x', NOW);
      await platformCredentials.issueInvitation(invited.id, 'x', NOW);

      await staff.remove(invited.id);
      expect(await count(`SELECT count(*) AS n FROM platform_invitation`)).toBe(0);
      await expect(staff.invite({ email: 'gone@things-alive.io', fullName: 'Back', role: 'catalog-author' }, 'x', NOW))
        .resolves.toMatchObject({ status: 'invited' });
    });

    it('deletes somebody suspended before they ever accepted', async () => {
      const invited = await staff.invite({ email: 'parked@things-alive.io', fullName: 'Parked', role: 'catalog-author' }, 'x', NOW);
      await staff.suspend(invited.id, 'never started');
      await staff.remove(invited.id);
      expect(await count(`SELECT count(*) AS n FROM platform_user WHERE email = 'parked@things-alive.io'`)).toBe(0);
    });

    it('refuses somebody who has signed in, in the service and in the database', async () => {
      const invited = await staff.invite({ email: 'real@things-alive.io', fullName: 'Real', role: 'catalog-author' }, 'x', NOW);
      const { token } = await platformCredentials.issueInvitation(invited.id, 'x', NOW);
      await platformCredentials.acceptInvitation(token, PASSWORD, {}, NOW);

      await expect(staff.remove(invited.id)).rejects.toThrow(BadRequestException);
      await expect(ds.query(`SELECT delete_unused_platform_user($1)`, [invited.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_delete_never_signed_in' });
      await expect(ds.query(`DELETE FROM platform_user WHERE id = $1`, [invited.id])).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses when the invitation is accepted while the delete waits', async () => {
      const invited = await staff.invite({ email: 'late@things-alive.io', fullName: 'Late', role: 'catalog-author' }, 'x', NOW);
      const accepting = owner.createQueryRunner();
      try {
        await accepting.startTransaction();
        await accepting.query(`UPDATE platform_user SET password_hash = 'set', status = 'active' WHERE id = $1`, [invited.id]);
        const pending = staff.remove(invited.id).then(() => 'deleted', (e) => e);
        await new Promise((r) => setTimeout(r, 200));
        await accepting.commitTransaction();
        expect(await pending).toBeInstanceOf(BadRequestException);
      } finally {
        await accepting.release();
      }
      expect(await count(`SELECT count(*) AS n FROM platform_user WHERE id = $1`, [invited.id])).toBe(1);
    });
  });

  describe('client users', () => {
    it('deletes an invitation nobody accepted, and frees the email', async () => {
      const invited = await users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator' }, NOW);
      await credentials.issueInvitation(acme, invited.id, 'invite', NOW);

      await users.remove(acme, invited.id);
      expect(await count(`SELECT count(*) AS n FROM user_invitation WHERE user_id = $1`, [invited.id])).toBe(0);
      await expect(users.invite(acme, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator' }, NOW))
        .resolves.toMatchObject({ status: 'invited' });
    });

    it('refuses somebody who has signed in, in the service and in the database', async () => {
      const invited = await users.invite(acme, { email: 'real@acme.test', fullName: 'Real', roleSlug: 'operator' }, NOW);
      const { token } = await credentials.issueInvitation(acme, invited.id, 'invite', NOW);
      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);

      await expect(users.remove(acme, invited.id)).rejects.toThrow(BadRequestException);
      await expect(ds.query(`DELETE FROM app_user WHERE id = $1`, [invited.id])).rejects.toMatchObject({ code: '42501' });
      expect(await count(`SELECT count(*) AS n FROM app_user WHERE id = $1`, [invited.id])).toBe(1);
    });

    it("refuses the account's only super admin, even before they sign in", async () => {
      const [admin] = await owner.query(`SELECT id FROM app_user WHERE email = 'chief@acme.test'`);
      await expect(users.remove(acme, admin.id)).rejects.toThrow(/only super admin\. Delete the account instead/);
      expect(await count(`SELECT count(*) AS n FROM app_user WHERE id = $1`, [admin.id])).toBe(1);
    });

    it('cannot reach somebody in another account, or with no account at all', async () => {
      const invited = await users.invite(acme, { email: 'mine@acme.test', fullName: 'Mine', roleSlug: 'operator' }, NOW);
      await expect(users.remove({ ...acme, tenantId: 'globex' }, invited.id)).rejects.toThrow(NotFoundException);
      await expect(ds.query(`SELECT delete_unused_app_user($1)`, [invited.id])).rejects.toThrow(/needs a tenant session/);
      expect(await count(`SELECT count(*) AS n FROM app_user WHERE id = $1`, [invited.id])).toBe(1);
    });
  });

  describe('accounts', () => {
    it('deletes a suspended account nobody used, and frees its administrator\'s email', async () => {
      await provisioning.suspend(master, 'acme', 'created by mistake');
      await provisioning.remove(master, 'acme');

      expect(await count(`SELECT count(*) AS n FROM tenant WHERE tenant_id = 'acme'`)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM app_user WHERE tenant_id = 'acme'`)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM tenant_role WHERE tenant_id = 'acme'`)).toBe(0);
      await expect(provisioning.provision(master, account('acme-2', 'chief@acme.test'), NOW)).resolves.toBeTruthy();
    });

    it('refuses an account that is not suspended', async () => {
      await expect(provisioning.remove(master, 'acme')).rejects.toThrow(/Suspend "acme" before deleting it/);
    });

    it('refuses an account somebody has signed in to', async () => {
      const [admin] = await owner.query(`SELECT id FROM app_user WHERE email = 'chief@acme.test'`);
      const { token } = await credentials.issueInvitation(acme, admin.id, 'invite', NOW);
      await credentials.acceptInvitation(token, PASSWORD, {}, NOW);
      await provisioning.suspend(master, 'acme', 'tidy-up');

      await expect(provisioning.remove(master, 'acme')).rejects.toThrow(/Somebody has signed in/);
      expect(await count(`SELECT count(*) AS n FROM tenant WHERE tenant_id = 'acme'`)).toBe(1);
    });

    it('refuses an account that holds data, and names what it holds', async () => {
      await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'PNQ', 'Pune')`);
      await provisioning.suspend(master, 'acme', 'tidy-up');

      await expect(provisioning.remove(master, 'acme')).rejects.toThrow(/already holds data \(plant\)/);
      expect(await count(`SELECT count(*) AS n FROM app_user WHERE tenant_id = 'acme'`)).toBe(1);
    });

    it('is for Things Alive only', async () => {
      await provisioning.suspend(master, 'acme', 'tidy-up');
      await expect(provisioning.remove(acme, 'acme')).rejects.toThrow();
      expect(await count(`SELECT count(*) AS n FROM tenant WHERE tenant_id = 'acme'`)).toBe(1);
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

    const bearer = (role: 'master-admin' | 'platform-support') =>
      mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token;

    it('serves each delete with 204, and staff delete to master admin only', async () => {
      const invited = await staff.invite({ email: 'http@things-alive.io', fullName: 'HTTP', role: 'catalog-author' }, 'x', NOW);
      const refused = await request(app.getHttpServer())
        .delete(`/api/v1/platform/staff/${invited.id}`).set('Authorization', `Bearer ${bearer('platform-support')}`);
      expect(refused.status).toBe(403);
      const staffGone = await request(app.getHttpServer())
        .delete(`/api/v1/platform/staff/${invited.id}`).set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(staffGone.status).toBe(204);

      const [{ id }] = await owner.query(`INSERT INTO tool_mapping (tool_name) VALUES ('Kit') RETURNING id`);
      const mappingGone = await request(app.getHttpServer())
        .delete(`/api/v1/device-catalog/tool-mappings/${id}`).set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(mappingGone.status).toBe(204);

      await provisioning.suspend(master, 'acme', 'tidy-up');
      const accountGone = await request(app.getHttpServer())
        .delete('/api/v1/accounts/acme').set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(accountGone.status).toBe(204);
    });
  });

  describe('the migration', () => {
    afterEach(async () => { await owner.runMigrations({ transaction: 'all' }); });

    it('rolls back to unassigning devices, as the foreign key did before', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      const [{ id }] = await owner.query(`INSERT INTO tool_mapping (tool_name) VALUES ('Old kit') RETURNING id`);
      await owner.query(`INSERT INTO device_inventory (imei, tool_mapping_id) VALUES ('861000000000002', $1)`, [id]);
      await owner.query(`DELETE FROM tool_mapping WHERE id = $1`, [id]);
      expect(await count(`SELECT count(*) AS n FROM device_inventory WHERE imei = '861000000000002' AND tool_mapping_id IS NULL`)).toBe(1);
    });
  });
});
