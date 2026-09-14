import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { EquipmentProjection } from '../../projection/entities/equipment-projection.entity';
import {
  CLIENT_SOURCE_SYSTEM, EquipmentProfile, EquipmentStatus, ServiceTier,
} from '../equipment-profile.entity';
import { EquipmentPlacementEvent } from '../entities/equipment-placement-event.entity';
import { Plant } from '../entities/plant.entity';

export interface EquipmentInput {
  /** The client's own identifier for the machine. Becomes half of its identity. */
  code: string;
  name: string;
  manufacturer?: string | null;
  modelNumber?: string | null;
  serialNumber?: string | null;
  description?: string | null;
  plantId?: string | null;
  equipmentClassSlug?: string | null;
  tier?: ServiceTier;
  commissionedAt?: Date | null;
  serviceIntervalHours?: number | null;
}

export interface AssetRef {
  sourceSystem: string;
  externalId: string;
}

export interface ImportResult {
  imported: number;
  alreadyKnown: number;
  unplaced: number;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The equipment register, owned by the client (tasks P1-85, P1-86).
 *
 * Two kinds of row live here and they are deliberately the same shape. A machine
 * adopted from the existing platform keeps that platform's identity; a machine
 * created here gets `ta-2.0` as its source system and the client's own code as its
 * external id. Everything downstream — activation, scoring, device claims, a site
 * manager's scope — was already keyed on the pair, so neither kind is a special case.
 *
 * Moving a machine between sites is the operation this register exists for, and the
 * only edit here that silently changes what other people can see: a site manager's
 * fleet is derived from placement, so one move gives an asset to one person and takes
 * it from another. That is why it is recorded rather than simply applied.
 */
@Injectable()
export class EquipmentService {
  private readonly logger = new Logger(EquipmentService.name);

  constructor(private readonly ds: DataSource) {}

