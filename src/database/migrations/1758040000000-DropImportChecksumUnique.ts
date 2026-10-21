import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the uniqueness on `catalog_import_batch.checksum_sha256` (task QIMP4).
 *
 * The import loop is upload -> read the diff -> fix -> upload again, and the fix is
 * routinely outside the workbook — creating a missing sensor capability, say — so the
 * file itself is byte-identical and its checksum does not change. The constraint then
 * refused the second upload outright, and renaming the file does not help: the
 * checksum is content, not a filename. There was never a second upload that reached
 * `apply` and did anything: `CatalogImportApplyService` already refuses to write a
 * class version identical to the one already published (`class-content.ts`'s
 * `classesIdentical`), so identical content mints nothing regardless of how many
 * batches carry it. The unique index was solving a problem the apply side already
 * solved, at the cost of blocking the one workflow the whole feature exists to
 * support.
 *
 * The column stays — it is useful provenance, and `CatalogImportDiffService` now uses
 * it to note "identical to batch X" rather than refuse.
 */
export class DropImportChecksumUnique1758040000000 implements MigrationInterface {
  name = 'DropImportChecksumUnique1758040000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_catalog_import_batch_checksum"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restores the exact original constraint. If two batches with the same checksum
    // exist when this runs, the down path itself fails on the real unique-index
    // build — which is the correct failure: reversing this migration is exactly the
    // operation that would reintroduce the bug this migration exists to fix, and it
    // should say so rather than silently picking a survivor.
    await q.query(`
      CREATE UNIQUE INDEX "uq_catalog_import_batch_checksum" ON "catalog_import_batch" ("checksum_sha256")`);
  }
}
