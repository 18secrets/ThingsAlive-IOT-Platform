import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import { buildProposedClass, classesIdentical, loadCurrentClass } from './class-content';

export type ClassDiffAction = 'create' | 'new_version' | 'unchanged';

export interface ClassDiffEntry {
  slug: string;
  action: ClassDiffAction;
  countsBySheet: Record<string, number>;
}

export interface RejectedRow {
  sheet: string;
  rowNumber: number;
  reason: string;
}

export interface CatalogImportDiff {
  batchId: string;
  status: string;
  classes: ClassDiffEntry[];
  sensorCapabilities: { valid: number; invalid: number };
  rejectedRows: RejectedRow[];
  partialApplyNote: string;
}

const classSlugOf = (row: CatalogImportRow): string | undefined => {
  const v = row.sheet === 'equipment_class' ? row.payload.slug : row.payload.class_slug;
  return typeof v === 'string' && v ? v : undefined;
};

/**
 * The dry-run diff, and the recent-batches list (tasks QIMP2, QIMP3).
 *
 * Read-only, deliberately: both methods only ever `find()`. Computed fresh on every
 * call rather than cached at validate time, because the catalog can change between a
 * batch being staged and somebody looking at what it would do.
 *
 * "unchanged" shares its definition with `CatalogImportApplyService` — both call
 * `class-content.ts`'s comparison — because a diff and an apply that could disagree
 * about whether a class changed would be a diff nobody could trust: re-uploading the
 * same workbook has to look like nothing happened here for the same reason apply has
 * to actually do nothing (task QIMP3).
 */
@Injectable()
export class CatalogImportDiffService {
  constructor(private readonly ds: DataSource) {}

  async list(): Promise<CatalogImportBatch[]> {
    return this.ds.getRepository(CatalogImportBatch).find({ order: { createdAt: 'DESC' }, take: 50 });
  }

  async buildDiff(batchId: string): Promise<CatalogImportDiff> {
    const batch = await this.ds.getRepository(CatalogImportBatch).findOneOrFail({ where: { id: batchId } });
    const rows = await this.ds.getRepository(CatalogImportRow).find({ where: { batchId } });

    const validRows = rows.filter((r) => r.status === 'parsed' || r.status === 'valid');
    const invalidRows = rows.filter((r) => r.status === 'invalid');

    // Every row that named a class counts as a reference, valid or not: a class that
    // exists but ended up with nothing valid touching it is exactly the "unchanged"
    // case this diff exists to report, not a class this diff has never heard of.
    const referencedSlugs = new Set<string>();
    for (const r of rows) {
      const slug = classSlugOf(r);
      if (slug) referencedSlugs.add(slug);
    }

    const classes: ClassDiffEntry[] = [];
    for (const slug of referencedSlugs) {
      const validForClass = validRows.filter((r) => classSlugOf(r) === slug);
      const countsBySheet: Record<string, number> = {};
      for (const r of validForClass) countsBySheet[r.sheet] = (countsBySheet[r.sheet] ?? 0) + 1;

      const { current, content: currentContent } = await loadCurrentClass(this.ds.manager, slug);
      const proposed = buildProposedClass(validForClass, currentContent);

      // A published version is never mutated (QIMP3), so any real change to an
      // existing class always lands in a new version — "unchanged" means the content
      // that would be written is byte-identical to what the current version already
      // holds, not merely that something touched it.
      const action: ClassDiffAction = !current
        ? 'create'
        : classesIdentical(proposed, currentContent)
          ? 'unchanged'
          : 'new_version';

      classes.push({ slug, action, countsBySheet });
    }
    classes.sort((a, b) => a.slug.localeCompare(b.slug));

    const rejectedRows: RejectedRow[] = [...invalidRows]
      .sort((a, b) => a.sheet.localeCompare(b.sheet) || a.rowNumber - b.rowNumber)
      .map((r) => ({ sheet: r.sheet, rowNumber: r.rowNumber, reason: r.message ?? 'Rejected.' }));

    // Explicit on purpose: a partial apply that looks total, because the response
    // never said some rows would be skipped, is worse than a refusal.
    const partialApplyNote = invalidRows.length
      ? `${invalidRows.length} row(s) are invalid and would be skipped if this batch is applied; `
        + 'every other row would still be written.'
      : 'Every row is valid; nothing would be skipped if this batch is applied.';

    return {
      batchId: batch.id,
      status: batch.status,
      classes,
      sensorCapabilities: {
        valid: validRows.filter((r) => r.sheet === 'sensor_capability').length,
        invalid: invalidRows.filter((r) => r.sheet === 'sensor_capability').length,
      },
      rejectedRows,
      partialApplyNote,
    };
  }
}
