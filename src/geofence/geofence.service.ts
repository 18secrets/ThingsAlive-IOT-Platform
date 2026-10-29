import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { withTenantSession } from '../scope/tenant-session';
import { GeofenceZone, ZoneAppliesTo } from './entities/geofence-zone.entity';
import { insideZone, LngLat, violates, ZoneKind, ZoneShape } from './geometry';

export interface ZoneInput {
  code: string;
  name: string;
  kind: ZoneKind;
  shape: unknown;
  appliesTo: ZoneAppliesTo;
  plantId?: string;
  sourceSystem?: string;
  externalId?: string;
  equipmentClassSlug?: string;
  enabled?: boolean;
}

/** Code and target are not here: they never change (see the migration's guard). */
export interface ZonePatch {
  name?: string;
  kind?: ZoneKind;
  shape?: unknown;
  enabled?: boolean;
}

/** A zone as it applies to one machine. A site boundary appears as an allowed zone with no id. */
export interface AppliedZone {
  /** `zone:<id>`, or `site:<plant id>` — by id, not code, since a site's code can be edited. */
  key: string;
  id: string | null;
  source: 'zone' | 'site-boundary';
  code: string;
  name: string;
  kind: ZoneKind;
  shape: ZoneShape;
  appliesTo: ZoneAppliesTo;
}

export interface ZoneCheck extends AppliedZone {
  inside: boolean;
  violation: boolean;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Geofence zones (task QGEO2, stage 1): authoring, and which zones apply to a machine.
 *
 * Who sees a zone follows who sees its target. A person narrowed to some sites or
 * machines neither sees nor targets a zone on one outside their scope — the zone would
 * name it. Account-wide and machine-type zones name neither, so everyone sees those.
 *
 * Nothing here decides what to do about a violation. Stage 2 records visits and
 * publishes them; alerts, work and the assistant act on that, not on this.
 */
@Injectable()
export class GeofenceService {
  constructor(private readonly ds: DataSource) {}

