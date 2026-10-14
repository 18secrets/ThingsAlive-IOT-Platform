import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The OEM figures OEE needs, on the library class (task QCLASS-OEM).
 *
 * QOEE1 stopped at its own precondition: the library had nowhere to hold a nominal
 * fuel consumption, a breakdown threshold or the two signals the breakdown detector
 * reads. This adds the place, not the values. Every existing class keeps a NULL
 * nominal — invented, it would be a wrong Quality on every machine of the class at
 * once — and gets the task's stated 30-minute threshold.
 *
 * The rules are constraints rather than service checks because a class reaches this
 * table through two doors, the import and the authoring API, and a rule enforced by
 * one door is decoration the other walks past. The import validator and publish say
 * the same things in sentences, with row numbers; these are what hold regardless.
 *
 * "Declared" means `expected_signals`, the declaration QL1's role trigger already
 * trusts. Checked on every write, draft included: a draft naming a signal it does not
 * declare cannot be published into a correct one without being rewritten anyway.
 */
export class ClassOemFigures1759800000000 implements MigrationInterface {
  name = 'ClassOemFigures1759800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        ADD COLUMN "nominal_fuel_per_hour" double precision,
        ADD COLUMN "nominal_fuel_unit" text,
        ADD COLUMN "idle_breakdown_threshold_minutes" integer NOT NULL DEFAULT 30,
        ADD COLUMN "running_signal" text,
        ADD COLUMN "running_idle_bound" double precision,
        ADD COLUMN "availability_signal" text`);

    await q.query(`
      ALTER TABLE "equipment_class_profile"
        ADD CONSTRAINT "ck_class_nominal_fuel_positive"
          CHECK ("nominal_fuel_per_hour" IS NULL OR "nominal_fuel_per_hour" > 0),
        ADD CONSTRAINT "ck_class_nominal_fuel_unit"
          CHECK (("nominal_fuel_per_hour" IS NULL) = ("nominal_fuel_unit" IS NULL)
                 AND ("nominal_fuel_unit" IS NULL OR btrim("nominal_fuel_unit") <> '')),
        ADD CONSTRAINT "ck_class_idle_breakdown_threshold"
          CHECK ("idle_breakdown_threshold_minutes" >= 5),
        ADD CONSTRAINT "ck_class_running_signal_bound"
          CHECK (("running_signal" IS NULL) = ("running_idle_bound" IS NULL)),
        ADD CONSTRAINT "ck_class_oee_signals_declared"
          CHECK (("running_signal" IS NULL
                  OR "expected_signals" @> jsonb_build_array(jsonb_build_object('signal', "running_signal")))
             AND ("availability_signal" IS NULL
                  OR "expected_signals" @> jsonb_build_array(jsonb_build_object('signal', "availability_signal"))))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        DROP CONSTRAINT IF EXISTS "ck_class_oee_signals_declared",
        DROP CONSTRAINT IF EXISTS "ck_class_running_signal_bound",
        DROP CONSTRAINT IF EXISTS "ck_class_idle_breakdown_threshold",
        DROP CONSTRAINT IF EXISTS "ck_class_nominal_fuel_unit",
        DROP CONSTRAINT IF EXISTS "ck_class_nominal_fuel_positive",
        DROP COLUMN IF EXISTS "availability_signal",
        DROP COLUMN IF EXISTS "running_idle_bound",
        DROP COLUMN IF EXISTS "running_signal",
        DROP COLUMN IF EXISTS "idle_breakdown_threshold_minutes",
        DROP COLUMN IF EXISTS "nominal_fuel_unit",
        DROP COLUMN IF EXISTS "nominal_fuel_per_hour"`);
  }
}
