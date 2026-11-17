import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { EquipmentProjection } from '../../projection/entities/equipment-projection.entity';
import { runTenantSpanning } from '../../scope/tenant-session';
import { DeviceInventoryEvent } from '../entities/device-inventory-event.entity';
import { DeviceInventory } from '../entities/device-inventory.entity';

export type ConflictReason =
  | 'held_by_another_account' | 'retired' | 'claimed_to_another_machine' | 'machine_not_in_projection';

export interface OnboardingPlan {
  tenantId: string;
  /** 1.0 machines 2.0 has no register row for. Created `origin: 'mirrored'`, unclassified. */
  createMachines: { sourceSystem: string; externalId: string; name: string | null }[];
  /** 1.0 loggers 2.0 has never seen: registered, assigned to this account and claimed. */
  registerDevices: { imei: string; sourceSystem: string; equipmentExternalId: string }[];
  /** Loggers already in this account but on no machine: claimed onto the one 1.0 says. */
  claimDevices: { imei: string; sourceSystem: string; equipmentExternalId: string }[];
  /** Already where 1.0 says. Nothing to do. */
  alreadyOnboarded: number;
  /** Listed, never resolved: each is a decision somebody has to make. */
  conflicts: { imei: string; equipmentExternalId: string; reason: ConflictReason; detail: string }[];
}

export interface OnboardingResult extends OnboardingPlan {
  applied: true;
}

/** Who an onboarding is recorded against: a staff member, or the fleet sync itself. */
interface Actor { userId: string; roles: readonly string[] }

/**
 * The fleet sync's own name in the inventory history. Not a user id, so it can never be
 * mistaken for one, and every row it wrote can be found by it.
 */
export const FLEET_SYNC_ACTOR: Actor = { userId: 'system:legacy-fleet-sync', roles: [] };

/**
 * Bulk-registering an existing 1.0 fleet (task QONBOARD1).
 *
 * A customer migrating from 1.0 already has machines and loggers in the mirror, and
 * none of it in 2.0's register: no `equipment_profile`, no `device_inventory`, so
 * binding discovery — which starts from inventory (QFIX-DEVICES) — finds nothing, and
 * every reader that asks the bindings (QFIX-DEVICES-2) sees no devices. This fills the
 * register from the projections so discovery can run. It does not bind: which signal a
 * channel carries is still approved per machine, through discovery.
 *
 * Platform staff only, like registering and assigning stock. A plan first, then apply:
 * apply recomputes the plan inside its own transaction rather than trusting one read
 * earlier, so it does what the data says at that moment. It only ever adds — a row the
 * account already has is never touched — and a conflict is reported, never resolved.
 */
@Injectable()
export class FleetOnboardingService {
  constructor(private readonly ds: DataSource) {}

  async plan(scope: RequestScope, tenantId: string): Promise<OnboardingPlan> {
    this.requirePlatform(scope);
    return runTenantSpanning(this.ds, `fleet onboarding plan for ${tenantId} by ${scope.userId}`, (m) =>
      this.build(m, tenantId));
  }

  async apply(scope: RequestScope, tenantId: string, now = new Date()): Promise<OnboardingResult> {
    this.requirePlatform(scope);
    return this.applyAs({ userId: scope.userId, roles: scope.roles }, tenantId, now);
  }

  /**
   * The same apply, run by the 1.0 fleet sync after each pass rather than by a person.
   *
   * A device mapped to a machine in 1.0 is mapped (17 Nov 2026): it has to show as mapped
   * in 2.0 without somebody remembering to press apply. Every reader that decides whether
   * a machine is onboarded asks 2.0's register, so a mapping that waits for a manual
   * apply is a machine shown "not onboarded" while 1.0 reports on it. Safe to run
   * unattended for the reason apply already was: it only adds, and leaves conflicts for
   * a person.
   */
  async applyForSync(tenantId: string, now = new Date()): Promise<OnboardingResult> {
    return this.applyAs(FLEET_SYNC_ACTOR, tenantId, now);
  }

