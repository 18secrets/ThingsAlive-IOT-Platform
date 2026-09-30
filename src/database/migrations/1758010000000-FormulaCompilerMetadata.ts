import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KPI presentation metadata for a formula, and where the compiler records what it
 * proved (task QCE1).
 *
 * `1757970000000-LibraryStructure.ts` is already committed, so this alters rather
 * than replaces it: `equipment_class_formula` already carries `compiled_plan`,
 * `compiled_at` and `compiler_version`, reserved and unused until now. Published
 * versions are immutable, so every column here is additive with a default that
 * leaves an existing row valid — nothing already written changes meaning.
 *
 * `result_unit`, `required_signals` and `required_parameters` are never
 * author-supplied — the compiler derives all three from the expression itself, so
 * no author can forget to declare a parameter QPARAM1 will need to read.
 */
export class FormulaCompilerMetadata1758010000000 implements MigrationInterface {
  name = 'FormulaCompilerMetadata1758010000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "result_kind" text NOT NULL DEFAULT 'scalar'`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_result_kind"
        CHECK ("result_kind" IN ('scalar', 'series'))`);

    // The unit the author intends. No default — there is no unit that is correct
    // for an existing row by construction, so it stays null until compilation infers
    // one and a person confirms it belongs there.
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "display_unit" text`);
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "display_format" text NOT NULL DEFAULT 'number:1'`);

    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "target_value" double precision`);
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "target_min" double precision`);
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "target_max" double precision`);

    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "target_direction" text NOT NULL DEFAULT 'none'`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_target_direction"
        CHECK ("target_direction" IN ('higher_better', 'lower_better', 'band', 'none'))`);
    // A band with no band, or a direction with nothing to be higher or lower than,
    // is a target that renders as a checkmark nobody can explain.
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_target_band"
        CHECK ("target_direction" <> 'band' OR ("target_min" IS NOT NULL AND "target_max" IS NOT NULL))`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_target_directional"
        CHECK ("target_direction" NOT IN ('higher_better', 'lower_better') OR "target_value" IS NOT NULL)`);

    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "comparison_basis" text NOT NULL DEFAULT 'none'`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_comparison_basis"
        CHECK ("comparison_basis" IN ('none', 'previous_period', 'target'))`);

    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "aggregation_window" text NOT NULL DEFAULT 'shift'`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_aggregation_window"
        CHECK ("aggregation_window" IN ('shift', 'today', '24h', '7d', '30d', 'mtd', 'ytd'))`);

    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "chart_type" text NOT NULL DEFAULT 'none'`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_chart_type"
        CHECK ("chart_type" IN ('none', 'line', 'bar', 'area', 'gauge'))`);

    // Derived at compile time; blank until a formula has actually been compiled once.
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "result_unit" text`);
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "required_signals" text[] NOT NULL DEFAULT '{}'`);
    await q.query(`ALTER TABLE "equipment_class_formula" ADD COLUMN "required_parameters" text[] NOT NULL DEFAULT '{}'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Constraints first — a CHECK constraint is a dependent object of the columns it
    // names, and Postgres refuses to drop a column still referenced by one. Same
    // convention as `1757990000000-CatalogImportProvenance.ts`.
    for (const constraint of [
      'ck_class_formula_chart_type', 'ck_class_formula_aggregation_window',
      'ck_class_formula_comparison_basis', 'ck_class_formula_target_directional',
      'ck_class_formula_target_band', 'ck_class_formula_target_direction',
      'ck_class_formula_result_kind',
    ]) {
      await q.query(`ALTER TABLE "equipment_class_formula" DROP CONSTRAINT IF EXISTS "${constraint}"`);
    }
    for (const column of [
      'required_parameters', 'required_signals', 'result_unit',
      'chart_type', 'aggregation_window', 'comparison_basis',
      'target_direction', 'target_max', 'target_min', 'target_value',
      'display_format', 'display_unit', 'result_kind',
    ]) {
      await q.query(`ALTER TABLE "equipment_class_formula" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
