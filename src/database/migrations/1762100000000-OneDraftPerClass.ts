import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * At most one draft per equipment class slug (tester bug TC_127).
 *
 * Catalog import mints a fresh version for every changed upload and never reuses a
 * draft — deliberately, see catalog-import-apply.service.ts. Nothing retired the draft
 * it replaced, so a publish that failed, followed by a corrected re-upload, left v1 a
 * draft beside v2. Publishing v2 then left v1 behind: the Equipment Classes card
 * prefers a draft, so it showed v1 with a Publish button that would have retired v2.
 *
 * The importer now retires the draft it replaces. This is the rule underneath it, in
 * the database because a service check loses to a concurrent write: two uploads for
 * the same class, applied at once from different batches, each find no draft to
 * retire and each insert one.
 *
 * Existing rows are brought into line first, or the index cannot be built: of several
 * drafts only the newest stays, and a draft older than the published version is
 * retired too — publishing it would retire the newer version, never the intent.
 * `down` drops the index only. The drafts it retired stay retired: they were already
 * unreachable from every screen, and a down path that resurrected them would recreate
 * the exact state this exists to end.
 */
export class OneDraftPerClass1762100000000 implements MigrationInterface {
  name = 'OneDraftPerClass1762100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "equipment_class_profile" p
         SET "status" = 'retired'
       WHERE p."status" = 'draft'
         AND EXISTS (
           SELECT 1 FROM "equipment_class_profile" n
            WHERE n."slug" = p."slug"
              AND n."version" > p."version"
              AND n."status" IN ('draft', 'published')
         )
    `);
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_class_profile_one_draft"
          ON "equipment_class_profile" ("slug") WHERE "status" = 'draft'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "uq_equipment_class_profile_one_draft"`);
  }
}