  private async applyAs(actor: Actor, tenantId: string, now: Date): Promise<OnboardingResult> {
    return runTenantSpanning(this.ds, `fleet onboarding apply for ${tenantId} by ${actor.userId}`, async (m) => {
      // One onboarding per account at a time. Two at once would both see a device as
      // unregistered and the second insert would fail on the IMEI — or worse, both
      // would create the same machine. The lock makes the second wait and find nothing.
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('fleet-onboarding:' || $1, 0))`, [tenantId]);
      const plan = await this.build(m, tenantId);

      const profiles = m.getRepository(EquipmentProfile);
      for (const machine of plan.createMachines) {
        await profiles.save(profiles.create({
          tenantId, sourceSystem: machine.sourceSystem, externalId: machine.externalId, name: machine.name,
          origin: 'mirrored', updatedBy: actor.userId,
        }));
      }

      const inventory = m.getRepository(DeviceInventory);
      for (const d of plan.registerDevices) {
        await inventory.save(inventory.create({
          imei: d.imei, tenantId, state: 'assigned', model: null, toolMappingId: null,
          batchRef: 'fleet-onboarding', receivedAt: now, notes: 'Registered from the 1.0 fleet (QONBOARD1).',
          assignedAt: now, assignedBy: actor.userId,
          equipmentExternalId: d.equipmentExternalId, claimedAt: now, claimedBy: actor.userId,
        }));
        // The same three events a device walked through by hand would leave.
        await this.record(m, actor, d.imei, 'register', null, 'in-stock', null, null);
        await this.record(m, actor, d.imei, 'assign', 'in-stock', 'assigned', tenantId, null);
        await this.record(m, actor, d.imei, 'claim', 'assigned', 'assigned', tenantId, d.equipmentExternalId);
      }
      for (const d of plan.claimDevices) {
        await inventory.update({ imei: d.imei, tenantId, equipmentExternalId: IsNull() }, {
          equipmentExternalId: d.equipmentExternalId, claimedAt: now, claimedBy: actor.userId,
        });
        await this.record(m, actor, d.imei, 'claim', 'assigned', 'assigned', tenantId, d.equipmentExternalId);
      }
      return { ...plan, applied: true };
    });
  }

  /** What 1.0 says against what 2.0 has, for one account. Read-only. */
  private async build(m: EntityManager, tenantId: string): Promise<OnboardingPlan> {
    const [machines, devices, profiles] = await Promise.all([
      // Live rows only. The mirror keeps what 1.0 deleted, marked missing; onboarding it
      // would bring back a machine or a fitment 1.0 has taken away.
      m.getRepository(EquipmentProjection).find({ where: { tenantId, status: 'live' }, order: { externalId: 'ASC' } }),
      m.getRepository(DeviceProjection).find({ where: { tenantId, status: 'live' }, order: { imei: 'ASC' } }),
      m.getRepository(EquipmentProfile).find({ where: { tenantId } }),
    ]);
    const key = (sourceSystem: string, externalId: string) => `${sourceSystem}/${externalId}`;
    const registered = new Set(profiles.map((p) => key(p.sourceSystem, p.externalId)));
    const mirrored = new Set(machines.map((p) => key(p.sourceSystem, p.externalId)));

    const plan: OnboardingPlan = {
      tenantId, createMachines: [], registerDevices: [], claimDevices: [], alreadyOnboarded: 0, conflicts: [],
    };
    for (const machine of machines) {
      if (registered.has(key(machine.sourceSystem, machine.externalId))) continue;
      plan.createMachines.push({ sourceSystem: machine.sourceSystem, externalId: machine.externalId, name: machine.name });
    }

    const fitted = devices.filter((d) => d.equipmentExternalId);
    const inventory = fitted.length
      ? await m.getRepository(DeviceInventory).createQueryBuilder('i')
        .where('i.imei IN (:...imeis)', { imeis: [...new Set(fitted.map((d) => d.imei))] }).getMany()
      : [];
    const byImei = new Map(inventory.map((i) => [i.imei, i]));

    const seen = new Set<string>();
    for (const d of fitted) {
      if (seen.has(d.imei)) continue;
      seen.add(d.imei);
      const machine = d.equipmentExternalId!;
      const target = { imei: d.imei, sourceSystem: d.sourceSystem, equipmentExternalId: machine };
      const conflict = (reason: ConflictReason, detail: string) =>
        plan.conflicts.push({ imei: d.imei, equipmentExternalId: machine, reason, detail });

      // A logger 1.0 puts on a machine 1.0 itself does not list is a mirror out of step,
      // not a machine to invent.
      if (!mirrored.has(key(d.sourceSystem, machine)) && !registered.has(key(d.sourceSystem, machine))) {
        conflict('machine_not_in_projection', `1.0 fits this logger to "${machine}", which neither 1.0 nor 2.0 lists as a machine.`);
        continue;
      }
      const held = byImei.get(d.imei);
      if (!held) { plan.registerDevices.push(target); continue; }
      if (held.state === 'retired') { conflict('retired', 'Retired in 2.0 inventory; bringing it back is a decision, not a sync.'); continue; }
      if (held.tenantId !== tenantId) {
        conflict('held_by_another_account', held.tenantId
          ? 'Assigned to another account in 2.0.' : 'In 2.0 stock, not assigned to this account.');
        continue;
      }
      if (!held.equipmentExternalId) { plan.claimDevices.push(target); continue; }
      if (held.equipmentExternalId === machine) { plan.alreadyOnboarded += 1; continue; }
      conflict('claimed_to_another_machine', `Claimed to "${held.equipmentExternalId}" in 2.0; 1.0 says "${machine}".`);
    }
    return plan;
  }

  private async record(
    m: EntityManager, actor: Actor, imei: string, action: 'register' | 'assign' | 'claim',
    fromState: 'in-stock' | 'assigned' | null, toState: 'in-stock' | 'assigned',
    tenantId: string | null, equipmentExternalId: string | null,
  ): Promise<void> {
    const repo = m.getRepository(DeviceInventoryEvent);
    await repo.save(repo.create({
      imei, action, fromState, toState, tenantId, equipmentExternalId,
      reason: actor === FLEET_SYNC_ACTOR ? 'QONBOARD1 fleet onboarding, after a 1.0 fleet sync' : 'QONBOARD1 fleet onboarding',
      actorUserId: actor.userId, actorRoles: [...actor.roles],
    }));
  }

  private requirePlatform(scope: RequestScope): void {
    if (!scope.isPlatformRole) throw new ForbiddenException('Only Things Alive can onboard a 1.0 fleet.');
  }
}
