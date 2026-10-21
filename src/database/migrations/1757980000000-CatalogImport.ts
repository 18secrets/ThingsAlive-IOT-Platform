import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staging for the Excel catalog import (task QIMP1).
 *
 * Platform-owned, exactly like `equipment_class_profile`: an uploaded workbook and its
 * rows describe library content for every tenant that will eventually see it, not one
 * account's data, so neither table carries a tenant_id and neither has a row-level-
 * security policy.
 *
 * Nothing here is a catalog table. A batch stages what a workbook said; only a later
 * apply step (QIMP3) writes `equipment_class_profile`, `equipment_class_sensor_requirement`,
 * `sensor_role_capability` or `equipment_class_formula` — and only for rows that have
 * already been checked.
 */
export class CatalogImport1757980000000 implements MigrationInterface {
  name = 'CatalogImport1757980000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "catalog_import_batch" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "filename" text NOT NULL,
        "checksum_sha256" text NOT NULL,
        "template_version" text NOT NULL,
        "uploaded_by" text NOT NULL,
        "status" text NOT NULL DEFAULT 'parsed',
        "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "applied_at" timestamptz,
        "applied_by" text
      )`);
    await q.query(`
      ALTER TABLE "catalog_import_batch" ADD CONSTRAINT "ck_catalog_import_batch_status"
        CHECK ("status" IN ('parsed', 'validated', 'rejected', 'applied'))`);
    // The same workbook cannot be staged twice — re-uploading the same bytes is either
    // a mistake or somebody who lost track of what they already sent.
    await q.query(`
      CREATE UNIQUE INDEX "uq_catalog_import_batch_checksum" ON "catalog_import_batch" ("checksum_sha256")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "catalog_import_batch" TO "ta_app"`);

    await q.query(`
      CREATE TABLE "catalog_import_row" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "batch_id" uuid NOT NULL REFERENCES "catalog_import_batch" ("id") ON DELETE CASCADE,
        "sheet" text NOT NULL,
        "row_number" int NOT NULL,
        "entity_kind" text NOT NULL,
        "payload" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'parsed',
        "message" text,
        "target_ref" text
      )`);
    await q.query(`
      ALTER TABLE "catalog_import_row" ADD CONSTRAINT "ck_catalog_import_row_status"
        CHECK ("status" IN ('parsed', 'valid', 'invalid', 'applied', 'skipped'))`);
    // A row's coordinate within its own batch — the same number the person who wrote
    // the workbook can see, so it can never mean two different rows.
    await q.query(`
      CREATE UNIQUE INDEX "uq_catalog_import_row" ON "catalog_import_row" ("batch_id", "sheet", "row_number")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "catalog_import_row" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "catalog_import_row"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_import_batch"`);
  }
}
