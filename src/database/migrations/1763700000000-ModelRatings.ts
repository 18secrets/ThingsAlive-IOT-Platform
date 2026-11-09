import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rated figures on an equipment model, and a machine naming its model (D57).
 *
 * One class covers a range: a single-phase motor class spans 0.37 to 2.2 kW and rated
 * current differs six-fold across it. Every motor threshold is a ratio to a rating, so
 * the rating has to come from the machine's own model. The workbook's V-01 is what
 * happens otherwise: a firmware constant from a demo motor read a 1 HP pump at 4,600%.
 *
 * `equipment_template` already is Master Admin's make/model library and already copies
 * to the account, so it carries the ratings rather than a third table of models. Until
 * now nothing referenced a template after onboarding; from here a machine may, and a
 * template a machine names cannot be deleted from under it.
 *
 * Which model a machine is lives in `equipment_model`, beside `equipment_profile`
 * rather than as a column on it (D06's shape: 2.0 owns a table beside a row instead of
 * widening it). The profile is read by nearly every path in the platform, including
 * specs that roll the schema back past this migration and read it through its entity.
 *
 * A rating has no unit column. Its unit is the rating's own, fixed by `rating_parameter`
 * (the database's copy of the D56 ratings in `parameter-catalog.ts`; a test holds the
 * two equal). A unit stored per row could disagree with that; a unit that is not stored
 * cannot.
 */
