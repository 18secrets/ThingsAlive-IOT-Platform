import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';

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
 * The dry-run diff, and the recent-batches list (task QIMP2).
 *
 * Read-only, deliberately: both methods only ever `find()`. Computed fresh on every
 * call rather than cached at validate time, because the catalog can change between a
 * batch being staged and somebody looking at what it would do.
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

    const existing = referencedSlugs.size
      ? await this.ds.getRepository(EquipmentClassProfile).find({ where: { slug: In([...referencedSlugs]) } })
      : [];
    const existingSlugs = new Set(existing.map((c) => c.slug));

    const classes: ClassDiffEntry[] = [...referencedSlugs].map((slug) => {
      const validForClass = validRows.filter((r) => classSlugOf(r) === slug);
      const countsBySheet: Record<string, number> = {};
      for (const r of validForClass) countsBySheet[r.sheet] = (countsBySheet[r.sheet] ?? 0) + 1;

      // Content for an existing class always versions on touch (QIMP3): a published
      // version is immutable, so any valid row targeting it needs a new one to land
      // in. "unchanged" is therefore not "identical content" but "nothing valid
      // actually reaches this class" — everything that named it was itself invalid.
      const action: ClassDiffAction = !existingSlugs.has(slug)
        ? 'create'
        : validForClass.length > 0
          ? 'new_version'
          : 'unchanged';

      return { slug, action, countsBySheet };
    }).sort((a, b) => a.slug.localeCompare(b.slug));

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
