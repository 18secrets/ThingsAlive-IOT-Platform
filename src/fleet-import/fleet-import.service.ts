import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentPlacementEvent } from '../equipment/entities/equipment-placement-event.entity';
import { Plant } from '../equipment/entities/plant.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../equipment/equipment-profile.entity';
import { CODE_PATTERN, pinnedClassVersion } from '../equipment/services/equipment.service';
import { DeviceInventoryEvent } from '../inventory/entities/device-inventory-event.entity';
import { DeviceInventory } from '../inventory/entities/device-inventory.entity';
import { withTenantId } from '../scope/tenant-session';
import { ParsedFleetWorkbook, parseFleetWorkbook } from './fleet-workbook';

export interface EquipmentToCreate {
  row: number;
  code: string;
  name: string;
  plantId: string | null;
  siteCode: string | null;
  equipmentClassSlug: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  description: string | null;
  commissionedAt: string | null;
  serviceIntervalHours: number | null;
}

export type DeviceConflictReason = 'not_in_this_account' | 'not_assigned' | 'claimed_to_another_machine';

export interface FleetImportPlan {
  tenantId: string;
  /** False while any row has an error. Apply refuses the whole workbook until it is true. */
  canApply: boolean;
  equipment: {
    create: EquipmentToCreate[];
    /** Already in the register with exactly these values. Nothing to do. */
    unchanged: number;
    /** Already in the register with different values. Listed, never overwritten. */
    conflicts: { row: number; code: string; fields: string[]; detail: string }[];
    errors: { row: number; message: string }[];
  };
  devices: {
    claim: { row: number; imei: string; sourceSystem: string; equipmentCode: string }[];
    alreadyClaimed: number;
    conflicts: { row: number; imei: string; reason: DeviceConflictReason; detail: string }[];
    errors: { row: number; message: string }[];
  };
}

export interface FleetImportResult extends FleetImportPlan {
  applied: true;
}

/**
 * Bulk upload of equipment and devices from Excel (UI feature "bulk upload", no task
 * id in the register before this one).
 *
 * The same contract as 1.0 fleet onboarding (QONBOARD1), with a workbook instead of
 * the mirror as the source: a plan that writes nothing, then an apply that rebuilds
 * the plan inside its own transaction rather than trusting the one the person read,
 * so it does what the data says at that moment. It only adds. A machine that already
 * exists with different values is a conflict to list, not an edit to make — a
 * spreadsheet exported last month and uploaded today would otherwise quietly undo
 * every change made in between.
 *
 * Errors and conflicts are treated differently on purpose. An error is a row this
 * workbook got wrong (a bad code, a site that does not exist), and applying around it
 * would leave the person fixing a half-imported fleet; so any error refuses the whole
 * apply. A conflict is the register disagreeing with a correct row, and that is
 * somebody's decision — the rest still applies.
 *
 * No batch is stored. The workbook is the batch: uploading it again is how you retry,
 * and a second apply of the same file finds everything unchanged.
 */
@Injectable()
export class FleetImportService {
  constructor(private readonly ds: DataSource) {}

  async plan(scope: RequestScope, buffer: Buffer, onBehalfOfTenantId?: string): Promise<FleetImportPlan> {
    const tenantId = this.resolveTenant(scope, onBehalfOfTenantId);
    const workbook = await parseFleetWorkbook(buffer);
    this.requireClaimRight(scope, workbook);
    return withTenantId(this.ds, tenantId, (m) => this.build(m, tenantId, workbook));
  }

