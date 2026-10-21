import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ASSET_STORAGE, AssetStorage } from '../../assets/asset-storage';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassVisual } from '../../catalog/entities/equipment-class-visual.entity';
import { boundsOf, ModelState } from '../../catalog/services/class-model.service';
import {
  ModelAnchor, ModelBounds, modelAnchorProblems, modelTray, TenantModelAnchor,
} from '../../catalog/visual/model-anchor-rules';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentClassVisualAnchor } from '../entities/client-equipment-class-visual-anchor.entity';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';

export interface TenantModelRead {
  classSlug: string;
  state: ModelState;
  modelUrl: string | null;
  contentType: string | null;
  geometryVersion: number | null;
  bounds: ModelBounds | null;
  /** Every marker the account holds, a recheck one included so the editor can show where it was. */
  anchors: TenantModelAnchor[];
  /** What is not drawn on the model: signals with no marker, and markers waiting for a recheck. */
  tray: { signal: string; needsRecheck: boolean }[];
}

export const toTenantModelAnchor = (r: ClientEquipmentClassVisualAnchor): TenantModelAnchor => ({
  signal: r.signal, x: r.posX!, y: r.posY!, z: r.posZ!, label: r.label,
  placementCustom: r.placementCustom, needsRecheck: r.needsRecheck,
});

/** The platform model for the class version this account's copy tracks. */
export function platformModel(m: EntityManager, cls: ClientEquipmentClass) {
  if (!cls.templateSlug || cls.templateVersion == null) return Promise.resolve(null);
  return m.getRepository(EquipmentClassVisual).findOne({
    where: { classSlug: cls.templateSlug, classVersion: cls.templateVersion, tier: 'model' },
  });
}

/**
 * The account's 3-D twin (task QTWIN1 §3). The mesh is the platform's and is read, never
 * copied; the markers are the account's own rows.
 *
 * Both writes take the account's class row lock: a whole-set replace is a delete and an
 * insert, and two of them interleaved would collide on the unique key — or leave a set
 * that is neither one.
 */
@Injectable()
export class ClientModelService {
  private readonly logger = new Logger(ClientModelService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(ASSET_STORAGE) private readonly storage: AssetStorage,
  ) {}

  async read(scope: RequestScope, slug: string): Promise<TenantModelRead> {
    const { cls, rows, model } = await withTenantSession(this.ds, scope, async (m) => {
      const found = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!found) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
      const anchors = await m.getRepository(ClientEquipmentClassVisualAnchor).find({
        where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug, tier: 'model' }, order: { signal: 'ASC' },
      });
      return { cls: found, rows: anchors, model: await platformModel(m, found) };
    });
    const state: ModelState = !model ? 'no_model'
      : !model.assetKey ? 'upload_pending'
        : !this.storage.configured ? 'assets_unavailable' : 'ready';
    const anchors = rows.map(toTenantModelAnchor);
    return {
      classSlug: slug, state,
      modelUrl: state === 'ready' ? await this.storage.readUrl(model!.assetKey!) : null,
      contentType: model?.contentType ?? null, geometryVersion: model?.geometryVersion ?? null, bounds: boundsOf(model),
      anchors, tray: modelTray(cls.expectedSignals.map((s) => s.signal), anchors),
    };
  }

  /**
   * The account's whole model anchor set, replaced in one call and validated as a set.
   * A moved or added anchor becomes the account's own and loses `needs_recheck` — it was
   * just positioned against this geometry. One left exactly where it was keeps both flags:
   * saving the set is not the same as looking at every marker.
   */
  async replaceAnchors(scope: RequestScope, slug: string, anchors: ModelAnchor[]): Promise<TenantModelRead> {
    await withTenantSession(this.ds, scope, async (m) => {
      const cls = await this.lockClass(m, scope, slug);
      const model = await platformModel(m, cls);
      if (!model?.assetKey) {
        throw new BadRequestException(`"${slug}" has no confirmed model; an anchor needs a model to sit on.`);
      }
      const problems = modelAnchorProblems(anchors, cls.expectedSignals.map((s) => s.signal), boundsOf(model));
      if (problems.length) throw new BadRequestException(problems.join(' '));

      const repo = m.getRepository(ClientEquipmentClassVisualAnchor);
      const where = { tenantId: scope.tenantId, clientEquipmentClassSlug: slug, tier: 'model' as const };
      const prior = new Map((await repo.find({ where })).map((r) => [r.signal, r]));
      await repo.delete(where);
      if (anchors.length) {
        await repo.save(anchors.map((a) => {
          const before = prior.get(a.signal);
          const unchanged = before && before.posX === a.x && before.posY === a.y && before.posZ === a.z;
          return repo.create({
            ...where, signal: a.signal, posX: a.x, posY: a.y, posZ: a.z, label: a.label,
            placementCustom: unchanged ? before!.placementCustom : true,
            needsRecheck: unchanged ? before!.needsRecheck : false,
            templateVersion: cls.templateVersion, copiedAt: before?.copiedAt ?? null,
          });
        }));
      }
    });
    this.logger.log(`Tenant ${scope.tenantId} set ${anchors.length} model anchor(s) on "${slug}".`);
    return this.read(scope, slug);
  }

  /**
   * "I looked; it is still right": keeps the position and clears `needs_recheck`.
   * Idempotent — confirming a marker that is not waiting changes nothing. A marker the
   * new geometry no longer contains cannot be confirmed; it has to be moved.
   */
  async confirmAnchor(scope: RequestScope, slug: string, signal: string): Promise<TenantModelRead> {
    await withTenantSession(this.ds, scope, async (m) => {
      const cls = await this.lockClass(m, scope, slug);
      const repo = m.getRepository(ClientEquipmentClassVisualAnchor);
      const row = await repo.findOne({ where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug, tier: 'model', signal } });
      if (!row) throw new NotFoundException(`"${slug}" has no model anchor for "${signal}".`);
      if (!row.needsRecheck) return;
      const problems = modelAnchorProblems([toTenantModelAnchor(row)], [signal], boundsOf(await platformModel(m, cls)));
      if (problems.length) {
        throw new BadRequestException(`${problems.join(' ')} Move it instead: a confirmed marker must sit on the model.`);
      }
      row.needsRecheck = false;
      row.templateVersion = cls.templateVersion;
      await repo.save(row);
    });
    this.logger.log(`Tenant ${scope.tenantId} confirmed the model anchor "${signal}" on "${slug}".`);
    return this.read(scope, slug);
  }

  private async lockClass(m: EntityManager, scope: RequestScope, slug: string): Promise<ClientEquipmentClass> {
    const cls = await m.getRepository(ClientEquipmentClass).createQueryBuilder('c')
      .setLock('pessimistic_write')
      .where('c.tenant_id = :tenant AND c.slug = :slug', { tenant: scope.tenantId, slug })
      .getOne();
    if (!cls) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
    return cls;
  }
}
