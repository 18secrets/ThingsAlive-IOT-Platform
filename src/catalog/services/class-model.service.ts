import {
  BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  ASSET_STORAGE, AssetStorage, MAX_VISUAL_BYTES, MODEL_CONTENT_TYPES, UPLOAD_URL_TTL_SECONDS,
} from '../../assets/asset-storage';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';
import { EquipmentClassVisual, EquipmentClassVisualAnchor } from '../entities/equipment-class-visual.entity';
import { unplacedSignals } from '../visual/anchor-rules';
import { ModelAnchor, ModelBounds, modelAnchorProblems, sameBounds } from '../visual/model-anchor-rules';

export type ModelState = 'ready' | 'no_model' | 'upload_pending' | 'assets_unavailable';

export interface ModelRead {
  classSlug: string;
  classVersion: number;
  /** The schematic's four states, with `no_model` for `no_visual`: each one a reader can act on. */
  state: ModelState;
  modelUrl: string | null;
  contentType: string | null;
  geometryVersion: number | null;
  bounds: ModelBounds | null;
  anchors: ModelAnchor[];
  unplacedSignals: string[];
}

// ------------------------------------------------------------ shared helpers

export function loadModel(m: EntityManager, classSlug: string, classVersion: number) {
  return m.getRepository(EquipmentClassVisual).findOne({ where: { classSlug, classVersion, tier: 'model' } });
}

export async function loadModelAnchors(m: EntityManager, classSlug: string, classVersion: number): Promise<ModelAnchor[]> {
  const rows = await m.getRepository(EquipmentClassVisualAnchor).find({
    where: { classSlug, classVersion, tier: 'model' }, order: { signal: 'ASC' },
  });
  return rows.map(toModelAnchor);
}

export const toModelAnchor = (r: { signal: string; posX: number | null; posY: number | null; posZ: number | null; label: string | null }): ModelAnchor =>
  ({ signal: r.signal, x: r.posX!, y: r.posY!, z: r.posZ!, label: r.label });

/** The box a confirmed model was measured at; null until it is confirmed. */
export function boundsOf(v: EquipmentClassVisual | null): ModelBounds | null {
  if (!v || v.boundsMinX === null) return null;
  return { min: [v.boundsMinX, v.boundsMinY!, v.boundsMinZ!], max: [v.boundsMaxX!, v.boundsMaxY!, v.boundsMaxZ!] };
}

/**
 * A fork starts with its parent's model and markers, sharing the bytes and the
 * `geometry_version` — geometry follows the mesh, not the class version, so a fork that
 * keeps the mesh changes nothing a tenant placed. An unconfirmed upload is not carried.
 */
export async function copyModel(m: EntityManager, classSlug: string, fromVersion: number, toVersion: number) {
  const model = await loadModel(m, classSlug, fromVersion);
  if (!model?.assetKey) return;
  const repo = m.getRepository(EquipmentClassVisual);
  await repo.save(repo.create({
    classSlug, classVersion: toVersion, tier: 'model', assetKey: model.assetKey, contentType: model.contentType,
    sizeBytes: model.sizeBytes, geometryVersion: model.geometryVersion,
    boundsMinX: model.boundsMinX, boundsMinY: model.boundsMinY, boundsMinZ: model.boundsMinZ,
    boundsMaxX: model.boundsMaxX, boundsMaxY: model.boundsMaxY, boundsMaxZ: model.boundsMaxZ,
    uploadedBy: model.uploadedBy, uploadedAt: model.uploadedAt,
  }));
  const anchors = await loadModelAnchors(m, classSlug, fromVersion);
  if (anchors.length) {
    const a = m.getRepository(EquipmentClassVisualAnchor);
    await a.save(anchors.map((x) => a.create({
      classSlug, classVersion: toVersion, tier: 'model', signal: x.signal, posX: x.x, posY: x.y, posZ: x.z, label: x.label,
    })));
  }
}

/** What publish refuses about a version's model (task QTWIN1 §2). No model at all is
 * fine — publishing is not gated on having one (D39). */