export class ModelRatings1763700000000 implements MigrationInterface {
  name = 'ModelRatings1763700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "rating_parameter" (
        "name" text PRIMARY KEY,
        "unit" text
      )`);
    await q.query(`
      INSERT INTO "rating_parameter" ("name", "unit") VALUES
        ('rated_voltage', 'V'), ('rated_current', 'A'), ('rated_frequency', 'Hz'),
        ('poles', NULL), ('phases', NULL), ('rated_output', 'kW'),
        ('rated_power_factor', NULL), ('rated_efficiency', NULL), ('rated_slip', NULL),
        ('rated_temp_rise', 'degC'), ('thermal_time_constant', 's'), ('insulation_temp_limit', 'degC'),
        ('voltage_min_operating', 'V'), ('voltage_max_operating', 'V'),
        ('voltage_warn_low', 'V'), ('voltage_warn_high', 'V'),
        ('locked_rotor_multiple', NULL), ('max_starts_per_hour', NULL),
        ('install_head', 'm'), ('ambient_temp_reference', 'degC')`);
    // Reference data: read by everyone, written only by a migration.
    await q.query(`GRANT SELECT ON "rating_parameter" TO "ta_app"`);

    // Which class the model is a model of. Text, like `equipment_profile`'s own slug:
    // classes are versioned by (slug, version), and a model fits the class, not one version.
    await q.query(`ALTER TABLE "equipment_template" ADD COLUMN "equipment_class_slug" text`);
    await q.query(`ALTER TABLE "client_equipment_template" ADD COLUMN "equipment_class_slug" text`);

    await q.query(`
      CREATE TABLE "equipment_template_rating" (
        "template_id" uuid NOT NULL REFERENCES "equipment_template" ("id") ON DELETE CASCADE,
        "name" text NOT NULL CONSTRAINT "fk_equipment_template_rating_name" REFERENCES "rating_parameter" ("name"),
        "value" double precision NOT NULL,
        "source" text NOT NULL,
        "updated_by" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("template_id", "name"),
        -- double precision admits NaN and infinity; neither is a rating, and either would
        -- reach a KPI tile as a number.
        CONSTRAINT "ck_equipment_template_rating_finite"
          CHECK ("value" <> 'NaN'::float8 AND "value" <> 'Infinity'::float8 AND "value" <> '-Infinity'::float8),
        -- Every rated value names the datasheet or catalogue page it came from (workbook
        -- step A2). A figure nobody can trace is a figure nobody can correct.
        CONSTRAINT "ck_equipment_template_rating_source" CHECK (length(btrim("source")) > 0)
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_template_rating" TO "ta_app"`);

    // The target of the composite key below. `id` is already unique; this lets a machine
    // reference (its own tenant, a model) as one pair the database checks together.
    await q.query(`
      ALTER TABLE "client_equipment_template"
        ADD CONSTRAINT "uq_client_equipment_template_tenant_id" UNIQUE ("tenant_id", "id")`);

    await q.query(`
      CREATE TABLE "client_equipment_template_rating" (
        "tenant_id" text NOT NULL,
        "template_id" uuid NOT NULL,
        "name" text NOT NULL CONSTRAINT "fk_client_equipment_template_rating_name" REFERENCES "rating_parameter" ("name"),
        "value" double precision NOT NULL,
        "source" text NOT NULL,
        "updated_by" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "template_id", "name"),
        CONSTRAINT "fk_client_equipment_template_rating_template"
          FOREIGN KEY ("tenant_id", "template_id")
          REFERENCES "client_equipment_template" ("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "ck_client_equipment_template_rating_finite"
          CHECK ("value" <> 'NaN'::float8 AND "value" <> 'Infinity'::float8 AND "value" <> '-Infinity'::float8),
        CONSTRAINT "ck_client_equipment_template_rating_source" CHECK (length(btrim("source")) > 0)
      )`);
    await q.query(`ALTER TABLE "client_equipment_template_rating" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_equipment_template_rating" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_equipment_template_rating"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_equipment_template_rating" TO "ta_app"`);

    // A machine names one of its own account's models. Both keys include the tenant, so a
    // machine cannot be pointed at another account's model, nor a link written for another
    // account's machine, even by a query that forgot its filter. RESTRICT on the model:
    // deleting one a machine reads its ratings from would turn every one of its motor KPIs
    // to not_configured, silently, from somebody else's screen. CASCADE on the machine: a
    // deleted machine has no model to remember.
    await q.query(`
      ALTER TABLE "equipment_profile"
        ADD CONSTRAINT "uq_equipment_profile_tenant_id" UNIQUE ("tenant_id", "id")`);
    await q.query(`
      CREATE TABLE "equipment_model" (
        "tenant_id" text NOT NULL,
        "equipment_id" uuid NOT NULL,
        "client_equipment_template_id" uuid NOT NULL,
        "assigned_by" text NOT NULL,
        "assigned_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "equipment_id"),
        CONSTRAINT "fk_equipment_model_equipment"
          FOREIGN KEY ("tenant_id", "equipment_id")
          REFERENCES "equipment_profile" ("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "fk_equipment_model_template"
          FOREIGN KEY ("tenant_id", "client_equipment_template_id")
          REFERENCES "client_equipment_template" ("tenant_id", "id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "ix_equipment_model_template" ON "equipment_model" ("tenant_id", "client_equipment_template_id")`);
    await q.query(`ALTER TABLE "equipment_model" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "equipment_model" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "equipment_model"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_model" TO "ta_app"`);

    // Parameter resolution now reads a machine's model, and the evaluation replay
    // resolves parameters as `ta_eval` (EvaluationReplayReads1761600000000 granted it
    // `tenant_parameter` for the same reason). Reads only, as there.
    for (const table of ['rating_parameter', 'equipment_model', 'client_equipment_template_rating']) {
      await q.query(`GRANT SELECT ON "${table}" TO "ta_eval"`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "equipment_model"`);
    await q.query(`ALTER TABLE "equipment_profile" DROP CONSTRAINT IF EXISTS "uq_equipment_profile_tenant_id"`);
    await q.query(`DROP TABLE IF EXISTS "client_equipment_template_rating"`);
    await q.query(`ALTER TABLE "client_equipment_template" DROP CONSTRAINT IF EXISTS "uq_client_equipment_template_tenant_id"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_template_rating"`);
    await q.query(`ALTER TABLE "client_equipment_template" DROP COLUMN IF EXISTS "equipment_class_slug"`);
    await q.query(`ALTER TABLE "equipment_template" DROP COLUMN IF EXISTS "equipment_class_slug"`);
    await q.query(`DROP TABLE IF EXISTS "rating_parameter"`);
  }
}
