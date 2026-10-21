import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { DeviceInventoryEvent } from '../src/inventory/entities/device-inventory-event.entity';
import { InventoryService } from '../src/inventory/services/inventory.service';
import { INVENTORY_TRANSITIONS, inventoryTransition } from '../src/inventory/services/inventory-state-machine';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The device pool (task P1-19).
 *
 * The transition table is walked without a database, as with activation. Everything
 * else needs Postgres, and one test in particular could not exist anywhere else: the
 * proof that an unassigned device is invisible from inside an account is a claim
 * about how a policy treats a null, and only Postgres can be asked.
 */
describe('inventory state machine', () => {
  it('refuses every movement the table does not allow', () => {
    const states = ['in-stock', 'assigned', 'retired'] as const;
    const actions = Object.keys(INVENTORY_TRANSITIONS) as (keyof typeof INVENTORY_TRANSITIONS)[];

    for (const action of actions) {
      for (const from of states) {
        const allowed = INVENTORY_TRANSITIONS[action].from.includes(from);
        const attempt = () => inventoryTransition(action, from, 'a reason');
        if (allowed) {
          const expected = INVENTORY_TRANSITIONS[action].to;
          expect(attempt().to).toBe(expected === 'same' ? from : expected);
        } else {
          expect(attempt).toThrow(BadRequestException);
        }
      }
    }
  });

  it('will not move a device between customers without passing through stock', () => {
    // Assign only works from in-stock. Reassigning straight from one account to
    // another would make the release — the decision somebody is accountable for —
    // an invisible side effect.
    expect(INVENTORY_TRANSITIONS.assign.from).toEqual(['in-stock']);
    expect(() => inventoryTransition('assign', 'assigned', null))
      .toThrow(/Cannot assign a device that is "assigned"/);
  });

  it('demands a reason for every movement that takes something away', () => {
    expect(() => inventoryTransition('release', 'assigned', ' ')).toThrow(/reason is required/);
    expect(() => inventoryTransition('retire', 'in-stock', undefined)).toThrow(/reason is required/);
    expect(() => inventoryTransition('unclaim', 'assigned', '')).toThrow(/reason is required/);
    // Giving somebody a device needs no excuse.
    expect(() => inventoryTransition('assign', 'in-stock', undefined)).not.toThrow();
  });

  it('says what to do when the device is not in the inventory at all', () => {
    expect(() => inventoryTransition('assign', null, null)).toThrow(/Register it first/);
    expect(() => inventoryTransition('register', 'in-stock', null)).toThrow(/already in the inventory/);
  });
});

