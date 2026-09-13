import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DomainEvent } from '../src/events/domain-event.entity';
import { AppUser } from '../src/identity/entities/app-user.entity';
import { TenantRole } from '../src/identity/entities/tenant-role.entity';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { UserService } from '../src/identity/services/user.service';
import { TenantMap } from '../src/projection/entities/tenant-map.entity';
import { Tenant } from '../src/tenancy/entities/tenant.entity';
import { ProvisioningService } from '../src/tenancy/services/provisioning.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Standing an account up (task P1-89).
 *
 * Everything here existed separately before this slice. What is being tested is that
 * five writes happen together or not at all — because the failure mode in between is
 * worse than either: an account that exists, that nobody can sign in to, and that
 * whoever re-runs the step cannot reason about.
 */
describeDb('provisioning', () => {
  let ds: DataSource;
  let owner: DataSource;
  let provisioning: ProvisioningService;
  let credentials: CredentialService;
  let resolver: ScopeResolverService;
  let users: UserService;

  const NOW = new Date('2026-09-13T10:00:00.000Z');
  const PASSWORD = 'correct horse battery staple';

  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const customer: RequestScope = {
    tenantId: 'acme', userId: 'u-any', roles: ['ceo-manager'], isPlatformRole: false,
  };

  const input = {
    tenantId: 'acme',
    name: 'Acme Power',
    plan: 'standard',
    region: 'in-south',
    superAdmin: { email: 'chief@acme.test', fullName: 'Chief Executive' },
    externalClients: [{ sourceSystem: 'iot-platform-1', externalClientId: '42' }],
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();

    const passwords = new PasswordService();
    provisioning = new ProvisioningService(ds, passwords);
    resolver = new ScopeResolverService(ds);
    users = new UserService(ds);

    const config = {
      get: (key: string) => ({
        AUTH_JWT_SECRET: 'test-secret-for-signing',
        AUTH_TENANT_CLAIM: 'client_id',
      } as Record<string, string>)[key],
    } as unknown as ConfigService;
    credentials = new CredentialService(ds, passwords, new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['domain_event', 'user_security_event', 'user_session', 'user_invitation',
      'user_equipment_access', 'user_plant_access', 'app_user', 'tenant_role',
      'tenant_map', 'tenant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  describe('one transaction', () => {
    it('creates the account, its roles, its first administrator and their invitation', async () => {
      const result = await provisioning.provision(master, input, NOW);

      expect(result.tenant.name).toBe('Acme Power');
      expect(result.tenant.status).toBe('active');
      expect(result.roles.sort()).toEqual(['ceo-manager', 'operator', 'site-manager']);
      expect(result.superAdmin.email).toBe('chief@acme.test');
      expect(result.invitationToken).toBeTruthy();

      // The upstream mapping too, or the account exists and every machine belonging
      // to it arrives as a projection rejection.
      const [mapped] = await owner.getRepository(TenantMap).find();
      expect(mapped.tenantId).toBe('acme');
      expect(mapped.externalClientId).toBe('42');
    });

    it('leaves nothing behind when any part of it fails', async () => {
      await provisioning.provision(master, { ...input, tenantId: 'globex' }, NOW);
      // Same administrator email, different account. The clash is found inside the
      // transaction, after the account row has already been written.
      await expect(provisioning.provision(master, input, NOW)).rejects.toThrow(ConflictException);

      // The whole point: no half-built account with no way in.
      const tenants = await owner.getRepository(Tenant).find();
      expect(tenants.map((t) => t.tenantId)).toEqual(['globex']);
      const roles = await owner.getRepository(TenantRole).find({ where: { tenantId: 'acme' } });
      expect(roles).toEqual([]);
    });

    it('refuses to provision an account that already exists', async () => {
      await provisioning.provision(master, input, NOW);
      // Not an idempotent no-op, deliberately. Quietly returning a second invitation
      // to a live account hands somebody a working credential.
      await expect(provisioning.provision(master, input, NOW))
        .rejects.toThrow(/Invite people to it rather than provisioning it again/);
    });

    it('refuses a tenant id that cannot be corrected later', async () => {
      // It appears in every row of every table and inside the isolation predicate.
      for (const bad of ['Acme', 'a', 'acme power', '-acme', 'acme_power']) {
        await expect(provisioning.provision(master, { ...input, tenantId: bad }, NOW))
          .rejects.toThrow(BadRequestException);
      }
    });

    it('will not let two accounts claim one upstream client', async () => {
      await provisioning.provision(master, input, NOW);
      await expect(provisioning.provision(master, {
        ...input, tenantId: 'globex', superAdmin: { email: 'other@globex.test', fullName: 'Other' },
      }, NOW)).rejects.toThrow(/each receive half its data/);
    });

    it('is not something a customer can do', async () => {
      await expect(provisioning.provision(customer, input, NOW)).rejects.toThrow(BadRequestException);
      await expect(provisioning.list(customer)).rejects.toThrow(BadRequestException);
    });

    it('announces itself on the outbox', async () => {
      await provisioning.provision(master, input, NOW);
      const [event] = await owner.getRepository(DomainEvent).find();
      expect(event.eventType).toBe('tenant.provisioned.v1');
      expect(event.deliveryState).toBe('pending');
      expect(event.subject).toBe('acme');
    });
  });

  describe('the first sign-in', () => {
    it('works end to end, from provisioning to a resolved scope', async () => {
      const provisioned = await provisioning.provision(master, input, NOW);

      const session = await credentials.acceptInvitation(
        provisioned.invitationToken, PASSWORD, {}, NOW,
      );
      expect(session.user.tenantId).toBe('acme');
      expect(session.user.roleSlug).toBe('ceo-manager');

      // And the scope they resolve to is the unrestricted one, because the role they
      // were seeded with is tenant-shaped.
      const scope = await resolver.resolve('acme', session.user.id);
      expect(scope!.plantIds).toBeUndefined();
      expect(scope!.capabilities).toContain('user.manage');
    });
  });

  describe('turning an account off', () => {
    let adminId: string;

    beforeEach(async () => {
      const provisioned = await provisioning.provision(master, input, NOW);
      const session = await credentials.acceptInvitation(provisioned.invitationToken, PASSWORD, {}, NOW);
      adminId = session.user.id;
    });

    it('stops every sign-in without touching a single user', async () => {
      await provisioning.suspend(master, 'acme', 'invoice unpaid for 90 days', NOW);

      await expect(credentials.signIn('chief@acme.test', PASSWORD, {}, NOW))
        .rejects.toThrow(/organisation's account is suspended/);
      await expect(resolver.resolve('acme', adminId))
        .rejects.toThrow(/organisation's account is suspended/);

      // Nothing about the person changed, which is what makes reinstating exact.
      const user = await owner.getRepository(AppUser).findOneByOrFail({ id: adminId });
      expect(user.status).toBe('active');
    });

    it('says nothing until the password is right', async () => {
      await provisioning.suspend(master, 'acme', 'invoice unpaid', NOW);
      // Otherwise this route answers "does anybody at this company use the platform"
      // to whoever asks.
      await expect(credentials.signIn('chief@acme.test', 'wrong', {}, NOW))
        .rejects.toThrow('Email or password is incorrect.');
    });

    it('demands a reason, because somebody will ask why their fleet went dark', async () => {
      await expect(provisioning.suspend(master, 'acme', '   ', NOW))
        .rejects.toThrow(BadRequestException);
    });

    it('restores exactly what was there', async () => {
      await provisioning.suspend(master, 'acme', 'invoice unpaid', NOW);
      const back = await provisioning.reinstate(master, 'acme', NOW);

      expect(back.status).toBe('active');
      expect(back.suspendedReason).toBeNull();
      await expect(credentials.signIn('chief@acme.test', PASSWORD, {}, NOW)).resolves.toBeTruthy();
    });

    it('refuses an account that does not exist', async () => {
      await expect(provisioning.suspend(master, 'nobody', 'x', NOW)).rejects.toThrow(NotFoundException);
    });
  });

  describe('isolation', () => {
    it('keeps one account out of another, at every layer', async () => {
      await provisioning.provision(master, input, NOW);
      await provisioning.provision(master, {
        ...input, tenantId: 'globex', name: 'Globex Cement',
        superAdmin: { email: 'boss@globex.test', fullName: 'Boss' },
        externalClients: [{ sourceSystem: 'iot-platform-1', externalClientId: '99' }],
      }, NOW);

      const acme: RequestScope = {
        tenantId: 'acme', userId: 'u-acme', roles: ['ceo-manager'], isPlatformRole: false,
      };
      // Roles, people and everything else already proved this; the account row is the
      // newest table and the one a screen reads to print the customer's own name.
      expect((await users.list(acme)).map((u) => u.email)).toEqual(['chief@acme.test']);
      expect((await provisioning.list(master)).map((t) => t.tenantId).sort())
        .toEqual(['acme', 'globex']);
    });
  });
});
