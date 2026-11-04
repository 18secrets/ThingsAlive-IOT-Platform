import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The figures a fuel prediction needs before a machine has any history (fuel test report
 * of 3 Nov 2026: FU-1, FU-3, FU-5; TC-FP-05, -07, -08, -09).
 *
 * The forecast of D50 learns a machine's shift from its own last 28 days, so a machine
 * on its first day is forecast at nothing, and the one figure the library did hold — the
 * nominal — was shown as "OEM figure" with no way to say which datasheet it came from.
 * This adds the place for the physics a cold-start prediction is made of, not the values:
 * every column is NULL until the library team authors it from a datasheet, because an
 * invented rated power or BSFC would be a confident wrong litre count on every machine
 * of the class at once (G07). A class that lacks one is reported as blocked on it, by name.
 *
 * - `nominal_fuel_source`: where the existing nominal came from. Only beside a nominal.
 * - `rated_power_kw`, `working_load_pct`, `bsfc_g_per_kwh`: litres per working hour from
 *   power × load × BSFC ÷ diesel density. The three come together, and a BSFC carries
 *   `bsfc_source`, its datasheet: it is the number the litres stand on.
 * - `idle_fuel_per_hour`: the idle burn, which is not load-proportional, in L/h.
 * - `working_share`: of a shift's hours, the part spent working; the rest is idle.
 *
 * Constraints rather than service checks for the reason `1759800000000-ClassOemFigures`
 * gives: a class arrives through the import and the authoring API, and a rule only one of
 * them checks is one the other walks past.
 */
export class ClassFuelFigures1763400000000 implements MigrationInterface {
  name = 'ClassFuelFigures1763400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        ADD COLUMN "nominal_fuel_source" text,
        ADD COLUMN "rated_power_kw" double precision,
        ADD COLUMN "working_load_pct" double precision,
        ADD COLUMN "bsfc_g_per_kwh" double precision,
        ADD COLUMN "bsfc_source" text,
        ADD COLUMN "idle_fuel_per_hour" double precision,
        ADD COLUMN "working_share" double precision`);

    await q.query(`
      ALTER TABLE "equipment_class_profile"
        ADD CONSTRAINT "ck_class_nominal_fuel_source"
          CHECK ("nominal_fuel_source" IS NULL
                 OR ("nominal_fuel_per_hour" IS NOT NULL AND btrim("nominal_fuel_source") <> '')),
        ADD CONSTRAINT "ck_class_rated_power_positive"
          CHECK ("rated_power_kw" IS NULL OR "rated_power_kw" > 0),
        ADD CONSTRAINT "ck_class_working_load_pct"
          CHECK ("working_load_pct" IS NULL OR ("working_load_pct" > 0 AND "working_load_pct" <= 100)),
        ADD CONSTRAINT "ck_class_bsfc_positive"
          CHECK ("bsfc_g_per_kwh" IS NULL OR "bsfc_g_per_kwh" > 0),
        ADD CONSTRAINT "ck_class_bsfc_complete"
          CHECK ("bsfc_g_per_kwh" IS NULL
                 OR ("rated_power_kw" IS NOT NULL AND "working_load_pct" IS NOT NULL
                     AND "bsfc_source" IS NOT NULL AND btrim("bsfc_source") <> '')),
        ADD CONSTRAINT "ck_class_bsfc_source_only_with_bsfc"
          CHECK ("bsfc_source" IS NULL OR "bsfc_g_per_kwh" IS NOT NULL),
        ADD CONSTRAINT "ck_class_idle_fuel_positive"
          CHECK ("idle_fuel_per_hour" IS NULL OR "idle_fuel_per_hour" > 0),
        ADD CONSTRAINT "ck_class_working_share"
          CHECK ("working_share" IS NULL OR ("working_share" > 0 AND "working_share" <= 1))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        DROP CONSTRAINT IF EXISTS "ck_class_working_share",
        DROP CONSTRAINT IF EXISTS "ck_class_idle_fuel_positive",
        DROP CONSTRAINT IF EXISTS "ck_class_bsfc_source_only_with_bsfc",
        DROP CONSTRAINT IF EXISTS "ck_class_bsfc_complete",
        DROP CONSTRAINT IF EXISTS "ck_class_bsfc_positive",
        DROP CONSTRAINT IF EXISTS "ck_class_working_load_pct",
        DROP CONSTRAINT IF EXISTS "ck_class_rated_power_positive",
        DROP CONSTRAINT IF EXISTS "ck_class_nominal_fuel_source",
        DROP COLUMN IF EXISTS "working_share",
        DROP COLUMN IF EXISTS "idle_fuel_per_hour",
        DROP COLUMN IF EXISTS "bsfc_source",
        DROP COLUMN IF EXISTS "bsfc_g_per_kwh",
        DROP COLUMN IF EXISTS "working_load_pct",
        DROP COLUMN IF EXISTS "rated_power_kw",
        DROP COLUMN IF EXISTS "nominal_fuel_source"`);
  }
}
