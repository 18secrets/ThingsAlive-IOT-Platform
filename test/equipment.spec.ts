import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { Plant } from '../src/equipment/entities/plant.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { RoleService } from '../src/identity/services/role.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { UserService } from '../src/identity/services/user.service';
import { EquipmentProjection } from '../src/projection/entities/equipment-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Sites and the equipment register (tasks P1-85, P1-86).
 *
 * The client's CEO or manager owns their equipment master and where it stands. Most
 * of what is tested here is ordinary; two things are not, and they are the reason the
 * register could not stay in the projection layer — moving a machine changes who can
 * see it, and a machine created here has to be indistinguishable downstream from one
 * that arrived from the existing platform.
 */
describeDb('equipment register', () => {
  let ds: DataSource;
  let owner: DataSource;
  let equipment: EquipmentService;
  let plants: PlantService;
  let resolver: ScopeResolverService;
  let users: UserService;
  let roles: RoleService;

  const SOURCE = 'iot-platform-1';
  const NOW = new Date('2026-09-13T12:00:00.000Z');

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
  };
  const other: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
  };

  let north: string;
  let south: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    equipment = new EquipmentService(ds);
    plants = new PlantService(ds);
    resolver = new ScopeResolverService(ds);
    users = new UserService(ds);
    roles = new RoleService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['equipment_placement_event', 'user_equipment_access', 'user_plant_access',
      'app_user', 'tenant_role', 'equipment_profile', 'equipment_projection', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    south = (await plants.create(boss, { code: 'SOUTH', name: 'Southern yard' })).id;
  });

  describe('sites', () => {
    it('keeps the code unique inside an account and nowhere else', async () => {
      await expect(plants.create(boss, { code: 'NORTH', name: 'Another' }))
        .rejects.toThrow(ConflictException);
      // Two customers both calling a site NORTH is ordinary.
      await expect(plants.create(other, { code: 'NORTH', name: 'Theirs' })).resolves.toBeTruthy();
    });

    it('lets a site be renamed without anything re-pointing', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
      await plants.update(boss, north, { code: 'NORTH-1', name: 'Northern yard (east)' });

      const [asset] = await equipment.list(boss, { plantId: north });
      // Everything joins on the id, so a rename costs nothing. If the code were the
      // key it would silently re-point every machine.
      expect(asset.externalId).toBe('DG-1');
    });

    it('will not close a site with machines still on it, and says how many', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
      await expect(plants.retire(boss, north)).rejects.toThrow(/1 machine is still at/);
    });

    it('closes once the machines have moved', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
      await equipment.move(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' },
        south, 'consolidating the yards');
      await expect(plants.retire(boss, north)).resolves.toMatchObject({ status: 'retired' });
    });

    it('refuses to place a machine at a closed site', async () => {
      await plants.retire(boss, south);
      await expect(equipment.create(boss, { code: 'DG-9', name: 'Nine', plantId: south }))
        .rejects.toThrow(/Reopen it before placing machines there/);
    });

    it('cannot see or touch another account\'s sites', async () => {
      expect((await plants.list(other)).map((p) => p.code)).toEqual([]);
      await expect(plants.update(other, north, { name: 'Theirs' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('the register', () => {
    it('gives a machine created here the same shape as one that arrived', async () => {
      const asset = await equipment.create(boss, {
        code: 'DG-1', name: 'Generator 1', manufacturer: 'Kirloskar', plantId: north,
      });
      // Identity was always (source system, external id), because two upstream systems
      // could report the same machine. Equipment created here is simply another source
      // system, so nothing downstream has to know which kind it is holding.
      expect(asset.sourceSystem).toBe(CLIENT_SOURCE_SYSTEM);
      expect(asset.externalId).toBe('DG-1');
      expect(asset.origin).toBe('client');
    });

    it('refuses a code that would be awkward to live with', async () => {
      await expect(equipment.create(boss, { code: 'DG 1', name: 'x' }))
        .rejects.toThrow(BadRequestException);
      await expect(equipment.create(boss, { code: '', name: 'x' }))
        .rejects.toThrow(BadRequestException);
    });

    it('will not create the same machine twice', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1' });
      await expect(equipment.create(boss, { code: 'DG-1', name: 'Again' }))
        .rejects.toThrow(ConflictException);
    });

    it('edits description without touching placement', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
      const updated = await equipment.update(boss,
        { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' },
        { name: 'Generator One', manufacturer: 'Cummins' });

      expect(updated.name).toBe('Generator One');
      // Moving a machine has its own method because it has its own consequences, and
      // burying it among seven descriptive fields would hide them.
      expect(updated.plantId).toBe(north);
    });
  });

  describe('moving a machine', () => {
    beforeEach(async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
    });

    const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' };

    it('demands a reason, because somebody loses sight of the machine', async () => {
      await expect(equipment.move(boss, ref, south, '  ')).rejects.toThrow(/changes who can see/);
    });

    it('records where it went and who moved it', async () => {
      await equipment.move(boss, ref, south, 'overhaul at the southern yard');

      const history = await equipment.placementHistory(boss, ref);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ fromPlantId: null, toPlantId: north });
      expect(history[1]).toMatchObject({
        fromPlantId: north, toPlantId: south,
        reason: 'overhaul at the southern yard', actorUserId: 'u-boss',
      });
    });

    it('takes it off site without retiring it', async () => {
      const off = await equipment.move(boss, ref, null, 'on a lorry');
      expect(off.plantId).toBeNull();
      expect(off.status).toBe('active');
    });

    it('refuses a site belonging to somebody else', async () => {
      const theirs = await plants.create(other, { code: 'THEIRS', name: 'Theirs' });
      // Refused because it does not exist from here, rather than because a comparison
      // said so.
      await expect(equipment.move(boss, ref, theirs.id, 'x')).rejects.toThrow(NotFoundException);
    });

    it('leaves the site when retired, so it stops counting against closing one', async () => {
      await equipment.retire(boss, ref, 'sold');
      const [asset] = await equipment.list(boss, { includeRetired: true });
      expect(asset.status).toBe('retired');
      expect(asset.plantId).toBeNull();
      await expect(plants.retire(boss, north)).resolves.toBeTruthy();
    });
  });

  describe('what a site manager sees', () => {
    let siteManagerId: string;

    beforeEach(async () => {
      await roles.provisionDefaults('acme', 'u-master', NOW);
      const user = await users.invite(boss, {
        email: 'sm@acme.test', fullName: 'Site', roleSlug: 'site-manager',
        plants: [{ plantId: north }],
      }, NOW);
      siteManagerId = user.id;
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.query(`UPDATE "app_user" SET "status" = 'active', "password_hash" = 'x' WHERE "id" = $1`,
          [user.id]));
    });

    it('changes the moment a machine is moved, without anybody editing a list', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'One', plantId: north });
      await equipment.create(boss, { code: 'DG-2', name: 'Two', plantId: south });

      expect((await resolver.resolve('acme', siteManagerId))!.equipmentIds).toEqual(['DG-1']);

      await equipment.move(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-2' },
        north, 'moved north for the season');

      // This is why moving is recorded: one person gains a machine and another loses
      // one, immediately and silently, because the fleet is derived rather than listed.
      expect([...(await resolver.resolve('acme', siteManagerId))!.equipmentIds!].sort())
        .toEqual(['DG-1', 'DG-2']);
    });

    it('still sees machines that have not been adopted into the register yet', async () => {
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.getRepository(EquipmentProjection).save({
          tenantId: 'acme', sourceSystem: SOURCE, externalId: 'OLD-1', checksum: 'c',
          name: 'Legacy generator', classId: null, plantExternalId: 'NORTH-UPSTREAM',
          category: null, payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
        }));
      await plants.update(boss, north, {});
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.query(
          `UPDATE "plant" SET "source_system" = $2, "external_id" = 'NORTH-UPSTREAM' WHERE "id" = $1`,
          [north, SOURCE],
        ));

      // A customer mid-migration has a half-adopted fleet, and a site manager seeing
      // nothing until somebody finishes an import is not a defensible reading of
      // "sees their site".
      expect((await resolver.resolve('acme', siteManagerId))!.equipmentIds).toEqual(['OLD-1']);
    });

    it('sees nothing when assigned to no site at all', async () => {
      await users.setAccess(boss, siteManagerId, { plants: [] });
      const resolved = await resolver.resolve('acme', siteManagerId);
      expect(resolved!.plantIds).toEqual([]);
      expect(resolved!.equipmentIds).toEqual([]);
    });
  });

  describe('adopting an existing fleet', () => {
    beforeEach(async () => {
      await runTenantSpanning(owner, 'test fixture', async (m) => {
        await m.query(
          `UPDATE "plant" SET "source_system" = $2, "external_id" = 'NORTH-UPSTREAM' WHERE "id" = $1`,
          [north, SOURCE],
        );
        const repo = m.getRepository(EquipmentProjection);
        for (const [externalId, plant] of [['OLD-1', 'NORTH-UPSTREAM'], ['OLD-2', 'UNKNOWN-SITE']]) {
          await repo.save({
            tenantId: 'acme', sourceSystem: SOURCE, externalId, checksum: `c-${externalId}`,
            name: externalId, classId: null, plantExternalId: plant, category: null,
            payload: {}, sourceUpdatedAt: NOW, syncedAt: NOW, status: 'live' as const,
          });
        }
      });
    });

    it('adopts a fleet without retyping it, keeping upstream identity', async () => {
      const result = await equipment.importFromMirror(boss, SOURCE);
      expect(result).toEqual({ imported: 2, alreadyKnown: 0, unplaced: 1 });

      const register = await equipment.list(boss);
      expect(register.map((e) => e.externalId).sort()).toEqual(['OLD-1', 'OLD-2']);
      // The identity is the upstream one, so every device claim, activation and
      // prediction already keyed on it keeps resolving.
      expect(register.every((e) => e.sourceSystem === SOURCE)).toBe(true);
      expect(register.every((e) => e.origin === 'mirrored')).toBe(true);
    });

    it('places what it can and leaves the rest empty rather than guessing', async () => {
      await equipment.importFromMirror(boss, SOURCE);
      const byId = new Map((await equipment.list(boss)).map((e) => [e.externalId, e]));

      expect(byId.get('OLD-1')!.plantId).toBe(north);
      // Guessing would put machines at the wrong site, which is worse than an obvious
      // gap somebody fills in.
      expect(byId.get('OLD-2')!.plantId).toBeNull();
    });

    it('can be run twice', async () => {
      await equipment.importFromMirror(boss, SOURCE);
      expect(await equipment.importFromMirror(boss, SOURCE))
        .toEqual({ imported: 0, alreadyKnown: 2, unplaced: 0 });
      expect(await owner.getRepository(EquipmentProfile).count()).toBe(2);
    });
  });

  describe('isolation', () => {
    it('keeps one account\'s register out of another', async () => {
      await equipment.create(boss, { code: 'DG-1', name: 'One', plantId: north });
      expect(await equipment.list(other)).toEqual([]);
      await expect(equipment.update(other,
        { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' }, { name: 'Theirs' }))
        .rejects.toThrow(NotFoundException);
      expect(await owner.getRepository(Plant).count()).toBeGreaterThan(0);
    });
  });
});
