import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { RoleService } from '../src/identity/services/role.service';
import { UserService } from '../src/identity/services/user.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Who Settings says you are (test report MIN-3, COS-3). Settings called the account
 * "Client" and showed the tenant id where Users and Diagnostics said "CEO/Manager";
 * `/me` now carries the role's own name and the organisation's, read from their rows.
 */
describeDb('/me identity', () => {
  let ds: DataSource;
  let owner: DataSource;
  const NOW = new Date('2026-10-30T09:00:00.000Z');
  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('names the role and the organisation as their own rows do, and renames follow', async () => {
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('acme', 'Acme Construction')`);
    await new RoleService(ds).provisionDefaults('acme', 'u-master', NOW);
    const dana = await new UserService(ds).invite(boss, { email: 'dana@acme.test', fullName: 'Dana', roleSlug: 'operator' }, NOW);
    const config = { get: (k: string) => ({ AUTH_JWT_SECRET: 's', AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[k] } as unknown as ConfigService;
    const credentials = new CredentialService(ds, new PasswordService(), new JwtService({}), config);
    const scope: RequestScope = { tenantId: 'acme', userId: dana.id, roles: ['operator'], isPlatformRole: false };

    expect(await credentials.ownIdentity(scope)).toMatchObject({
      fullName: 'Dana', roleName: 'Operator', tenantName: 'Acme Construction',
    });
    await owner.query(`UPDATE tenant_role SET name = 'Site Operator' WHERE tenant_id = 'acme' AND slug = 'operator'`);
    expect((await credentials.ownIdentity(scope))?.roleName).toBe('Site Operator');
  });
});