export async function modelPublishProblems(
  m: EntityManager, classSlug: string, classVersion: number, declaredSignals: string[],
): Promise<string[]> {
  const model = await loadModel(m, classSlug, classVersion);
  const anchors = await loadModelAnchors(m, classSlug, classVersion);
  const problems = modelAnchorProblems(anchors, declaredSignals, boundsOf(model));
  if (model && !model.assetKey && model.pendingKey) {
    problems.push('the model upload was issued but never confirmed — confirm it, or delete the model, first.');
  }
  return problems;
}

// ------------------------------------------------------------------ service

/**
 * The class's 3-D model for authoring (task QTWIN1 §2) — the schematic's flow with a
 * GLB: a presigned PUT, a confirm that HEADs the object before recording it, a signed
 * or CDN read. The console measures the bounding box, as it measures an image's size;
 * the API never sees the bytes and does no mesh processing.
 */
@Injectable()
export class ClassModelService {
  private readonly logger = new Logger(ClassModelService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(ASSET_STORAGE) private readonly storage: AssetStorage,
  ) {}

  async issueUploadUrl(scope: RequestScope, slug: string, version: number, contentType: string) {
    if (!(MODEL_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new BadRequestException(
        `Content type "${contentType}" is not an allowed model type (${MODEL_CONTENT_TYPES.join(', ')}).`,
      );
    }
    this.requireStorage();
    const key = `class-models/${slug}/v${version}/${randomUUID()}.glb`;
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      const model = await this.lockModel(m, slug, version)
        ?? m.getRepository(EquipmentClassVisual).create({ classSlug: slug, classVersion: version, tier: 'model' });
      model.pendingKey = key;
      model.pendingContentType = contentType;
      await m.getRepository(EquipmentClassVisual).save(model);
    });
    const uploadUrl = await this.storage.presignPut(key, contentType);
    this.logger.log(`${scope.userId} issued a model upload for "${slug}" v${version}.`);
    return {
      uploadUrl, key, method: 'PUT' as const, headers: { 'Content-Type': contentType },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  /**
   * Records the uploaded model once the object is seen to exist, and decides its
   * `geometry_version` (QTWIN1 §1.1): kept only when the uploader says the geometry is
   * unchanged *and* the box is exactly where it was. A box that moved means markers
   * placed against the old one may not fit, whatever the uploader believes.
   */
  async confirm(
    scope: RequestScope, slug: string, version: number, bounds: ModelBounds, geometryChanged = true,
  ): Promise<ModelRead> {
    this.requireStorage();
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      const model = await this.lockModel(m, slug, version);
      if (!model?.pendingKey) {
        throw new BadRequestException(`No model upload is pending for "${slug}" v${version}; request an upload URL first.`);
      }
      const head = await this.storage.head(model.pendingKey);
      if (!head) throw new BadRequestException(`Nothing was uploaded to ${model.pendingKey}; the upload did not complete.`);
      if (head.contentType !== model.pendingContentType) {
        throw new BadRequestException(
          `The uploaded object is "${head.contentType}", not the "${model.pendingContentType}" the URL was issued for.`,
        );
      }
      if (head.size <= 0 || head.size > MAX_VISUAL_BYTES) {
        throw new BadRequestException(`The uploaded object is ${head.size} bytes; a model must be 1 byte to ${MAX_VISUAL_BYTES}.`);
      }
      const keep = model.geometryVersion !== null && !geometryChanged && sameBounds(boundsOf(model), bounds);
      let geometryVersion = model.geometryVersion;
      if (!keep) {
        const [{ top }] = await m.query(
          `SELECT coalesce(max("geometry_version"), 0)::int AS top FROM "equipment_class_visual" WHERE "class_slug" = $1 AND "tier" = 'model'`,
          [slug],
        );
        geometryVersion = top + 1;
      }
      Object.assign(model, {
        assetKey: model.pendingKey, contentType: model.pendingContentType, sizeBytes: head.size, geometryVersion,
        boundsMinX: bounds.min[0], boundsMinY: bounds.min[1], boundsMinZ: bounds.min[2],
        boundsMaxX: bounds.max[0], boundsMaxY: bounds.max[1], boundsMaxZ: bounds.max[2],
        uploadedBy: scope.userId, uploadedAt: new Date(), pendingKey: null, pendingContentType: null,
      });
      await m.getRepository(EquipmentClassVisual).save(model);
    });
    this.logger.log(`${scope.userId} confirmed the model for "${slug}" v${version}.`);
    return this.read(slug, version);
  }

  async read(slug: string, version: number): Promise<ModelRead> {
    const profile = await this.ds.getRepository(EquipmentClassProfile).findOne({ where: { slug, version } });
    if (!profile) throw new NotFoundException(`No class "${slug}" v${version}.`);
    const model = await loadModel(this.ds.manager, slug, version);
    const anchors = await loadModelAnchors(this.ds.manager, slug, version);
    const state: ModelState = !model ? 'no_model'
      : !model.assetKey ? 'upload_pending'
        : !this.storage.configured ? 'assets_unavailable' : 'ready';
    return {
      classSlug: slug, classVersion: version, state,
      modelUrl: state === 'ready' ? await this.storage.readUrl(model!.assetKey!) : null,
      contentType: model?.contentType ?? null, geometryVersion: model?.geometryVersion ?? null, bounds: boundsOf(model),
      anchors, unplacedSignals: unplacedSignals(profile.expectedSignals.map((s) => s.signal), anchors),
    };
  }

  /** The row and its markers go; the object stays, for the schematic's reason. */
  async remove(scope: RequestScope, slug: string, version: number): Promise<void> {
    await this.ds.transaction(async (m) => {
      await this.requireDraft(m, slug, version);
      if (!(await this.lockModel(m, slug, version))) throw new NotFoundException(`"${slug}" v${version} has no model.`);
      await m.getRepository(EquipmentClassVisualAnchor).delete({ classSlug: slug, classVersion: version, tier: 'model' });
      await m.getRepository(EquipmentClassVisual).delete({ classSlug: slug, classVersion: version, tier: 'model' });
    });
    this.logger.log(`${scope.userId} removed the model from "${slug}" v${version}.`);
  }

  /** The whole set, validated as a set, serialised on the model row — the schematic's rule. */
  async replaceAnchors(scope: RequestScope, slug: string, version: number, anchors: ModelAnchor[]): Promise<ModelRead> {
    await this.ds.transaction(async (m) => {
      const profile = await this.requireDraft(m, slug, version);
      const model = await this.lockModel(m, slug, version);
      if (!model?.assetKey) {
        throw new BadRequestException(`"${slug}" v${version} has no confirmed model; an anchor needs a model to sit on.`);
      }
      const problems = modelAnchorProblems(anchors, profile.expectedSignals.map((s) => s.signal), boundsOf(model));
      if (problems.length) throw new BadRequestException(problems.join(' '));
      const repo = m.getRepository(EquipmentClassVisualAnchor);
      await repo.delete({ classSlug: slug, classVersion: version, tier: 'model' });
      if (anchors.length) {
        await repo.save(anchors.map((a) => repo.create({
          classSlug: slug, classVersion: version, tier: 'model', signal: a.signal, posX: a.x, posY: a.y, posZ: a.z, label: a.label,
        })));
      }
    });
    this.logger.log(`${scope.userId} set ${anchors.length} model anchor(s) on "${slug}" v${version}.`);
    return this.read(slug, version);
  }

  private requireStorage(): void {
    if (!this.storage.configured) {
      throw new ServiceUnavailableException('Asset storage is not configured (assets_unavailable); models cannot be uploaded.');
    }
  }

  private async requireDraft(m: EntityManager, slug: string, version: number): Promise<EquipmentClassProfile> {
    const profile = await m.getRepository(EquipmentClassProfile).findOne({ where: { slug, version } });
    if (!profile) throw new NotFoundException(`No class "${slug}" v${version}.`);
    if (profile.status !== 'draft') {
      throw new BadRequestException(
        `"${slug}" v${version} is ${profile.status}; a model is class content and a published version is immutable.`,
      );
    }
    return profile;
  }

  private lockModel(m: EntityManager, slug: string, version: number) {
    return m.getRepository(EquipmentClassVisual).createQueryBuilder('v')
      .setLock('pessimistic_write')
      .where(`v.class_slug = :slug AND v.class_version = :version AND v.tier = 'model'`, { slug, version })
      .getOne();
  }
}
