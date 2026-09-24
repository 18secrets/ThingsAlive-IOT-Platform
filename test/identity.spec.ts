import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ALL_CAPABILITIES, can } from '../src/auth/capabilities';
import { RequestScope } from '../src/auth/types/request-scope';
import { AppUser } from '../src/identity/entities/app-user.entity';
import { TenantRole } from '../src/identity/entities/tenant-role.entity';
import { ROLE_TEMPLATES } from '../src/identity/role-templates';
import { RoleService } from '../src/identity/services/role.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { UserService } from '../src/identity/services/user.service';
import { Plant } from '../src/equipment/entities/plant.entity';
import { EquipmentProjection } from '../src/projection/entities/equipment-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Users, roles and the scope they resolve to (tasks P1-21, P1-83, P1-84).
 *
 * The rule under most of this: capabilities are code and roles are rows. A client
 * composes roles from a vocabulary the application checks, so they can have as many
 * roles as they need and cannot invent a permission nothing reads.
 */
describe('role templates', () => {
  it('only name capabilities the application actually checks', () => {
    // The failure this prevents is quiet: a role granting something no code reads is
    // a permission that looks given and does nothing, and the person who granted it
    // has no way to find out.
    const known = new Set<string>(ALL_CAPABILITIES);
    for (const template of ROLE_TEMPLATES) {
      const unknown = template.capabilities.filter((c) => !known.has(c));
      expect({ role: template.slug, unknown }).toEqual({ role: template.slug, unknown: [] });
    }
  });

  it('differ in the shape of their scope, not the amount of it', () => {
    const shapes = ROLE_TEMPLATES.map((t) => t.scopeShape).sort();
    expect(shapes).toEqual(['equipment', 'plant', 'tenant']);
  });

  it('give nobody but the manager the power to manage people', () => {
    for (const t of ROLE_TEMPLATES) {
      const managerial = t.capabilities.includes('user.manage') || t.capabilities.includes('role.manage');
      expect({ role: t.slug, managerial }).toEqual({ role: t.slug, managerial: t.slug === 'ceo-manager' });
    }
  });
});

