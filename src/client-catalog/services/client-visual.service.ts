import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ASSET_STORAGE, AssetStorage } from '../../assets/asset-storage';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassVisual } from '../../catalog/entities/equipment-class-visual.entity';
import { VisualState } from '../../catalog/services/class-visual.service';
import { Anchor, anchorProblems, TenantAnchor, unplacedSignals } from '../../catalog/visual/anchor-rules';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentClassVisualAnchor } from '../entities/client-equipment-class-visual-anchor.entity';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';

export interface TenantVisualRead {
  classSlug: string;
  state: VisualState;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  anchors: TenantAnchor[];
  /** Signals the account's class declares with no marker — a tray to place them from,
   * never put on a nearby anchor. A signal the tenant added themselves starts here. */
  unplacedSignals: string[];
}

export const toTenantAnchor = (r: ClientEquipmentClassVisualAnchor): TenantAnchor => ({
  signal: r.signal, hotspotX: r.hotspotX, hotspotY: r.hotspotY, label: r.label, placementCustom: r.placementCustom,
});

/**
 * The account's view of its class visual (task QREC0c §4). The image is the
 * platform's — the version this account's copy came from — and is read, never copied.
 * The anchors are the account's own rows.
 */
@Injectable()
export class ClientVisualService {
  private readonly logger = new Logger(ClientVisualService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(ASSET_STORAGE) private readonly storage: AssetStorage,
  ) {}

  async read(scope: RequestScope, slug: string): Promise<TenantVisualRead> {
    const { cls, rows } = await withTenantSession(this.ds, scope, async (m) => {
      const found = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!found) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
      const anchors = await m.getRepository(ClientEquipmentClassVisualAnchor).find({
        where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug }, order: { signal: 'ASC' },
      });
      return { cls: found, rows: anchors };
    });
    const visual = await this.platformVisual(cls);
    const state: VisualState = !visual ? 'no_visual'
      : !visual.assetKey ? 'upload_pending'
        : !this.storage.configured ? 'assets_unavailable' : 'ready';
    const anchors = rows.map(toTenantAnchor);
    return {
      classSlug: slug, state,
      imageUrl: state === 'ready' ? await this.storage.readUrl(visual!.assetKey!) : null,
      width: visual?.widthPx ?? null, height: visual?.heightPx ?? null,
      anchors, unplacedSignals: unplacedSignals(cls.expectedSignals.map((s) => s.signal), anchors),
    };
  }

  /**
   * The account's whole anchor set, replaced in one call and validated as a set. Every
   * anchor the tenant moved or added is marked `placementCustom`; one left exactly where
   * it was keeps the flag it had — a class-origin marker stays class-origin.
   */
  async replaceAnchors(scope: RequestScope, slug: string, anchors: Anchor[]): Promise<TenantVisualRead> {
    await withTenantSession(this.ds, scope, async (m) => {
      const cls = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!cls) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
      if (!(await this.platformVisual(cls))) {
        throw new BadRequestException(`"${slug}" has no visual; an anchor needs an image to sit on.`);
      }
      const problems = anchorProblems(anchors, cls.expectedSignals.map((s) => s.signal));
      if (problems.length) throw new BadRequestException(problems.join(' '));

      const repo = m.getRepository(ClientEquipmentClassVisualAnchor);
      const prior = new Map((await repo.find({ where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug } }))
        .map((r) => [r.signal, r]));
      await repo.delete({ tenantId: scope.tenantId, clientEquipmentClassSlug: slug });
      await repo.save(anchors.map((a) => {
        const before = prior.get(a.signal);
        const unchanged = before && before.hotspotX === a.hotspotX && before.hotspotY === a.hotspotY;
        return repo.create({
          tenantId: scope.tenantId, clientEquipmentClassSlug: slug, ...a,
          placementCustom: unchanged ? before!.placementCustom : true,
          templateVersion: before?.templateVersion ?? cls.templateVersion, copiedAt: before?.copiedAt ?? null,
        });
      }));
    });
    this.logger.log(`Tenant ${scope.tenantId} set ${anchors.length} anchor(s) on "${slug}".`);
    return this.read(scope, slug);
  }

  /** The platform visual for the class version this account's copy came from. */
  private platformVisual(cls: ClientEquipmentClass) {
    if (!cls.templateSlug || cls.templateVersion == null) return Promise.resolve(null);
    return this.ds.getRepository(EquipmentClassVisual).findOne({
      where: { classSlug: cls.templateSlug, classVersion: cls.templateVersion },
    });
  }
}
