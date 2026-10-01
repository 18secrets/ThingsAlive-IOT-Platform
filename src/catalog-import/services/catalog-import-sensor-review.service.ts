import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Sensor } from '../../device-catalog/entities/sensor.entity';
import { SensorCategory } from '../../device-catalog/entities/sensor-category.entity';
import { CatalogImportBatch, SensorDecision } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import { CatalogImportDiff, CatalogImportDiffService } from './catalog-import-diff.service';
import { CatalogImportValidatorService } from './catalog-import-validator.service';
import { EMPTY_SENSOR_CAPABILITY_ANALYSIS, analyzeSensorCapability } from './sensor-review';

export interface SensorReviewRequest {
  approveCategories?: { slug: string }[];
  approve?: { slug: string }[];
  dismiss?: { slug: string }[];
}

/**
 * Turns a proposed sensor or category into a catalog row, on the say-so of a
 * capability someone with `catalog.write` holds (task QIMP5).
 *
 * Approving a sensor is authoring the library, exactly the reasoning QIMP2 already
 * gave for reusing `catalog.write` on the rest of this controller rather than
 * inventing a new capability: the action this endpoint gates is "accept content
 * this workbook proposed", not "edit the device catalog for its own sake" —
 * `device-catalog.write` is what gates that, on `DeviceCatalogController`, and stays
 * there. Anyone who can apply a batch can already write every table this endpoint
 * touches.
 *
 * One transaction for categories-then-sensors-then-decisions, locked on the batch row
 * the same way `CatalogImportApplyService.apply()` is (task QIMP4) — two admins
 * approving the same batch race on the exact same window that gave `ex-1200v` two
 * versions from one batch otherwise. Idempotent by lookup, not by never reaching the
 * code twice: a sensor or category created between the diff and this call, or by
 * the other admin who just released the lock, is a no-op, not a unique-index error.
 */
@Injectable()
export class CatalogImportSensorReviewService {
  constructor(
    private readonly ds: DataSource,
    private readonly diff: CatalogImportDiffService,
    private readonly validator: CatalogImportValidatorService,
  ) {}

  async review(batchId: string, request: SensorReviewRequest, decidedBy: string): Promise<CatalogImportDiff> {
    await this.ds.transaction(async (m) => {
      const batch = await m.getRepository(CatalogImportBatch)
        .createQueryBuilder('batch')
        .setLock('pessimistic_write')
        .where('batch.id = :batchId', { batchId })
        .getOne();
      if (!batch) throw new NotFoundException(`No import batch "${batchId}".`);

      const rows = await m.getRepository(CatalogImportRow).find({ where: { batchId } });
      const capabilityRows = rows.filter((r) => r.sheet === 'sensor_capability');
      const signalRows = rows.filter((r) => r.sheet === 'signal');
      const analysis = capabilityRows.length
        ? await analyzeSensorCapability(m, capabilityRows, signalRows)
        : EMPTY_SENSOR_CAPABILITY_ANALYSIS;

      const proposedSensorBySlug = new Map(analysis.proposedSensors.map((p) => [p.slug, p]));
      const proposedCategoryBySlug = new Map(analysis.proposedCategories.map((p) => [p.slug, p]));

      const approveCategories = request.approveCategories ?? [];
      const approveSensors = request.approve ?? [];
      const dismiss = request.dismiss ?? [];

      // Every slug named has to be one this batch actually proposed, OR one this
      // batch already decided — the lock above serialises two admins approving the
      // same batch, and by the time the second one runs, the first's creations have
      // already resolved that slug out of `analysis.proposedSensors` entirely. That
      // is the race the lock is for: refusing the second caller here would turn
      // "someone else got there first" into an error, when it is a no-op.
      const alreadyDecided = new Set(batch.sensorDecisions.map((d) => `${d.kind}::${d.slug}`));
      for (const { slug } of approveCategories) {
        if (!proposedCategoryBySlug.has(slug) && !alreadyDecided.has(`category::${slug}`)) {
          throw new BadRequestException(`"${slug}" is not a proposed category on this batch.`);
        }
      }
      for (const { slug } of approveSensors) {
        if (!proposedSensorBySlug.has(slug) && !alreadyDecided.has(`sensor::${slug}`)) {
          throw new BadRequestException(`"${slug}" is not a proposed sensor on this batch.`);
        }
      }
      for (const { slug } of dismiss) {
        if (!proposedSensorBySlug.has(slug) && !proposedCategoryBySlug.has(slug)
          && !alreadyDecided.has(`sensor::${slug}`) && !alreadyDecided.has(`category::${slug}`)) {
          throw new BadRequestException(`"${slug}" is not a proposed sensor or category on this batch.`);
        }
      }

      const categoryRepo = m.getRepository(SensorCategory);
      const sensorRepo = m.getRepository(Sensor);
      const categoryIdByName = new Map((await categoryRepo.find()).map((c) => [c.name.trim().toLowerCase(), c.id]));

      // Categories first, in the same transaction, so one call can approve a
      // category and the sensors that need it. `proposal` is absent exactly when
      // the race above let this slug through on `alreadyDecided` — the category
      // already exists (or is about to, via someone else's committed decision), so
      // there is nothing left to create.
      for (const { slug } of approveCategories) {
        const proposal = proposedCategoryBySlug.get(slug);
        if (proposal) {
          const key = proposal.name.trim().toLowerCase();
          if (!categoryIdByName.has(key)) {
            const saved = await categoryRepo.save(categoryRepo.create({ name: proposal.name }));
            categoryIdByName.set(key, saved.id);
          }
        }
        this.recordDecision(batch, { kind: 'category', slug, decision: 'approved', by: decidedBy, at: nowIso() });
      }

      for (const { slug } of approveSensors) {
        const proposal = proposedSensorBySlug.get(slug);
        const already = await sensorRepo.findOne({ where: { slug } });
        if (!already && proposal) {
          let categoryId: string | null = null;
          if (proposal.category) {
            categoryId = categoryIdByName.get(proposal.category.trim().toLowerCase()) ?? null;
            if (!categoryId) {
              // No orphan created: refused rather than writing a sensor whose category
              // does not exist, in the wrong order or at all.
              throw new BadRequestException(
                `Cannot approve sensor "${slug}": its category "${proposal.category}" is neither already `
                  + "in the catalog nor named in this call's approveCategories.",
              );
            }
          }
          await sensorRepo.save(sensorRepo.create({
            sensorName: proposal.name, slug, categoryId, parameterSpecs: [],
          }));
        }
        this.recordDecision(batch, { kind: 'sensor', slug, decision: 'approved', by: decidedBy, at: nowIso() });
      }

      for (const { slug } of dismiss) {
        const kind = proposedSensorBySlug.has(slug) ? 'sensor' as const : 'category' as const;
        this.recordDecision(batch, { kind, slug, decision: 'dismissed', by: decidedBy, at: nowIso() });
      }

      await m.getRepository(CatalogImportBatch).save(batch);
    });

    // Re-validates the whole batch rather than patching the rows this call
    // touched — the author does not re-upload, and this is the entire point:
    // rows that named a now-catalogued sensor resolve on their own.
    await this.validator.validate(batchId);
    return this.diff.buildDiff(batchId);
  }

  /** Replaces any prior decision for the same slug and kind rather than appending —
   * approving the same slug twice, or dismissing then approving it, leaves one row,
   * not a growing history of the same call. */
  private recordDecision(batch: CatalogImportBatch, decision: SensorDecision): void {
    batch.sensorDecisions = [
      ...batch.sensorDecisions.filter((d) => !(d.kind === decision.kind && d.slug === decision.slug)),
      decision,
    ];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