describeDb('identity', () => {
  let ds: DataSource;
  let owner: DataSource;
  let users: UserService;
  let roles: RoleService;
  let resolver: ScopeResolverService;

  const SOURCE = 'iot-platform-1';
  const NOW = new Date('2026-09-13T00:00:00.000Z');

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
  };
  const other: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    users = new UserService(ds);
    roles = new RoleService(ds);
    resolver = new ScopeResolverService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_equipment_access', 'user_plant_access', 'app_user',
      'tenant_role', 'equipment_projection', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await roles.provisionDefaults('acme', 'u-master', NOW);
    await roles.provisionDefaults('globex', 'u-master', NOW);

    // Four machines across three sites, so a plant-shaped scope has something to
    // derive. The sites are rows in the register and carry the upstream identifier
    // they correspond to, which is what lets un-adopted machines still resolve.
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      const plants = m.getRepository(Plant);
      for (const code of ['PLANT-A', 'PLANT-B', 'PLANT-C']) {
        const saved = await plants.save({
          tenantId: 'acme', code, name: code, address: null, siteArea: null,
          capacity: null, projectType: null, operationalStatus: null, description: null,
          status: 'active' as const, sourceSystem: SOURCE, externalId: code,
          createdBy: 'u-boss', updatedBy: 'u-boss',
        });
        plantIds[code] = saved.id;
      }
      const repo = m.getRepository(EquipmentProjection);
      for (const [externalId, plant] of [
        ['DG-1', 'PLANT-A'], ['DG-2', 'PLANT-A'], ['DG-3', 'PLANT-B'], ['DG-4', 'PLANT-C'],
      ]) {
        await repo.save({
          tenantId: 'acme', sourceSystem: SOURCE, externalId, checksum: `c-${externalId}`,
          name: externalId, classId: null, plantExternalId: plant, category: null,
          payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
        });
      }
    });
  });

  const plantIds: Record<string, string> = {};

  const activate = (id: string) =>
    runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(AppUser).update({ id }, { status: 'active', passwordHash: 'set-next-slice' }));

  describe('provisioning', () => {
    it('gives a new account the three roles, as copies it owns', async () => {
      const list = await roles.list(boss);
      expect(list.map((r) => r.slug).sort()).toEqual(['ceo-manager', 'operator', 'site-manager']);
      expect(list.every((r) => r.isBuiltIn)).toBe(true);
      expect(list.every((r) => r.copiedAt !== null)).toBe(true);
    });

    it('never undoes an edit by running again', async () => {
      await roles.update(boss, 'operator', { name: 'Shift technician', capabilities: ['prediction.read'] });
      await roles.provisionDefaults('acme', 'u-master', NOW);

      const [operator] = (await roles.list(boss)).filter((r) => r.slug === 'operator');
      // A client who renamed a role has said something. Provisioning is not entitled
      // to undo it, any more than editing a catalog template reaches into an account.
      expect(operator.name).toBe('Shift technician');
      expect(operator.capabilities).toEqual(['prediction.read']);
    });
  });

  describe('roles', () => {
    it('refuses a capability the application has never heard of', async () => {
      await expect(roles.create(boss, {
        slug: 'safety', name: 'Safety officer', scopeShape: 'plant',
        capabilities: ['prediction.read', 'reports.export'],
      })).rejects.toThrow(/Unknown capability: reports.export/);
    });

    it('lets an account add the roles it needs', async () => {
      const role = await roles.create(boss, {
        slug: 'safety', name: 'Safety officer', scopeShape: 'plant',
        capabilities: ['prediction.read', 'catalog.read'],
      });
      expect(role.isBuiltIn).toBe(false);
      expect((await roles.list(boss)).map((r) => r.slug)).toContain('safety');
    });

    it('will not delete a role somebody holds, and says how many', async () => {
      await roles.create(boss, {
        slug: 'safety', name: 'Safety officer', scopeShape: 'plant', capabilities: ['prediction.read'],
      });
      await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'safety' }, NOW);

      await expect(roles.remove(boss, 'safety')).rejects.toThrow(/1 person holds/);
    });

    it('will not delete a built-in, because its holders need somewhere to go', async () => {
      await expect(roles.remove(boss, 'operator')).rejects.toThrow(/every account has/);
    });

    it('cannot see or touch another account\'s roles', async () => {
      await roles.create(boss, {
        slug: 'safety', name: 'Safety officer', scopeShape: 'plant', capabilities: ['prediction.read'],
      });
      expect((await roles.list(other)).map((r) => r.slug)).not.toContain('safety');
      await expect(roles.update(other, 'safety', { name: 'Theirs' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('people', () => {
    it('invites with a role, because a user without one describes nobody', async () => {
      const user = await users.invite(boss, {
        email: ' Dana@Acme.TEST ', fullName: 'Dana', roleSlug: 'site-manager',
        plants: [{ plantId: plantIds['PLANT-A'] }],
      }, NOW);

      // Lower-cased and trimmed once, so a stray capital never creates a twin.
      expect(user.email).toBe('dana@acme.test');
      expect(user.status).toBe('invited');
      // UserView never carries passwordHash at all — not even null. See user.service.ts.
      expect(Object.prototype.hasOwnProperty.call(user, 'passwordHash')).toBe(false);
      expect(user.plants).toEqual([{ plantId: plantIds['PLANT-A'] }]);
    });

    it('refuses a role that does not exist here', async () => {
      await expect(users.invite(boss, {
        email: 'x@acme.test', fullName: 'X', roleSlug: 'safety',
      }, NOW)).rejects.toThrow(/No role "safety" in this account/);
    });

    it('gives one person one login, across every account', async () => {
      await users.invite(boss, { email: 'dana@acme.test', fullName: 'Dana', roleSlug: 'operator' }, NOW);
      // The clash is in another account entirely, and the message says nothing about
      // where — a stranger's account owes nobody that.
      await expect(users.invite(other, {
        email: 'dana@acme.test', fullName: 'Dana', roleSlug: 'operator',
      }, NOW)).rejects.toThrow(ConflictException);
    });

    it('suspends rather than deletes, and demands a reason', async () => {
      const user = await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'operator' }, NOW);
      await expect(users.suspend(boss, user.id, '  ')).rejects.toThrow(BadRequestException);

      const off = await users.suspend(boss, user.id, 'left the company', NOW);
      expect(off.status).toBe('suspended');
      expect(off.suspendedReason).toBe('left the company');
      // Still there: everything they did names them.
      expect((await users.list(boss)).map((u) => u.id)).toContain(user.id);
    });

    it('keeps assignments through a role change', async () => {
      const user = await users.invite(boss, {
        email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'site-manager',
        plants: [{ plantId: plantIds['PLANT-A'] }],
      }, NOW);

      const promoted = await users.setRole(boss, user.id, 'ceo-manager');
      // The rows stop mattering, because a tenant-shaped role does not read them.
      // Deleting them would destroy the record of what this person used to run.
      expect(promoted.plants).toEqual([{ plantId: plantIds['PLANT-A'] }]);
    });

    it('cannot reach a person in another account', async () => {
      const user = await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'operator' }, NOW);
      await expect(users.setRole(other, user.id, 'operator')).rejects.toThrow(NotFoundException);
      expect(await users.list(other)).toEqual([]);
    });
  });

  describe('resolving what somebody may see', () => {
    it('leaves a manager unrestricted inside the account', async () => {
      const user = await users.invite(boss, { email: 'ceo@acme.test', fullName: 'Chief', roleSlug: 'ceo-manager' }, NOW);
      await activate(user.id);

      const resolved = await resolver.resolve('acme', user.id);
      // undefined, not an empty list. The difference carries the meaning: unrestricted
      // within the account versus matching nothing at all.
      expect(resolved!.plantIds).toBeUndefined();
      expect(resolved!.equipmentIds).toBeUndefined();
      expect(can({ ...boss, capabilities: resolved!.capabilities }, 'user.manage')).toBe(true);
    });

    it('derives a site manager\'s machines from their sites', async () => {
      const user = await users.invite(boss, {
        email: 'sm@acme.test', fullName: 'Site', roleSlug: 'site-manager',
        plants: [{ plantId: plantIds['PLANT-A'] }, { plantId: plantIds['PLANT-B'] }],
      }, NOW);
      await activate(user.id);

      const resolved = await resolver.resolve('acme', user.id);
      expect([...resolved!.plantIds!].sort())
        .toEqual([plantIds['PLANT-A'], plantIds['PLANT-B']].sort());
      // Derived, not stored. A machine moved into one of their sites is theirs from
      // that moment, with no list for anybody to remember to update.
      expect([...resolved!.equipmentIds!].sort()).toEqual(['DG-1', 'DG-2', 'DG-3']);
      expect(resolved!.equipmentIds).not.toContain('DG-4');
    });

    it('gives a site manager with no site nothing, rather than everything', async () => {
      const user = await users.invite(boss, { email: 'new@acme.test', fullName: 'New', roleSlug: 'site-manager' }, NOW);
      await activate(user.id);

      const resolved = await resolver.resolve('acme', user.id);
      // The dangerous bug this guards: an empty assignment list read as "no filter".
      expect(resolved!.plantIds).toEqual([]);
      expect(resolved!.equipmentIds).toEqual([]);
    });

    it('holds an operator\'s machines until the assignment is taken away', async () => {
      const user = await users.invite(boss, {
        email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator',
        equipment: [{ sourceSystem: SOURCE, equipmentExternalId: 'DG-1' }],
      }, NOW);
      await activate(user.id);

      expect((await resolver.resolve('acme', user.id))!.equipmentIds).toEqual(['DG-1']);
      // And no site-level access at all: an operator sees machines, not sites.
      expect((await resolver.resolve('acme', user.id))!.plantIds).toEqual([]);

      await users.setAccess(boss, user.id, { equipment: [] });
      expect((await resolver.resolve('acme', user.id))!.equipmentIds).toEqual([]);
    });

    it('takes a capability away the moment the role changes', async () => {
      const user = await users.invite(boss, { email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator' }, NOW);
      await activate(user.id);

      const before = await resolver.resolve('acme', user.id);
      expect(can({ ...boss, capabilities: before!.capabilities }, 'prediction.read')).toBe(true);

      await roles.update(boss, 'operator', { capabilities: ['catalog.read'] });
      const after = await resolver.resolve('acme', user.id);
      // Resolved per request, so this applies to the next request rather than
      // whenever a token happens to expire.
      expect(can({ ...boss, capabilities: after!.capabilities }, 'prediction.read')).toBe(false);
    });

    it('refuses a suspended person and an unaccepted invitation', async () => {
      const user = await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'operator' }, NOW);
      await expect(resolver.resolve('acme', user.id)).rejects.toThrow(/invitation has not been accepted/);

      await activate(user.id);
      await users.suspend(boss, user.id, 'left the company', NOW);
      await expect(resolver.resolve('acme', user.id)).rejects.toThrow(UnauthorizedException);
    });

    it('returns nothing for somebody who has no row here, so a platform role still works', async () => {
      // Things Alive staff hold no row in any customer's account. Falling back to the
      // token is what lets support in; inventing a row for them would not.
      expect(await resolver.resolve('acme', '00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('refuses outright when a role has gone missing', async () => {
      await roles.create(boss, {
        slug: 'temp', name: 'Temp', scopeShape: 'equipment', capabilities: ['prediction.read'],
      });
      const user = await users.invite(boss, { email: 'sam@acme.test', fullName: 'Sam', roleSlug: 'temp' }, NOW);
      await activate(user.id);
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(TenantRole).delete({ tenantId: 'acme', slug: 'temp' }));

      // Not "no capabilities". A silent downgrade looks identical to a correctly
      // locked-down user and hides a broken account until somebody complains.
      await expect(resolver.resolve('acme', user.id)).rejects.toThrow(/no longer exists in this account/);
    });
  });
});
