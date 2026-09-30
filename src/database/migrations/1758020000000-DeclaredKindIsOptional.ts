import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `equipment_class_formula.result_kind` had a `NOT NULL DEFAULT 'scalar'`
 * (`1758010000000-FormulaCompilerMetadata.ts`) — the wrong default, discovered by
 * task QCE1.1's `#formula_key` composition work, not something that default was
 * ever asked to mean.
 *
 * A value nobody supplied is not a declaration. Every formula written through the
 * catalog-import path leaves `result_kind` unset, and the DEFAULT turned that
 * silence into "the author said scalar" — so a perfectly legitimate series-valued
 * formula (`105 - coolant_temp_c`, a signal reference with no aggregation) refused
 * to publish for disagreeing with a value nobody actually declared. `display_unit`,
 * the same shape of column added in the same migration, was already nullable with
 * no default — this brings `result_kind` in line with it, not the other way round.
 *
 * Nothing has been published through this column yet (task QCE1 and QCE1.1 are
 * still in flight on this branch), so the backfill blanket-clears every row to
 * NULL rather than trying to infer which rows meant it and which didn't.
 */
export class DeclaredKindIsOptional1758020000000 implements MigrationInterface {
  name = 'DeclaredKindIsOptional1758020000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "equipment_class_formula" SET "result_kind" = NULL`);
    await q.query(`ALTER TABLE "equipment_class_formula" ALTER COLUMN "result_kind" DROP DEFAULT`);
    await q.query(`ALTER TABLE "equipment_class_formula" ALTER COLUMN "result_kind" DROP NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "equipment_class_formula" SET "result_kind" = 'scalar' WHERE "result_kind" IS NULL`);
    await q.query(`ALTER TABLE "equipment_class_formula" ALTER COLUMN "result_kind" SET NOT NULL`);
    await q.query(`ALTER TABLE "equipment_class_formula" ALTER COLUMN "result_kind" SET DEFAULT 'scalar'`);
  }
}
