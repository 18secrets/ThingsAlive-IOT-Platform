import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = [
  'equipment_class_profile', 'equipment_class_sensor_requirement',
  'equipment_class_formula', 'sensor_role_capability',
];

/**
 * Provenance for library content (task QIMP3).
 *
 * None of the four tables QIMP3 writes to carry any record of where a row came from
 * — QL1 and the catalog's own authoring tables predate the import entirely. A value
 * nobody can trace back to a file and a row is a value nobody can correct, so every
 * one of them gains `source` (default `'manual'`, so nothing already written changes
 * meaning) and a nullable `import_batch_id` pointing at the workbook that wrote it,
 * when one did.
 *
 * A separate migration rather than editing 1757970000000-LibraryStructure.ts: that
 * one is already committed.
 */
export class CatalogImportProvenance1757990000000 implements MigrationInterface {
  name = 'CatalogImportProvenance1757990000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await q.query(`ALTER TABLE "${table}" ADD COLUMN "source" text NOT NULL DEFAULT 'manual'`);
      await q.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "ck_${table}_source"
          CHECK ("source" IN ('manual', 'excel-import'))`);
      await q.query(`
        ALTER TABLE "${table}" ADD COLUMN "import_batch_id" uuid REFERENCES "catalog_import_batch" ("id")`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "import_batch_id"`);
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "ck_${table}_source"`);
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "source"`);
    }
  }
}