  async apply(
    scope: RequestScope, buffer: Buffer, onBehalfOfTenantId?: string, now = new Date(),
  ): Promise<FleetImportResult> {
    const tenantId = this.resolveTenant(scope, onBehalfOfTenantId);
    const workbook = await parseFleetWorkbook(buffer);
    this.requireClaimRight(scope, workbook);

    return withTenantId(this.ds, tenantId, async (m) => {
      // One import per account at a time. Two uploads of the same workbook would both
      // plan the same machine as new, and the second insert would fail on the unique
      // index halfway through. Waiting here means the second finds it done.
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('fleet-import:' || $1, 0))`, [tenantId]);
      const plan = await this.build(m, tenantId, workbook);
      if (!plan.canApply) {
        throw new BadRequestException({
          message: 'The workbook has row errors. Nothing was imported; fix them and upload again.',
          plan,
        });
      }

      const profiles = m.getRepository(EquipmentProfile);
      const placements = m.getRepository(EquipmentPlacementEvent);
      for (const e of plan.equipment.create) {
        await profiles.insert(profiles.create({
          tenantId, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: e.code, origin: 'client', status: 'active',
          name: e.name, manufacturer: e.manufacturer, modelNumber: e.modelNumber, serialNumber: e.serialNumber,
          description: e.description, plantId: e.plantId, equipmentClassSlug: e.equipmentClassSlug,
          classVersion: await pinnedClassVersion(m, tenantId, e.equipmentClassSlug), tier: 'basic',
          commissionedAt: e.commissionedAt ? new Date(e.commissionedAt) : null,
          serviceIntervalHours: e.serviceIntervalHours, readiness: {},
          createdBy: scope.userId, updatedBy: scope.userId,
        }));
        // A placement is what a site manager's view is derived from, so a machine that
        // arrives at a site arrives with the record of it, as one created by hand does.
        if (e.plantId) {
          await placements.insert(placements.create({
            tenantId, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: e.code,
            fromPlantId: null, toPlantId: e.plantId, reason: 'fleet import', actorUserId: scope.userId,
          }));
        }
      }

      const inventory = m.getRepository(DeviceInventory);
      const events = m.getRepository(DeviceInventoryEvent);
      for (const d of plan.devices.claim) {
        // Conditional on still being free. The advisory lock serialises imports, not a
        // claim made by hand on the device screen between our read and this write.
        const res = await inventory.update(
          { imei: d.imei, tenantId, state: 'assigned', equipmentExternalId: IsNull() },
          { equipmentExternalId: d.equipmentCode, claimedAt: now, claimedBy: scope.userId },
        );
        if (!res.affected) {
          throw new ConflictException(
            `Logger ${d.imei} (row ${d.row}) changed while importing. Nothing was imported; upload again.`,
          );
        }
        await events.insert(events.create({
          imei: d.imei, action: 'claim', fromState: 'assigned', toState: 'assigned', tenantId,
          equipmentExternalId: d.equipmentCode, reason: 'fleet import',
          actorUserId: scope.userId, actorRoles: [...scope.roles],
        }));
      }
      return { ...plan, applied: true as const };
    });
  }

  /** What the workbook says against what the register has. Read-only. */
  private async build(m: EntityManager, tenantId: string, workbook: ParsedFleetWorkbook): Promise<FleetImportPlan> {
    const plan: FleetImportPlan = {
      tenantId, canApply: false,
      equipment: { create: [], unchanged: 0, conflicts: [], errors: [] },
      devices: { claim: [], alreadyClaimed: 0, conflicts: [], errors: [] },
    };

    const [plants, profiles] = await Promise.all([
      m.getRepository(Plant).find({ where: { tenantId } }),
      m.getRepository(EquipmentProfile).find({ where: { tenantId } }),
    ]);
    const plantByCode = new Map(plants.map((p) => [p.code.toLowerCase(), p]));
    const key = (sourceSystem: string, externalId: string) => `${sourceSystem}/${externalId}`;
    const profileByKey = new Map(profiles.map((p) => [key(p.sourceSystem, p.externalId), p]));

    // Machines this workbook will make, so a logger row can point at one in the same
    // upload. Only rows without errors count: a logger on a machine that will not be
    // created is an error of its own.
    const willExist = new Set<string>();
    const seenCodes = new Set<string>();
    for (const { row, values: v } of workbook.equipment) {
      const fail = (message: string) => plan.equipment.errors.push({ row, message });
      if (!CODE_PATTERN.test(v.code)) {
        fail(`Code "${v.code}" is not valid: letters, digits, dots, hyphens or underscores, up to 64 characters.`);
        continue;
      }
      if (seenCodes.has(v.code)) { fail(`Code "${v.code}" appears more than once in this sheet.`); continue; }
      seenCodes.add(v.code);
      if (!v.name) { fail('Name is required.'); continue; }

      let plant: Plant | undefined;
      if (v.site) {
        plant = plantByCode.get(v.site.toLowerCase());
        if (!plant) { fail(`No site "${v.site}" in this account. Set the site up first.`); continue; }
        if (plant.status === 'retired') { fail(`Site "${plant.name}" is closed. Reopen it first.`); continue; }
      }
      let commissionedAt: string | null = null;
      if (v.commissionedAt) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.commissionedAt) || Number.isNaN(Date.parse(v.commissionedAt))) {
          fail(`Commissioned "${v.commissionedAt}" is not a date (YYYY-MM-DD).`);
          continue;
        }
        commissionedAt = v.commissionedAt;
      }
      let serviceIntervalHours: number | null = null;
      if (v.serviceIntervalHours) {
        const n = Number(v.serviceIntervalHours);
        if (!Number.isInteger(n) || n <= 0) {
          fail(`Service interval "${v.serviceIntervalHours}" is not a whole number of hours above zero.`);
          continue;
        }
        serviceIntervalHours = n;
      }

      const wanted: EquipmentToCreate = {
        row, code: v.code, name: v.name, plantId: plant?.id ?? null, siteCode: plant?.code ?? null,
        equipmentClassSlug: v.classSlug || null, manufacturer: v.manufacturer || null,
        modelNumber: v.modelNumber || null, serialNumber: v.serialNumber || null,
        description: v.description || null, commissionedAt, serviceIntervalHours,
      };
      const existing = profileByKey.get(key(CLIENT_SOURCE_SYSTEM, v.code));
      willExist.add(key(CLIENT_SOURCE_SYSTEM, v.code));
      if (!existing) { plan.equipment.create.push(wanted); continue; }

      const fields = differingFields(existing, wanted);
      if (existing.status === 'retired') {
        plan.equipment.conflicts.push({
          row, code: v.code, fields, detail: 'Retired in the register. Bringing it back is a decision, not an import.',
        });
      } else if (fields.length) {
        plan.equipment.conflicts.push({
          row, code: v.code, fields,
          detail: `Already in the register with a different ${fields.join(', ')}. Change it on the machine itself.`,
        });
      } else {
        plan.equipment.unchanged += 1;
      }
    }

    const imeis = [...new Set(workbook.devices.map((d) => d.values.imei).filter(Boolean))];
    // Filtered by account here as well as by row-level security: "not in this account"
    // is an answer this plan gives, and it should not depend on a policy to be right.
    const held = imeis.length
      ? await m.getRepository(DeviceInventory).find({ where: { imei: In(imeis), tenantId } })
      : [];
    const heldByImei = new Map(held.map((d) => [d.imei, d]));

    const seenImeis = new Set<string>();
    for (const { row, values: v } of workbook.devices) {
      const fail = (message: string) => plan.devices.errors.push({ row, message });
      if (!v.imei) { fail('IMEI is required.'); continue; }
      if (!v.equipmentCode) { fail('Equipment code is required.'); continue; }
      if (seenImeis.has(v.imei)) { fail(`IMEI ${v.imei} appears more than once in this sheet.`); continue; }
      seenImeis.add(v.imei);

      const sourceSystem = v.sourceSystem || CLIENT_SOURCE_SYSTEM;
      const machineKey = key(sourceSystem, v.equipmentCode);
      const machine = profileByKey.get(machineKey);
      if (!willExist.has(machineKey) && (!machine || machine.status === 'retired')) {
        fail(`No machine "${v.equipmentCode}"${v.sourceSystem ? ` from ${v.sourceSystem}` : ''} in the register or in this workbook.`);
        continue;
      }
      const conflict = (reason: DeviceConflictReason, detail: string) =>
        plan.devices.conflicts.push({ row, imei: v.imei, reason, detail });

      const device = heldByImei.get(v.imei);
      if (!device) {
        conflict('not_in_this_account', 'Not assigned to this account. Things Alive assigns loggers from stock.');
        continue;
      }
      if (device.state !== 'assigned') { conflict('not_assigned', `The logger is ${device.state}.`); continue; }
      if (!device.equipmentExternalId) {
        plan.devices.claim.push({ row, imei: v.imei, sourceSystem, equipmentCode: v.equipmentCode });
      } else if (device.equipmentExternalId === v.equipmentCode) {
        plan.devices.alreadyClaimed += 1;
      } else {
        conflict('claimed_to_another_machine',
          `Fitted to "${device.equipmentExternalId}". Take it off that machine first if it has moved.`);
      }
    }

    plan.canApply = plan.equipment.errors.length === 0 && plan.devices.errors.length === 0;
    return plan;
  }

  private resolveTenant(scope: RequestScope, onBehalfOfTenantId?: string): string {
    if (scope.isPlatformRole) {
      if (!onBehalfOfTenantId) throw new BadRequestException('Name the account to import into (tenantId).');
      return onBehalfOfTenantId;
    }
    if (onBehalfOfTenantId && onBehalfOfTenantId !== scope.tenantId) {
      throw new ForbiddenException('Only Things Alive staff can import into another account.');
    }
    return scope.tenantId;
  }

  /**
   * Fitting loggers is `device.claim`, which `equipment.write` does not imply. A role
   * that may add machines but not fit loggers must not get the second through the
   * first by putting it in a spreadsheet. Platform staff fit loggers on onboarding
   * already (QONBOARD1), so they pass.
   */
  private requireClaimRight(scope: RequestScope, workbook: ParsedFleetWorkbook): void {
    if (!workbook.devices.length || scope.isPlatformRole || can(scope, 'device.claim')) return;
    throw new ForbiddenException('This role cannot fit loggers to machines. Remove the Devices sheet or ask an admin.');
  }
}

/** Which of the workbook's values differ from the register's. Empty cells are not compared. */
function differingFields(existing: EquipmentProfile, wanted: EquipmentToCreate): string[] {
  const pairs: [string, unknown, unknown][] = [
    ['name', existing.name, wanted.name],
    ['site', existing.plantId, wanted.plantId],
    ['class', existing.equipmentClassSlug, wanted.equipmentClassSlug],
    ['manufacturer', existing.manufacturer, wanted.manufacturer],
    ['model number', existing.modelNumber, wanted.modelNumber],
    ['serial number', existing.serialNumber, wanted.serialNumber],
    ['description', existing.description, wanted.description],
    ['commissioned date', existing.commissionedAt?.toISOString().slice(0, 10) ?? null, wanted.commissionedAt],
    ['service interval', existing.serviceIntervalHours, wanted.serviceIntervalHours],
  ];
  // A blank cell means "not saying", not "clear it". Comparing it would turn every
  // short export into a list of conflicts on fields nobody meant to touch.
  return pairs.filter(([, have, want]) => want !== null && have !== want).map(([field]) => field);
}
