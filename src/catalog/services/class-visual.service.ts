import {
  BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  ASSET_STORAGE, AssetStorage, MAX_VISUAL_BYTES, UPLOAD_URL_TTL_SECONDS, VISUAL_CONTENT_TYPES,
} from '../../assets/asset-storage';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';
import { EquipmentClassVisual, EquipmentClassVisualAnchor } from '../entities/equipment-class-visual.entity';
import { Anchor, anchorProblems, unplacedSignals } from '../visual/anchor-rules';

export type VisualState = 'ready' | 'no_visual' | 'upload_pending' | 'assets_unavailable';

export interface VisualRead {
  classSlug: string;
  classVersion: number;
  /** Which of four different problems this is — each one a reader can act on. */
  state: VisualState;
  tier: 'schematic' | null;
  imageUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  anchors: Anchor[];
  unplacedSignals: string[];
}

const EXTENSION: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
};

// ------------------------------------------------------------ shared helpers

export function loadVisual(m: EntityManager, classSlug: string, classVersion: number) {
  return m.getRepository(EquipmentClassVisual).findOne({ where: { classSlug, classVersion } });
}

export async function loadAnchors(m: EntityManager, classSlug: string, classVersion: number): Promise<Anchor[]> {
  const rows = await m.getRepository(EquipmentClassVisualAnchor).find({
    where: { classSlug, classVersion }, order: { signal: 'ASC' },
  });
  return rows.map((r) => ({ signal: r.signal, hotspotX: r.hotspotX, hotspotY: r.hotspotY, label: r.label }));
}

/**
 * A fork starts with the version it came from's picture and markers. The row is
 * copied with the same `asset_key`: forks share bytes — one image serving many
 * versions is the point of the asset being platform-owned. An unconfirmed upload is
 * not carried; it belonged to the old draft.
 */
export async function copyVisual(m: EntityManager, classSlug: string, fromVersion: number, toVersion: number) {
  const visual = await loadVisual(m, classSlug, fromVersion);
  if (!visual) return;
  await m.getRepository(EquipmentClassVisual).save(m.getRepository(EquipmentClassVisual).create({
    classSlug, classVersion: toVersion, tier: visual.tier, assetKey: visual.assetKey, contentType: visual.contentType,
    widthPx: visual.widthPx, heightPx: visual.heightPx, sizeBytes: visual.sizeBytes,
    uploadedBy: visual.uploadedBy, uploadedAt: visual.uploadedAt,
  }));
  const anchors = await loadAnchors(m, classSlug, fromVersion);
  if (anchors.length) {
    const repo = m.getRepository(EquipmentClassVisualAnchor);
    await repo.save(anchors.map((a) => repo.create({ classSlug, classVersion: toVersion, ...a })));
  }
}

/** What publish refuses about a version's visual (task QREC0c §2), each naming what.
 * No visual at all is fine — tier 0 is a valid published state. */
export async function visualPublishProblems(
  m: EntityManager, classSlug: string, classVersion: number, declaredSignals: string[],
): Promise<string[]> {
  const visual = await loadVisual(m, classSlug, classVersion);
  const anchors = await loadAnchors(m, classSlug, classVersion);
  const problems = anchorProblems(anchors, declaredSignals);
  // Published is immutable: an upload issued but never confirmed would stay
  // `upload_pending` for that version forever.
  if (visual && !visual.assetKey && visual.pendingKey) {
    problems.push('the visual upload was issued but never confirmed — confirm it, or delete the visual, first.');
  }
  return problems;
}

// ------------------------------------------------------------------ service

/**
 * Class visuals for authoring (task QREC0c §3). Upload is a presigned PUT: the API
 * never streams the bytes, it issues a short-lived URL and, after the console has
 * uploaded, confirms the object is really there before recording it. Reads return a
 * short-lived signed GET or the CDN URL — never credentials, never the bucket's raw
 * endpoint.
 */
@Injectable()
export class ClassVisualService {
  private readonly logger = new Logger(ClassVisualService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(ASSET_STORAGE) private readonly storage: AssetStorage,
  ) {}