  async list(
    scope: RequestScope, filters: { plantId?: string; includeRetired?: boolean } = {},
  ): Promise<EquipmentProfile[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentProfile).find({
        where: {
          tenantId: scope.tenantId,
          ...(filters.plantId ? { plantId: filters.plantId } : {}),
          ...(filters.includeRetired ? {} : { status: 'active' as EquipmentStatus }),
        },
        order: { externalId: 'ASC' },
      }));
  }

  async create(scope: RequestScope, input: EquipmentInput): Promise<EquipmentProfile> {
    if (!CODE_PATTERN.test(input.code ?? '')) {
      throw new BadRequestException(
        'An equipment code is letters, digits, dots, hyphens or underscores, up to 64 '
        + 'characters. It becomes part of the machine\'s identity and is not changed later.',
      );
    }

    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(EquipmentProfile);
      const existing = await repo.findOne({
        where: { tenantId: scope.tenantId, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: input.code },
      });
      if (existing) throw new ConflictException(`Equipment "${input.code}" already exists.`);

      const plantId = await this.resolvePlant(m, scope, input.plantId ?? null);
      const saved = await repo.save(repo.create({
        tenantId: scope.tenantId,
        sourceSystem: CLIENT_SOURCE_SYSTEM,
        externalId: input.code,
        origin: 'client',
        status: 'active',
        name: input.name?.trim() ?? null,
        manufacturer: input.manufacturer ?? null,
        modelNumber: input.modelNumber ?? null,
        serialNumber: input.serialNumber ?? null,
        description: input.description ?? null,
        plantId,
        equipmentClassSlug: input.equipmentClassSlug ?? null,
        classVersion: null,
        tier: input.tier ?? 'basic',
        commissionedAt: input.commissionedAt ?? null,
        serviceIntervalHours: input.serviceIntervalHours ?? null,
        readiness: {},
        createdBy: scope.userId,
        updatedBy: scope.userId,
      }));

      if (plantId) {
        await this.recordPlacement(m, scope, saved, null, plantId, 'created here');
      }
      return saved;
    });
  }

  async update(
    scope: RequestScope, ref: AssetRef, input: Partial<EquipmentInput>,
  ): Promise<EquipmentProfile> {
    return withTenantSession(this.ds, scope, async (m) => {
      const asset = await this.find(m, scope, ref);

      for (const key of ['name', 'manufacturer', 'modelNumber', 'serialNumber',
        'description', 'equipmentClassSlug', 'commissionedAt', 'serviceIntervalHours'] as const) {
        if (input[key] !== undefined) (asset as any)[key] = input[key] ?? null;
      }
      if (input.tier !== undefined) asset.tier = input.tier;
      // Placement is not edited here. It has its own method because it has its own
      // consequences, and burying it among seven descriptive fields would hide them.
      asset.updatedBy = scope.userId;
      return m.getRepository(EquipmentProfile).save(asset);
    });
  }

  /**
   * Move a machine to another site, or take it off site entirely.
   *
   * The reason is required. This is the edit that changes who can see the asset —
   * derived scope means a site manager gains it and another loses it the moment this
   * commits — and "why did this disappear from my site" is the question that follows.
   */
  async move(
    scope: RequestScope, ref: AssetRef, toPlantId: string | null, reason: string,
  ): Promise<EquipmentProfile> {
    if (!reason?.trim()) {
      throw new BadRequestException(
        'A reason is required to move equipment. It changes who can see the machine, '
        + 'and somebody will ask why it left their site.',
      );
    }

    return withTenantSession(this.ds, scope, async (m) => {
      const asset = await this.find(m, scope, ref);
      const resolved = await this.resolvePlant(m, scope, toPlantId);
      if (resolved === asset.plantId) return asset;

      const from = asset.plantId;
      asset.plantId = resolved;
      asset.updatedBy = scope.userId;
      const saved = await m.getRepository(EquipmentProfile).save(asset);
      await this.recordPlacement(m, scope, saved, from, resolved, reason);
      return saved;
    });
  }

  /** Where this machine has been. */
  async placementHistory(scope: RequestScope, ref: AssetRef): Promise<EquipmentPlacementEvent[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentPlacementEvent).find({
        where: { tenantId: scope.tenantId, ...ref },
        order: { at: 'ASC' },
      }));
  }

  async retire(scope: RequestScope, ref: AssetRef, reason: string): Promise<EquipmentProfile> {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to retire a machine.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      const asset = await this.find(m, scope, ref);
      const from = asset.plantId;
      asset.status = 'retired';
      // A retired machine is not standing anywhere, and leaving it placed would keep
      // it in a site manager's fleet and in the count that blocks closing a site.
      asset.plantId = null;
      asset.updatedBy = scope.userId;
      const saved = await m.getRepository(EquipmentProfile).save(asset);
      if (from) await this.recordPlacement(m, scope, saved, from, null, `retired: ${reason}`);
      return saved;
    });
  }

  /**
   * Adopt machines the existing platform already knows about.
   *
   * The register is 2.0's, and a customer with three hundred generators is not going
   * to retype them. This walks the mirror and creates a register row per asset,
   * keeping the upstream identity so every device claim, activation and prediction
   * already keyed on it continues to resolve.
   *
   * Placement is carried across where the upstream site has been linked to one here,
   * and left empty otherwise. Guessing would put machines at the wrong site, which is
   * worse than an obvious gap somebody fills in.
   */
  async importFromMirror(scope: RequestScope, sourceSystem: string): Promise<ImportResult> {
    return withTenantSession(this.ds, scope, async (m) => {
      const mirrored = await m.getRepository(EquipmentProjection).find({
        where: { tenantId: scope.tenantId, sourceSystem, status: 'live' },
      });
      const plants = await m.getRepository(Plant).find({
        where: { tenantId: scope.tenantId, sourceSystem },
      });
      const plantByExternal = new Map(
        plants.filter((p) => p.externalId).map((p) => [p.externalId as string, p.id]),
      );

      const repo = m.getRepository(EquipmentProfile);
      const result: ImportResult = { imported: 0, alreadyKnown: 0, unplaced: 0 };

      for (const row of mirrored) {
        const already = await repo.findOne({
          where: { tenantId: scope.tenantId, sourceSystem, externalId: row.externalId },
        });
        if (already) { result.alreadyKnown += 1; continue; }

        const plantId = row.plantExternalId ? plantByExternal.get(row.plantExternalId) ?? null : null;
        if (!plantId) result.unplaced += 1;

        const saved = await repo.save(repo.create({
          tenantId: scope.tenantId,
          sourceSystem,
          externalId: row.externalId,
          origin: 'mirrored',
          status: 'active',
          name: row.name,
          manufacturer: null, modelNumber: null, serialNumber: null, description: null,
          plantId,
          equipmentClassSlug: null, classVersion: null, tier: 'basic',
          commissionedAt: null, serviceIntervalHours: null, readiness: {},
          createdBy: scope.userId, updatedBy: scope.userId,
        }));
        if (plantId) {
          await this.recordPlacement(m, scope, saved, null, plantId, 'adopted from the existing platform');
        }
        result.imported += 1;
      }

      return result;
    });
  }

  // ----------------------------------------------------------------------- shared

  private async find(
    m: EntityManager, scope: RequestScope, ref: AssetRef,
  ): Promise<EquipmentProfile> {
    const asset = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, ...ref },
    });
    if (!asset) throw new NotFoundException('No such equipment in this account.');
    return asset;
  }

  /** A site in this account, or nothing. Never a site id from somebody else's. */
  private async resolvePlant(
    m: EntityManager, scope: RequestScope, plantId: string | null,
  ): Promise<string | null> {
    if (!plantId) return null;
    const plant = await m.getRepository(Plant).findOne({
      where: { tenantId: scope.tenantId, id: plantId },
    });
    if (!plant) throw new NotFoundException('No such site in this account.');
    if (plant.status === 'retired') {
      throw new ConflictException(`${plant.name} is closed. Reopen it before placing machines there.`);
    }
    return plant.id;
  }

  private async recordPlacement(
    m: EntityManager, scope: RequestScope, asset: EquipmentProfile,
    fromPlantId: string | null, toPlantId: string | null, reason: string,
  ): Promise<void> {
    const repo = m.getRepository(EquipmentPlacementEvent);
    await repo.save(repo.create({
      tenantId: scope.tenantId,
      sourceSystem: asset.sourceSystem,
      externalId: asset.externalId,
      fromPlantId, toPlantId, reason,
      actorUserId: scope.userId,
    }));
  }
}