  async list(scope: RequestScope, filter: { appliesTo?: ZoneAppliesTo; enabled?: boolean } = {}): Promise<GeofenceZone[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const where: Record<string, unknown> = { tenantId: scope.tenantId };
      if (filter.appliesTo) where.appliesTo = filter.appliesTo;
      if (filter.enabled !== undefined) where.enabled = filter.enabled;
      const zones = await m.getRepository(GeofenceZone).find({ where, order: { code: 'ASC' } });
      return zones.filter((z) => visible(scope, z));
    });
  }

  async get(scope: RequestScope, id: string): Promise<GeofenceZone> {
    return withTenantSession(this.ds, scope, (m) => this.load(m, scope, id));
  }

  async create(scope: RequestScope, input: ZoneInput): Promise<GeofenceZone> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.refuseBadShape(m, input.shape);
      const target = await this.target(m, scope, input);
      const repo = m.getRepository(GeofenceZone);
      try {
        return await repo.save(repo.create({
          tenantId: scope.tenantId,
          code: input.code,
          name: input.name,
          kind: input.kind,
          shape: input.shape as ZoneShape,
          ...target,
          enabled: input.enabled ?? true,
          createdBy: scope.userId,
          updatedBy: scope.userId,
        }));
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(`A zone with the code "${input.code}" already exists in this account.`);
        }
        throw err;
      }
    });
  }

  async update(scope: RequestScope, id: string, patch: ZonePatch): Promise<GeofenceZone> {
    return withTenantSession(this.ds, scope, async (m) => {
      const zone = await this.load(m, scope, id);
      if (patch.shape !== undefined) await this.refuseBadShape(m, patch.shape);
      const kind = patch.kind ?? zone.kind;
      const shape = (patch.shape ?? zone.shape) as ZoneShape;
      // Said here so the refusal reads as a sentence; the CHECK is what holds.
      if ((kind === 'corridor') !== (shape.type === 'Corridor')) {
        throw new BadRequestException('A corridor zone has a Corridor shape, and only a corridor zone does.');
      }
      if (patch.name !== undefined) zone.name = patch.name;
      zone.kind = kind;
      zone.shape = shape;
      if (patch.enabled !== undefined) zone.enabled = patch.enabled;
      zone.updatedBy = scope.userId;
      return m.getRepository(GeofenceZone).save(zone);
    });
  }

  async remove(scope: RequestScope, id: string): Promise<{ id: string; deleted: true }> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.load(m, scope, id);
      await m.getRepository(GeofenceZone).delete({ tenantId: scope.tenantId, id });
      return { id, deleted: true };
    });
  }

  /**
   * Every enabled zone that applies to the machine: account-wide, its site's, its own and
   * its type's — and its site boundary, as an allowed zone, because a machine that left its
   * site has left an allowed area whether or not anyone drew a zone for it.
   */
  async zonesFor(scope: RequestScope, sourceSystem: string, externalId: string): Promise<AppliedZone[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const machine = await this.machine(m, scope, sourceSystem, externalId);
      const zones = (await m.getRepository(GeofenceZone).find({
        where: { tenantId: scope.tenantId, enabled: true }, order: { code: 'ASC' },
      })).filter((z) => applies(z, machine));

      const out: AppliedZone[] = [];
      // A site the caller may not see is not named, nor its fence shown — the onboarding
      // summary's rule. The machine's own zones still apply.
      if (machine.plantId && (scope.plantIds === undefined || scope.plantIds.includes(machine.plantId))) {
        const plant = await m.getRepository(Plant).findOne({ where: { tenantId: scope.tenantId, id: machine.plantId } });
        if (plant?.boundary) {
          out.push({
            key: `site:${plant.id}`, id: null, source: 'site-boundary', code: `site:${plant.code}`, name: plant.name,
            kind: 'allowed', shape: plant.boundary, appliesTo: 'plant',
          });
        }
      }
      for (const z of zones) {
        out.push({ key: `zone:${z.id}`, id: z.id, source: 'zone', code: z.code, name: z.name, kind: z.kind, shape: z.shape, appliesTo: z.appliesTo });
      }
      return out;
    });
  }

  /** Where one position stands against every zone that applies to the machine. */
  async check(scope: RequestScope, sourceSystem: string, externalId: string, point: LngLat): Promise<ZoneCheck[]> {
    const [lng, lat] = point;
    if (!(Math.abs(lng) <= 180) || !(Math.abs(lat) <= 90)) {
      throw new BadRequestException('A position is longitude within ±180 and latitude within ±90.');
    }
    return (await this.zonesFor(scope, sourceSystem, externalId)).map((z) => {
      const inside = insideZone(z.shape, point);
      return { ...z, inside, violation: violates(z.kind, inside) };
    });
  }

  // ====================================================================== helpers

  private async load(m: EntityManager, scope: RequestScope, id: string): Promise<GeofenceZone> {
    const zone = await m.getRepository(GeofenceZone).findOne({ where: { tenantId: scope.tenantId, id } });
    if (!zone || !visible(scope, zone)) throw new NotFoundException('No such zone in this account.');
    return zone;
  }

  /** The database's own validator, asked first so the refusal can say what is wrong. */
  private async refuseBadShape(m: EntityManager, shape: unknown): Promise<void> {
    const [{ problem }] = await m.query(`SELECT geofence_shape_problem($1::jsonb) AS problem`, [JSON.stringify(shape ?? null)]);
    if (problem) throw new BadRequestException(`Shape refused: ${problem}.`);
  }

  /** The target columns for `appliesTo`, after checking the target exists here and is in scope. */
  private async target(m: EntityManager, scope: RequestScope, input: ZoneInput): Promise<Partial<GeofenceZone>> {
    const none = { plantId: null, sourceSystem: null, externalId: null, equipmentClassSlug: null };
    switch (input.appliesTo) {
      case 'account':
        return { appliesTo: 'account', ...none };
      case 'plant': {
        if (!input.plantId) throw new BadRequestException('A site zone needs plantId.');
        const plant = await m.getRepository(Plant).findOne({ where: { tenantId: scope.tenantId, id: input.plantId } });
        if (!plant || (scope.plantIds !== undefined && !scope.plantIds.includes(plant.id))) {
          throw new NotFoundException('No such site in this account.');
        }
        return { appliesTo: 'plant', ...none, plantId: plant.id };
      }
      case 'equipment': {
        if (!input.sourceSystem || !input.externalId) throw new BadRequestException('A machine zone needs sourceSystem and externalId.');
        const machine = await this.machine(m, scope, input.sourceSystem, input.externalId);
        return { appliesTo: 'equipment', ...none, sourceSystem: machine.sourceSystem, externalId: machine.externalId };
      }
      case 'equipment-class': {
        if (!input.equipmentClassSlug) throw new BadRequestException('A machine-type zone needs equipmentClassSlug.');
        const found = await m.getRepository(ClientEquipmentClass).findOne({
          where: { tenantId: scope.tenantId, slug: input.equipmentClassSlug },
        });
        if (!found) throw new NotFoundException('No such machine type in this account.');
        return { appliesTo: 'equipment-class', ...none, equipmentClassSlug: found.slug };
      }
      default:
        throw new BadRequestException('appliesTo is account, plant, equipment or equipment-class.');
    }
  }

  private async machine(m: EntityManager, scope: RequestScope, sourceSystem: string, externalId: string): Promise<EquipmentProfile> {
    const notFound = () => new NotFoundException('No such machine in this account.');
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) throw notFound();
    const machine = await m.getRepository(EquipmentProfile).findOne({ where: { tenantId: scope.tenantId, sourceSystem, externalId } });
    if (!machine) throw notFound();
    return machine;
  }
}

function visible(scope: RequestScope, z: GeofenceZone): boolean {
  if (z.appliesTo === 'plant') return scope.plantIds === undefined || scope.plantIds.includes(z.plantId!);
  if (z.appliesTo === 'equipment') return scope.equipmentIds === undefined || scope.equipmentIds.includes(z.externalId!);
  return true;
}

function applies(z: GeofenceZone, machine: EquipmentProfile): boolean {
  switch (z.appliesTo) {
    case 'account': return true;
    case 'plant': return !!machine.plantId && z.plantId === machine.plantId;
    case 'equipment': return z.sourceSystem === machine.sourceSystem && z.externalId === machine.externalId;
    case 'equipment-class': return !!machine.equipmentClassSlug && z.equipmentClassSlug === machine.equipmentClassSlug;
  }
}