  async issueUploadUrl(scope: RequestScope, slug: string, version: number, contentType: string) {
    if (!(VISUAL_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new BadRequestException(
        `Content type "${contentType}" is not an allowed visual type (${VISUAL_CONTENT_TYPES.join(', ')}).`,
      );
    }
    this.requireStorage();
    const key = `class-visuals/${slug}/v${version}/${randomUUID()}.${EXTENSION[contentType]}`;
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      const visual = await this.lockVisual(m, slug, version)
        ?? m.getRepository(EquipmentClassVisual).create({ classSlug: slug, classVersion: version, tier: 'schematic' });
      visual.pendingKey = key;
      visual.pendingContentType = contentType;
      await m.getRepository(EquipmentClassVisual).save(visual);
    });
    const uploadUrl = await this.storage.presignPut(key, contentType);
    this.logger.log(`${scope.userId} issued a visual upload for "${slug}" v${version}.`);
    return {
      uploadUrl, key, method: 'PUT' as const, headers: { 'Content-Type': contentType },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  /** The object is checked to exist, be the declared type and a sane size before its
   * key is recorded. The console reports the dimensions it measured: the API never
   * sees the bytes and does no image processing. */
  async confirm(scope: RequestScope, slug: string, version: number, width: number, height: number): Promise<VisualRead> {
    this.requireStorage();
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      const visual = await this.lockVisual(m, slug, version);
      if (!visual?.pendingKey) {
        throw new BadRequestException(`No upload is pending for "${slug}" v${version}; request an upload URL first.`);
      }
      const head = await this.storage.head(visual.pendingKey);
      if (!head) {
        throw new BadRequestException(`Nothing was uploaded to ${visual.pendingKey}; the upload did not complete.`);
      }
      if (head.contentType !== visual.pendingContentType) {
        throw new BadRequestException(
          `The uploaded object is "${head.contentType}", not the "${visual.pendingContentType}" the URL was issued for.`,
        );
      }
      if (head.size <= 0 || head.size > MAX_VISUAL_BYTES) {
        throw new BadRequestException(`The uploaded object is ${head.size} bytes; a visual must be 1 byte to ${MAX_VISUAL_BYTES}.`);
      }
      Object.assign(visual, {
        assetKey: visual.pendingKey, contentType: visual.pendingContentType, widthPx: width, heightPx: height,
        sizeBytes: head.size, uploadedBy: scope.userId, uploadedAt: new Date(),
        pendingKey: null, pendingContentType: null,
      });
      await m.getRepository(EquipmentClassVisual).save(visual);
    });
    this.logger.log(`${scope.userId} confirmed the visual for "${slug}" v${version}.`);
    return this.read(slug, version);
  }

  async read(slug: string, version: number): Promise<VisualRead> {
    const profile = await this.ds.getRepository(EquipmentClassProfile).findOne({ where: { slug, version } });
    if (!profile) throw new NotFoundException(`No class "${slug}" v${version}.`);
    const visual = await loadVisual(this.ds.manager, slug, version);
    const anchors = await loadAnchors(this.ds.manager, slug, version);
    const state: VisualState = !visual ? 'no_visual'
      : !visual.assetKey ? 'upload_pending'
        : !this.storage.configured ? 'assets_unavailable' : 'ready';
    return {
      classSlug: slug, classVersion: version, state, tier: visual?.tier ?? null,
      imageUrl: state === 'ready' ? await this.storage.readUrl(visual!.assetKey!) : null,
      contentType: visual?.contentType ?? null, width: visual?.widthPx ?? null, height: visual?.heightPx ?? null,
      anchors, unplacedSignals: unplacedSignals(profile.expectedSignals.map((s) => s.signal), anchors),
    };
  }

  /** The row and its markers go; the object stays — a published version or a fork may
   * share it, and cleaning up unreferenced objects is a separate concern. */
  async remove(scope: RequestScope, slug: string, version: number): Promise<void> {
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      if (!(await this.lockVisual(m, slug, version))) throw new NotFoundException(`"${slug}" v${version} has no visual.`);
      await m.getRepository(EquipmentClassVisualAnchor).delete({ classSlug: slug, classVersion: version });
      await m.getRepository(EquipmentClassVisual).delete({ classSlug: slug, classVersion: version });
    });
    this.logger.log(`${scope.userId} removed the visual from "${slug}" v${version}.`);
  }

  /** The whole set, validated as a set, in one call — a partial anchor update is
   * ambiguous for the reason a partial reorder was (QREC0b). Serialised on the
   * visual row, so two editors saving at once cannot interleave. */
  async replaceAnchors(scope: RequestScope, slug: string, version: number, anchors: Anchor[]): Promise<VisualRead> {
    await this.ds.transaction(async (m) => {
      const profile = await this.requireDraft(m, slug, version);
      if (!(await this.lockVisual(m, slug, version))) {
        throw new BadRequestException(`"${slug}" v${version} has no visual; an anchor needs an image to sit on.`);
      }
      const problems = anchorProblems(anchors, profile.expectedSignals.map((s) => s.signal));
      if (problems.length) throw new BadRequestException(problems.join(' '));
      const repo = m.getRepository(EquipmentClassVisualAnchor);
      await repo.delete({ classSlug: slug, classVersion: version });
      if (anchors.length) await repo.save(anchors.map((a) => repo.create({ classSlug: slug, classVersion: version, ...a })));
    });
    this.logger.log(`${scope.userId} set ${anchors.length} anchor(s) on "${slug}" v${version}.`);
    return this.read(slug, version);
  }

  private requireStorage(): void {
    if (!this.storage.configured) {
      throw new ServiceUnavailableException('Asset storage is not configured (assets_unavailable); visuals cannot be uploaded.');
    }
  }

  private async requireDraft(m: EntityManager, slug: string, version: number): Promise<EquipmentClassProfile> {
    const profile = await m.getRepository(EquipmentClassProfile).findOne({ where: { slug, version } });
    if (!profile) throw new NotFoundException(`No class "${slug}" v${version}.`);
    if (profile.status !== 'draft') {
      throw new BadRequestException(
        `"${slug}" v${version} is ${profile.status}; visuals are class content and a published version is immutable.`,
      );
    }
    return profile;
  }

  private lockVisual(m: EntityManager, slug: string, version: number) {
    return m.getRepository(EquipmentClassVisual).createQueryBuilder('v')
      .setLock('pessimistic_write')
      .where('v.class_slug = :slug AND v.class_version = :version', { slug, version })
      .getOne();
  }
}
