import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, QueryFailedError } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantSession } from '../../scope/tenant-session';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceCatalogService } from '../../device-catalog/services/device-catalog.service';
import { DeviceInventory, InventoryState } from '../entities/device-inventory.entity';
import { DeviceInventoryEvent } from '../entities/device-inventory-event.entity';
import { InventoryAction, inventoryTransition } from './inventory-state-machine';

export type PooledDevice = DeviceInventory & { toolMappingName: string | null };

export type AssignOutcome =
  | 'assigned'
  | 'already-in-this-account'
  | 'held-elsewhere'
  | 'retired'
  | 'unknown';

export interface BatchResult {
  imei: string;
  outcome: AssignOutcome;
}

export interface RegisterInput {
  imei: string;
  model?: string | null;
  toolMappingId?: string | null;
  batchRef?: string | null;
  receivedAt?: Date | null;
  notes?: string | null;
}

/**
 * The device pool, and the two acts that move a logger through it (task P1-19).
 *
 * Assignment is commercial and belongs to Things Alive: this device is now that
 * customer's. Claiming is physical and belongs to the customer: this device is now
 * bolted to that machine. They are separated because they happen weeks apart and by
 * different people, and a single "add device" step that did both would force a
 * customer to decide where a logger goes before it has left the warehouse.
 *
 * Batch operations report per device rather than succeeding or failing as a whole.
 * Onboarding a customer means two hundred loggers, three of which are mistyped, and
 * refusing the batch teaches whoever is doing it to retry blindly until something
 * sticks.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly ds: DataSource, private readonly deviceCatalog: DeviceCatalogService) {}

  // ---------------------------------------------------------------- platform side

  /**
   * Stock arriving. Idempotent: re-running a delivery note is the normal way this
   * gets called twice, and a duplicate IMEI is one physical device, not an error.
   */
  async register(
    scope: RequestScope, devices: RegisterInput[], now = new Date(),
  ): Promise<{ registered: number; alreadyKnown: number }> {
    this.requirePlatform(scope, 'register stock');

    return runTenantSpanning(this.ds, `inventory register by ${scope.userId}`, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      let registered = 0;
      let alreadyKnown = 0;

      for (const d of devices) {
        const imei = d.imei.trim();
        if (!imei) continue;

        const existing = await repo.findOne({ where: { imei } });
        if (existing) { alreadyKnown += 1; continue; }

        const { to } = inventoryTransition('register', null, null);
        await repo.save(repo.create({
          imei, tenantId: null, state: to,
          model: d.model ?? null, toolMappingId: d.toolMappingId ?? null, batchRef: d.batchRef ?? null,
          receivedAt: d.receivedAt ?? now, notes: d.notes ?? null,
          assignedAt: null, assignedBy: null,
          equipmentExternalId: null, claimedAt: null, claimedBy: null,
        }));
        await this.record(m, scope, imei, 'register', null, to, { tenantId: null });
        registered += 1;
      }

      return { registered, alreadyKnown };
    });
  }

  /** Hand a batch of devices to one customer. */
  async assign(
    scope: RequestScope, imeis: string[], tenantId: string, now = new Date(),
  ): Promise<BatchResult[]> {
    this.requirePlatform(scope, 'assign devices');

    return runTenantSpanning(this.ds, `inventory assign to ${tenantId} by ${scope.userId}`, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      const results: BatchResult[] = [];

      for (const raw of imeis) {
        const imei = raw.trim();
        const device = await repo.findOne({ where: { imei } });

        if (!device) { results.push({ imei, outcome: 'unknown' }); continue; }
        if (device.state === 'retired') { results.push({ imei, outcome: 'retired' }); continue; }
        if (device.state === 'assigned') {
          // Already where it was going: a no-op, and reporting it as an error would
          // make re-running a partly failed batch impossible without hand-editing it.
          results.push({
            imei,
            outcome: device.tenantId === tenantId ? 'already-in-this-account' : 'held-elsewhere',
          });
          continue;
        }

        const { to } = inventoryTransition('assign', device.state, null);
        device.state = to;
        device.tenantId = tenantId;
        device.assignedAt = now;
        device.assignedBy = scope.userId;
        await repo.save(device);
        await this.record(m, scope, imei, 'assign', 'in-stock', to, { tenantId });
        results.push({ imei, outcome: 'assigned' });
      }

      return results;
    });
  }

  /**
   * Take a device back. The customer's claim on the asset goes with it, and the
   * record of them having had it does not — that lives in the event log, which is
   * not narrowed by tenant precisely so this question stays answerable.
   */
  async release(
    scope: RequestScope, imeis: string[], reason: string, now = new Date(),
  ): Promise<BatchResult[]> {
    this.requirePlatform(scope, 'release devices');
    return this.platformTransition(scope, imeis, 'release', reason, now);
  }

  async retire(
    scope: RequestScope, imeis: string[], reason: string, now = new Date(),
  ): Promise<BatchResult[]> {
    this.requirePlatform(scope, 'retire devices');
    return this.platformTransition(scope, imeis, 'retire', reason, now);
  }

  async returnToStock(
    scope: RequestScope, imeis: string[], now = new Date(),
  ): Promise<BatchResult[]> {
    this.requirePlatform(scope, 'return devices to stock');
    return this.platformTransition(scope, imeis, 'return-to-stock', null, now);
  }

  private async platformTransition(
    scope: RequestScope, imeis: string[], action: InventoryAction,
    reason: string | null, now: Date,
  ): Promise<BatchResult[]> {
    return runTenantSpanning(this.ds, `inventory ${action} by ${scope.userId}`, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      const results: BatchResult[] = [];

      for (const raw of imeis) {
        const imei = raw.trim();
        const device = await repo.findOne({ where: { imei } });
        if (!device) { results.push({ imei, outcome: 'unknown' }); continue; }

        const from = device.state;
        let to: InventoryState;
        try {
          ({ to } = inventoryTransition(action, from, reason));
        } catch {
          // The state machine refused. Reported per device rather than thrown, so one
          // already-retired logger does not abandon the other hundred and ninety-nine.
          results.push({ imei, outcome: from === 'retired' ? 'retired' : 'held-elsewhere' });
          continue;
        }

        const losingTenant = device.tenantId;
        device.state = to;
        if (action === 'release' || action === 'retire') {
          // Fitting information goes with the device. Leaving a stale equipment id on
          // a released logger is how it later appears to be on a machine it was
          // removed from a year earlier.
          device.equipmentExternalId = null;
          device.claimedAt = null;
          device.claimedBy = null;
        }
        if (action === 'release') {
          device.tenantId = null;
          device.assignedAt = null;
          device.assignedBy = null;
        }
        await repo.save(device);
        await this.record(m, scope, imei, action, from, to, { tenantId: losingTenant, reason });
        results.push({ imei, outcome: 'assigned' });
      }

      return results;
    });
  }

  /** The whole pool, for Things Alive. Filterable by state, tenant or batch. */
  async pool(
    scope: RequestScope,
    filters: { state?: InventoryState; tenantId?: string; batchRef?: string; unassignedOnly?: boolean } = {},
  ): Promise<PooledDevice[]> {
    this.requirePlatform(scope, 'read the device pool');

    const rows = await runTenantSpanning(this.ds, `inventory pool read by ${scope.userId}`, (m) =>
      m.getRepository(DeviceInventory).find({
        where: {
          ...(filters.state ? { state: filters.state } : {}),
          ...(filters.batchRef ? { batchRef: filters.batchRef } : {}),
          ...(filters.unassignedOnly ? { tenantId: IsNull() } : filters.tenantId ? { tenantId: filters.tenantId } : {}),
        },
        order: { imei: 'ASC' },
      }),
    );

    const names = await this.deviceCatalog.resolveToolMappingNames(rows.map((r) => r.toolMappingId));
    return rows.map((r) => ({ ...r, toolMappingName: r.toolMappingId ? names.get(r.toolMappingId) ?? null : null }));
  }

  // ------------------------------------------------------------------ tenant side

  /**
   * The devices in this account.
   *
   * No tenant filter is written here. The session's policy supplies it, and an
   * unassigned device carries a null tenant, which is never equal to anything — so
   * the pool is invisible from inside an account without a rule anyone maintains.
   */
  async mine(scope: RequestScope, claimedOnly = false): Promise<DeviceInventory[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(DeviceInventory).find({
        where: claimedOnly ? { tenantId: scope.tenantId } : {},
        order: { imei: 'ASC' },
      }),
    );
  }

  /**
   * Fit a device to a machine.
   *
   * A device the account does not hold is a 404, never a 403 — whether it is in
   * stock, retired, or sitting in another customer's account. "That device belongs to
   * someone else" confirms a commercial relationship to somebody who has just typed a
   * number into a box.
   */
  async claim(
    scope: RequestScope,
    imei: string,
    equipmentExternalId: string,
    sourceSystem: string,
    now = new Date(),
  ): Promise<DeviceInventory> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      const device = await repo.findOne({ where: { imei: imei.trim() } });
      if (!device) throw new NotFoundException(`No device "${imei}" in this account.`);

      inventoryTransition('claim', device.state, null);

      // The asset has to exist here too. A claim onto an unknown external id would
      // produce a device that looks fitted and reports against nothing.
      const asset = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem, externalId: equipmentExternalId },
      });
      if (!asset) {
        throw new NotFoundException(
          `No equipment "${equipmentExternalId}" in this account. Add the asset before fitting a logger to it.`,
        );
      }

      device.equipmentExternalId = equipmentExternalId;
      device.claimedAt = now;
      device.claimedBy = scope.userId;
      const saved = await repo.save(device);
      await this.record(m, scope, device.imei, 'claim', device.state, device.state, {
        tenantId: scope.tenantId, equipmentExternalId,
      });
      return saved;
    });
  }

  /** Take a device off a machine, without giving it back. */
  async unclaim(
    scope: RequestScope, imei: string, reason: string, now = new Date(),
  ): Promise<DeviceInventory> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      const device = await repo.findOne({ where: { imei: imei.trim() } });
      if (!device) throw new NotFoundException(`No device "${imei}" in this account.`);

      inventoryTransition('unclaim', device.state, reason);
      const was = device.equipmentExternalId;
      device.equipmentExternalId = null;
      device.claimedAt = null;
      device.claimedBy = null;
      const saved = await repo.save(device);
      await this.record(m, scope, device.imei, 'unclaim', device.state, device.state, {
        tenantId: scope.tenantId, equipmentExternalId: was, reason,
      });
      // `now` is recorded by the event's own timestamp; the row keeps no "unclaimed
      // at" column because the answer lives in the history and would drift here.
      void now;
      return saved;
    });
  }

  /** Where this device has been, across every account that has held it. */
  async historyFor(scope: RequestScope, imei: string): Promise<DeviceInventoryEvent[]> {
    this.requirePlatform(scope, "read a device's full history");
    return runTenantSpanning(this.ds, `inventory history read by ${scope.userId}`, async (m) => {
      const repo = m.getRepository(DeviceInventoryEvent);
      // A corrected IMEI keeps its registration under the number it was typed as: the
      // log is append-only. Each correction names the IMEI before it, so walk back.
      const imeis = [imei.trim()];
      for (let i = 0; i < imeis.length; i += 1) {
        const corrections = await repo.find({ where: { imei: imeis[i], action: 'correct-imei' } });
        for (const c of corrections) if (c.previousImei && !imeis.includes(c.previousImei)) imeis.push(c.previousImei);
      }
      return repo.find({ where: { imei: In(imeis) }, order: { at: 'ASC' } });
    });
  }

  // ----------------------------------------------------------------------- shared

  /**
   * Corrects what was typed at registration: model, tool profile, batch, notes. None
   * of it moves custody, so nothing is written to the event history — that log is where
   * a device has been, and an edit to its label is not a place.
   *
   * The tool profile is fixed once the device leaves stock: a client's machine may
   * already be bound to signals that profile declared, and changing it underneath
   * them is a different act from correcting a delivery note.
   *
   * The IMEI itself can be corrected while the device has never been anywhere
   * (TC_152); the database holds that rule (ImeiCorrection), and the correction is the
   * one edit that is recorded, because the device is now known by another number.
   */
  async updateDevice(
    scope: RequestScope, imei: string,
    patch: { imei?: string; model?: string | null; toolMappingId?: string | null; batchRef?: string | null; notes?: string | null },
  ): Promise<DeviceInventory> {
    this.requirePlatform(scope, 'edit devices');
    return runTenantSpanning(this.ds, `inventory edit by ${scope.userId}`, async (m) => {
      const repo = m.getRepository(DeviceInventory);
      // Locked: an assign arriving at the same moment waits, then the database judges
      // the correction against the state it left.
      const device = await repo.findOne({ where: { imei: imei.trim() }, lock: { mode: 'pessimistic_write' } });
      if (!device) throw new NotFoundException(`No device with IMEI "${imei}".`);
      const newImei = patch.imei?.trim();
      const correcting = newImei !== undefined && newImei !== device.imei;
      if (correcting && !newImei) throw new BadRequestException('An IMEI cannot be blank.');
      if (correcting && (device.state !== 'in-stock' || device.tenantId !== null)) {
        throw new BadRequestException(
          `Device ${device.imei} is ${device.tenantId ? 'assigned to a client' : device.state}; its IMEI can only be corrected while it has never left stock.`,
        );
      }
      const previousImei = device.imei;
      if (patch.toolMappingId !== undefined && patch.toolMappingId !== device.toolMappingId && device.state !== 'in-stock') {
        throw new BadRequestException(
          `Device ${device.imei} is ${device.state}; its tool profile can only change while it is in stock.`,
        );
      }
      const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
      const model = text(patch.model); const batchRef = text(patch.batchRef); const notes = text(patch.notes);
      if (model !== undefined) device.model = model;
      if (batchRef !== undefined) device.batchRef = batchRef;
      if (notes !== undefined) device.notes = notes;
      if (patch.toolMappingId !== undefined) device.toolMappingId = patch.toolMappingId;
      if (correcting) device.imei = newImei;
      try {
        const saved = await repo.save(device);
        if (correcting) {
          await this.record(m, scope, saved.imei, 'correct-imei', 'in-stock', 'in-stock',
            { tenantId: null, previousImei, reason: `IMEI corrected from ${previousImei}` });
        }
        return saved;
      } catch (err) {
        const e = err as QueryFailedError & { code?: string; constraint?: string; driverError?: { message?: string } };
        if (err instanceof QueryFailedError && e.code === '23503') {
          throw new BadRequestException(`No tool mapping "${patch.toolMappingId}".`);
        }
        if (err instanceof QueryFailedError && e.code === '23505') {
          throw new BadRequestException(`IMEI "${newImei}" is already in the inventory.`);
        }
        if (err instanceof QueryFailedError && e.code === '23514' && e.constraint === 'ck_imei_fixed_once_used') {
          throw new BadRequestException(e.driverError?.message ?? err.message);
        }
        throw err;
      }
    });
  }

  private requirePlatform(scope: RequestScope, what: string): void {
    if (!scope.isPlatformRole) {
      throw new ForbiddenException(`Only Things Alive can ${what}.`);
    }
  }

  private async record(
    m: EntityManager,
    scope: RequestScope,
    imei: string,
    action: InventoryAction,
    fromState: InventoryState | null,
    toState: InventoryState,
    extra: { tenantId: string | null; equipmentExternalId?: string | null; reason?: string | null; previousImei?: string | null },
  ): Promise<void> {
    const repo = m.getRepository(DeviceInventoryEvent);
    await repo.save(repo.create({
      imei, action, fromState, toState,
      tenantId: extra.tenantId,
      equipmentExternalId: extra.equipmentExternalId ?? null,
      reason: extra.reason ?? null,
      previousImei: extra.previousImei ?? null,
      actorUserId: scope.userId,
      actorRoles: [...scope.roles],
    }));
  }
}