describeDb('device inventory', () => {
  let ds: DataSource;
  let owner: DataSource;
  let inventory: InventoryService;

  const SOURCE = 'iot-platform-1';
  const NOW = new Date('2026-09-13T00:00:00.000Z');

  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const acme: RequestScope = {
    tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false,
  };
  const globex: RequestScope = {
    tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false,
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    inventory = new InventoryService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['device_inventory_event', 'device_inventory', 'equipment_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await inventory.register(master, [
      { imei: 'imei-1', model: 'TA-200', batchRef: 'PO-88' },
      { imei: 'imei-2', model: 'TA-200', batchRef: 'PO-88' },
      { imei: 'imei-3', model: 'TA-200', batchRef: 'PO-89' },
    ], NOW);
  });

  const addAsset = (tenantId: string, externalId: string) =>
    runTenantSpanning(owner, 'test fixture', (m) =>
      m.getRepository(EquipmentProfile).save({
        tenantId, sourceSystem: SOURCE, externalId,
        equipmentClassSlug: null, classVersion: null, tier: 'basic' as const,
        commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
      }));

  describe('the pool', () => {
    it('registers stock once, however many times the delivery note is re-run', async () => {
      const again = await inventory.register(master, [{ imei: 'imei-1' }, { imei: 'imei-9' }], NOW);
      expect(again).toEqual({ registered: 1, alreadyKnown: 1 });
      expect(await owner.getRepository(DeviceInventory).count()).toBe(4);
    });

    it('keeps unassigned stock invisible inside every account', async () => {
      // The point of the whole table shape. No tenant filter is written anywhere in
      // `mine`; the policy compares a null tenant to the session's, and in SQL a null
      // is never equal to anything. Anyone who "fixes" this by adding
      // `OR tenant_id IS NULL` has removed the protection and nothing will fail.
      expect(await inventory.mine(acme)).toEqual([]);
      expect(await inventory.mine(globex)).toEqual([]);
      expect(await inventory.pool(master)).toHaveLength(3);
    });

    it('refuses to let a customer near the pool at all', async () => {
      await expect(inventory.pool(acme)).rejects.toThrow(ForbiddenException);
      await expect(inventory.register(acme, [{ imei: 'imei-x' }])).rejects.toThrow(ForbiddenException);
      await expect(inventory.assign(acme, ['imei-1'], 'acme')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('assignment', () => {
    it('hands devices to one account and makes them visible only there', async () => {
      const results = await inventory.assign(master, ['imei-1', 'imei-2'], 'acme', NOW);
      expect(results).toEqual([
        { imei: 'imei-1', outcome: 'assigned' },
        { imei: 'imei-2', outcome: 'assigned' },
      ]);

      expect((await inventory.mine(acme)).map((d) => d.imei)).toEqual(['imei-1', 'imei-2']);
      expect(await inventory.mine(globex)).toEqual([]);
    });

    it('reports per device rather than abandoning the batch', async () => {
      await inventory.assign(master, ['imei-2'], 'globex', NOW);
      await inventory.retire(master, ['imei-3'], 'water ingress', NOW);

      const results = await inventory.assign(
        master, ['imei-1', 'imei-2', 'imei-3', 'imei-nope'], 'acme', NOW,
      );

      // Onboarding a customer means two hundred loggers, three of them mistyped.
      // Refusing the batch teaches whoever is doing it to retry blindly.
      expect(results).toEqual([
        { imei: 'imei-1', outcome: 'assigned' },
        { imei: 'imei-2', outcome: 'held-elsewhere' },
        { imei: 'imei-3', outcome: 'retired' },
        { imei: 'imei-nope', outcome: 'unknown' },
      ]);
    });

    it('treats re-assigning to the same account as the no-op it is', async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      const again = await inventory.assign(master, ['imei-1'], 'acme', NOW);
      expect(again).toEqual([{ imei: 'imei-1', outcome: 'already-in-this-account' }]);
      // Re-running a partly failed batch has to be possible without hand-editing it.
      expect((await inventory.mine(acme))).toHaveLength(1);
    });

    it('releases a device back to stock and out of the account', async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      await inventory.release(master, ['imei-1'], 'contract ended', NOW);

      expect(await inventory.mine(acme)).toEqual([]);
      const [device] = await inventory.pool(master, { unassignedOnly: true, state: 'in-stock' });
      expect(device.tenantId).toBeNull();
      expect(device.assignedBy).toBeNull();
    });
  });

  describe('claiming', () => {
    beforeEach(async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      await addAsset('acme', 'DG-1');
    });

    it('fits a device to a machine in the same account', async () => {
      const claimed = await inventory.claim(acme, 'imei-1', 'DG-1', SOURCE, NOW);
      expect(claimed.equipmentExternalId).toBe('DG-1');
      expect(claimed.claimedBy).toBe('u-acme');
      // Still assigned: fitting is not a change of ownership.
      expect(claimed.state).toBe('assigned');
    });

    it('refuses a machine the account does not have, and says what to do', async () => {
      await expect(inventory.claim(acme, 'imei-1', 'DG-NOPE', SOURCE, NOW))
        .rejects.toThrow(/Add the asset before fitting a logger to it/);
    });

    it('tells a customer a device they do not hold is simply not there', async () => {
      // imei-2 is in stock; imei-3 could be another customer's. Both answers are the
      // same, because "that belongs to someone else" confirms a commercial
      // relationship to whoever has just typed a number into a box.
      await inventory.assign(master, ['imei-3'], 'globex', NOW);
      await expect(inventory.claim(acme, 'imei-2', 'DG-1', SOURCE, NOW)).rejects.toThrow(NotFoundException);
      await expect(inventory.claim(acme, 'imei-3', 'DG-1', SOURCE, NOW)).rejects.toThrow(NotFoundException);
    });

    it('cannot fit a device onto another account\'s machine', async () => {
      await addAsset('globex', 'GX-1');
      // The asset lookup runs in acme's session, so globex's machine does not exist
      // from here — the isolation does the work, not a comparison somebody wrote.
      await expect(inventory.claim(acme, 'imei-1', 'GX-1', SOURCE, NOW)).rejects.toThrow(NotFoundException);
    });

    it('unfits a device without giving it back', async () => {
      await inventory.claim(acme, 'imei-1', 'DG-1', SOURCE, NOW);
      const off = await inventory.unclaim(acme, 'imei-1', 'engine swapped out', NOW);
      expect(off.equipmentExternalId).toBeNull();
      expect(off.state).toBe('assigned');
      expect((await inventory.mine(acme))).toHaveLength(1);
    });

    it('takes the fitting with the device when it is released', async () => {
      await inventory.claim(acme, 'imei-1', 'DG-1', SOURCE, NOW);
      await inventory.release(master, ['imei-1'], 'returned', NOW);

      const [device] = await inventory.pool(master, { unassignedOnly: true });
      // A stale equipment id on a released logger is how it later appears to be on a
      // machine it was removed from a year earlier.
      expect(device.equipmentExternalId).toBeNull();
      expect(device.claimedBy).toBeNull();
    });
  });

  describe('the movement record', () => {
    it('follows one device across accounts, which is the view worth having', async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      await inventory.release(master, ['imei-1'], 'contract ended', NOW);
      await inventory.assign(master, ['imei-1'], 'globex', NOW);

      const history = await inventory.historyFor(master, 'imei-1');
      expect(history.map((e) => e.action)).toEqual(['register', 'assign', 'release', 'assign']);
      expect(history.map((e) => e.tenantId)).toEqual([null, 'acme', 'acme', 'globex']);
      // The release is attributed to the account that lost the device, not to nobody.
      expect(history[2].reason).toBe('contract ended');
      expect(history[2].actorUserId).toBe('u-master');
    });

    it('shows a customer their own movements and no others', async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      await inventory.assign(master, ['imei-2'], 'globex', NOW);

      // Through the real session helper. Setting ta.tenant_id with a bare query and
      // then reading on a second call is a test of connection-pool luck: the value is
      // session-local, the pool may hand back a different connection, and the read
      // then returns nothing — which an `every()` over an empty array reports as a
      // pass. The transaction is what makes the setting and the read the same session.
      const theirs = await withTenantId(ds, 'acme', (m) =>
        m.getRepository(DeviceInventoryEvent).find({ order: { at: 'ASC' } }));

      // Registration happened while the device was in stock and carries no tenant, so
      // it is invisible here for the same reason the pool is.
      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs.every((e) => e.tenantId === 'acme')).toBe(true);
      expect(theirs.map((e) => e.imei)).toEqual(['imei-1']);
    });

    it('is a record, so nothing can edit it', async () => {
      await inventory.assign(master, ['imei-1'], 'acme', NOW);
      await expect(
        ds.query(`UPDATE "device_inventory_event" SET "reason" = 'rewritten'`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        ds.query(`DELETE FROM "device_inventory_event"`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
