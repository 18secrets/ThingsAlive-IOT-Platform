import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A published class version's formulas cannot be edited or deleted (D-007, phase 1
 * manual testing, T9).
 *
 * D05 says published definitions are immutable, and the service keeps to it by forking
 * a draft. The database did not: `ck_class_content_draft_only` guarded failure modes,
 * recommendations, layouts and visuals, but not formulas. Run against Development, the
 * app's own role could rewrite a published formula's expression — a KPI changing under
 * alerts and pages already reading that version, the thing D05 exists to prevent. A
 * rule that protects integrity belongs here, where no code path can forget it.
 *
 * The same function and the same events as the tables already guarded, so the seeder's
 * DELETE exemption for seed-only classes applies here too (`seed:demo:reset` removes
 * the demo class's formulas).
 *
 * Deliberately not yet: INSERT into a published version, on any content table, and the
 * sensor-requirement table. Both are open in D-007's follow-up — existing test fixtures
 * publish a class and then add content to it, and need reworking first.
 */
export class PublishedClassImmutable1759300000000 implements MigrationInterface {
  name = 'PublishedClassImmutable1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TRIGGER "trg_equipment_class_formula_draft_only"
        BEFORE UPDATE OR DELETE ON "equipment_class_formula"
        FOR EACH ROW EXECUTE FUNCTION "ck_class_content_draft_only"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_equipment_class_formula_draft_only" ON "equipment_class_formula"`);
  }
}
