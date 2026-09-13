import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { RoleService } from '../src/identity/services/role.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { UserService } from '../src/identity/services/user.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { WORK_ORDER_TRANSITIONS, workOrderTransition } from '../src/work/services/work-order-state-machine';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

describe('the work-order state machine', () => {
  it('lets a quick job be completed without being started first', () => {
    // Forcing a start would only teach everybody to press two buttons, and the
    // timestamps would then describe the buttons rather than the work.
    expect(workOrderTransition('complete', 'created', 'tightened the mount').to).toBe('completed');
  });

  it('refuses to finish a job twice', () => {
    expect(() => workOrderTransition('complete', 'completed', 'again'))
      .toThrow(BadRequestException);
  });

  it('demands a note for every ending, and for undoing one', () => {
    for (const action of ['complete', 'cancel'] as const) {
      expect(() => workOrderTransition(action, 'created', '  ')).toThrow(/note is required/);
    }
    expect(() => workOrderTransition('reopen', 'completed', '')).toThrow(/note is required/);
  });

  it('reopens to created rather than to wherever it was', () => {
    // "In progress" would be a claim about somebody working on it right now.
    expect(WORK_ORDER_TRANSITIONS.reopen.to).toBe('created');
  });
});

describeDb('work orders', () => {
  let ds: DataSource;
  let owner: DataSource;
  let orders: WorkOrderService;
  let equipment: EquipmentService;
  let plants: PlantService;
  let users: UserService;
  let roles: RoleService;
  let resolver: ScopeResolverService;

  const NOW = new Date('2026-09-13T09:00:00.000Z');
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['action.work', 'action.assign', 'equipment.write', 'user.manage'],
  };
  const other: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['action.work', 'action.assign', 'equipment.write'],
  };

  let north: string;
  let operatorId: string;
  let operator: RequestScope;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    resolver = new ScopeResolverService(ds);
    orders = new WorkOrderService(ds, resolver);
    equipment = new EquipmentService(ds);
    plants = new PlantService(ds);
    users = new UserService(ds);
    roles = new RoleService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['work_order_event', 'work_order', 'work_order_counter',
      'user_equipment_access', 'user_plant_access', 'app_user', 'tenant_role',
      'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await roles.provisionDefaults('acme', 'u-master', NOW);
    north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
    await equipment.create(boss, { code: 'DG-2', name: 'Generator 2', plantId: north });

    const person = await users.invite(boss, {
      email: 'op@acme.test', fullName: 'Op', roleSlug: 'operator',
      equipment: [{ sourceSystem: CLIENT_SOURCE_SYSTEM, equipmentExternalId: 'DG-1' }],
    }, NOW);
    operatorId = person.id;
    await runTenantSpanning(owner, 'test fixture', (m) =>
      m.query(`UPDATE "app_user" SET "status" = 'active', "password_hash" = 'x' WHERE "id" = $1`,
        [person.id]));
    const resolved = await resolver.resolve('acme', person.id);
    operator = {
      tenantId: 'acme', userId: person.id, roles: ['operator'], isPlatformRole: false,
      capabilities: resolved!.capabilities, equipmentIds: resolved!.equipmentIds,
    };
  });

  const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' };

  describe('raising', () => {
    it('numbers jobs per account, contiguously', async () => {
      const a = await orders.raise(boss, { ...ref, title: 'Oil change' });
      const b = await orders.raise(boss, { ...ref, title: 'Belt check' });
      expect([a.reference, b.reference]).toEqual(['WO-000001', 'WO-000002']);

      // A shared sequence would leak: a customer whose numbers jump from 2 to 4,310
      // learns how much work every other customer is raising.
      await runTenantSpanning(owner, 'test fixture', (m) =>
        m.query(`INSERT INTO "plant" ("tenant_id","code","name") VALUES ('globex','N','N')`));
      await equipment.create(other, { code: 'DG-1', name: 'Theirs' });
      const theirs = await orders.raise(other, { ...ref, title: 'Theirs' });
      expect(theirs.reference).toBe('WO-000001');
    });

    it('refuses a machine that is not in this account', async () => {
      await expect(orders.raise(boss, {
        sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'NOPE', title: 'x',
      })).rejects.toThrow(NotFoundException);
    });

    it('refuses a retired machine', async () => {
      await equipment.retire(boss, { ...ref }, 'sold');
      await expect(orders.raise(boss, { ...ref, title: 'x' }))
        .rejects.toThrow(/retired/);
    });

    it('will not hand a job to somebody who cannot open it', async () => {
      // DG-2 is not assigned to the operator. Assigning anyway would leave a job
      // sitting in a queue looking like work in hand, that nobody can see.
      await expect(orders.raise(boss, {
        sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-2',
        title: 'Coolant top-up', assignedToUserId: operatorId,
      })).rejects.toThrow(/not assigned to this machine/);
    });

    it('records the raise and the assignment as separate events', async () => {
      const order = await orders.raise(boss, {
        ...ref, title: 'Oil change', assignedToUserId: operatorId,
      });
      const history = await orders.history(boss, order.id);
      expect(history.map((h) => h.kind)).toEqual(['raised', 'assigned']);
      expect(history[1].toAssignee).toBe(operatorId);
    });

    it('keeps the prediction that caused it', async () => {
      const predictionId = '11111111-1111-1111-1111-111111111111';
      const order = await orders.raise(boss, { ...ref, title: 'High vibration', predictionId });
      // Without this link, "how many of our warnings did anyone act on" is
      // unanswerable, and that is the question the product is judged by.
      expect(order.predictionId).toBe(predictionId);
    });
  });

  describe('who may do what', () => {
    it('does not let an operator raise or cancel work', async () => {
      await expect(orders.raise(operator, { ...ref, title: 'x' }))
        .rejects.toThrow(ForbiddenException);
      const order = await orders.raise(boss, { ...ref, title: 'x', assignedToUserId: operatorId });
      await expect(orders.act(operator, order.id, 'cancel', 'not doing it'))
        .rejects.toThrow(ForbiddenException);
    });

    it('lets an operator work only what is theirs', async () => {
      const mine = await orders.raise(boss, { ...ref, title: 'Mine', assignedToUserId: operatorId });
      const theirs = await orders.raise(boss, { ...ref, title: 'Somebody else\'s' });

      await expect(orders.act(operator, mine.id, 'start', null)).resolves.toMatchObject({
        status: 'in-progress',
      });
      await expect(orders.act(operator, theirs.id, 'start', null))
        .rejects.toThrow(/assigned to somebody else/);
    });

    it('lets a manager close a job for a fitter who has gone home', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'x', assignedToUserId: operatorId });
      await expect(orders.act(boss, order.id, 'complete', 'finished it myself'))
        .resolves.toMatchObject({ status: 'completed' });
    });

    it('shows an operator every job on a machine they hold, not only their own', async () => {
      await orders.raise(boss, { ...ref, title: 'Mine', assignedToUserId: operatorId });
      await orders.raise(boss, { ...ref, title: 'Somebody else\'s' });
      await orders.raise(boss, {
        sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-2', title: 'Another machine',
      });

      // Hiding a colleague's job on the same generator is how two people get sent to
      // it. The machine governs what you see; the assignment governs what you may do.
      const visible = await orders.list(operator);
      expect(visible.map((o) => o.title).sort()).toEqual(['Mine', 'Somebody else\'s']);
      expect((await orders.list(operator, { mine: true })).map((o) => o.title)).toEqual(['Mine']);
    });

    it('shows nothing to somebody assigned to no machines', async () => {
      const none: RequestScope = { ...operator, equipmentIds: [] };
      // The dangerous bug: an empty allow-list read as "no filter".
      expect(await orders.list(none)).toEqual([]);
    });
  });

  describe('working a job', () => {
    it('records what was done, and refuses to close without it', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'Oil change', assignedToUserId: operatorId });
      await orders.act(operator, order.id, 'start', null);
      await expect(orders.act(operator, order.id, 'complete', '   '))
        .rejects.toThrow(/note is required/);

      const done = await orders.act(operator, order.id, 'complete', 'Replaced filter and 20L oil');
      expect(done.status).toBe('completed');
      expect(done.resolution).toBe('Replaced filter and 20L oil');
      expect(done.startedAt).not.toBeNull();
      expect(done.endedAt).not.toBeNull();
    });

    it('clears the ending when a job is reopened', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'x' });
      await orders.act(boss, order.id, 'complete', 'done');
      const again = await orders.act(boss, order.id, 'reopen', 'wrong machine');

      // A reopened job still carrying its completion reads, on any screen and in any
      // export, as finished.
      expect(again.status).toBe('created');
      expect(again.endedAt).toBeNull();
      expect(again.resolution).toBeNull();
    });

    it('will not reassign a finished job without reopening it', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'x' });
      await orders.act(boss, order.id, 'complete', 'done');
      await expect(orders.assign(boss, order.id, operatorId))
        .rejects.toThrow(/Reopen it before reassigning/);
    });

    it('keeps a history that matches the job', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'x' });
      await orders.assign(boss, order.id, operatorId);
      await orders.act(operator, order.id, 'start', null);
      await orders.act(boss, order.id, 'cancel', 'machine went off hire');

      const history = await orders.history(boss, order.id);
      expect(history.map((h) => h.kind)).toEqual(['raised', 'assigned', 'started', 'cancelled']);
      expect(history.at(-1)).toMatchObject({
        fromStatus: 'in-progress', toStatus: 'cancelled',
        note: 'machine went off hire', actorUserId: 'u-boss',
      });
    });
  });

  describe('isolation', () => {
    it('keeps one account\'s jobs out of another', async () => {
      const order = await orders.raise(boss, { ...ref, title: 'Ours' });
      expect(await orders.list(other)).toEqual([]);
      await expect(orders.history(other, order.id)).rejects.toThrow(NotFoundException);
      await expect(orders.act(other, order.id, 'cancel', 'theirs'))
        .rejects.toThrow(NotFoundException);
    });
  });
});
