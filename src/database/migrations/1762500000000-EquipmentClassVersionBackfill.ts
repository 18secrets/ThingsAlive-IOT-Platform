import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Classified machines with no class version take the one their account's class copy
 * was forked from.
 *
 * Machines created through the API, the assistant or a fleet workbook were saved with
 * a class slug and a null `class_version`, and every catalog reader — forecasts,
 * recommendations, OEE, workflows — reads a null version as "nothing declared". They
 * were never forecast, and nothing said so. `pinnedClassVersion` now sets it on create
 * and on a change of class; this mends the rows made before it did, by the same rule.
 *
 * Only where the account holds the class and its copy still carries the template's
 * slug. A slug the account does not hold, or a copy renamed away from its template,
 * names no library version, so the row stays null rather than borrow one.
 *
 * Down leaves the versions in place. The null was the defect; putting it back would
 * stop the forecasts again, and a backfilled row is not otherwise told apart from one
 * the fixed code wrote.
 */
export class EquipmentClassVersionBackfill1762500000000 implements MigrationInterface {
  name = 'EquipmentClassVersionBackfill1762500000000';

  public async up(q: QueryRunner): Promise<void> {
    // Every tenant's rows, as the migration login sees them (the owner, as for every data
    // migration here). The tenant bypass is only ever set by tenant-session.ts; CI holds that.
    await q.query(`
      UPDATE "equipment_profile" p
         SET "class_version" = c."template_version"
        FROM "client_equipment_class" c
       WHERE p."class_version" IS NULL AND p."equipment_class_slug" IS NOT NULL
         AND c."tenant_id" = p."tenant_id" AND c."slug" = p."equipment_class_slug"
         AND c."template_slug" = c."slug" AND c."template_version" IS NOT NULL`);
  }

  public async down(): Promise<void> {
    // Intentionally empty: see the class comment.
  }
}
