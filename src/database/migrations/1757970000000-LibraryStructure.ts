import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The equipment library: what a class of machine needs, what a catalogued sensor can
 * supply, and the formulas that turn a reading into an answer (task QL1).
 *
 * All three tables are platform-owned, exactly like `equipment_class_profile`: one
 * row describes a requirement or a formula for every tenant that owns the class, so
 * none of them carries a tenant column and row-level security has nothing to match on.
 * `sensor_role_capability` is the same shape for the same reason — `sensor` is a
 * catalogued definition, not a tenant's fitted instance.
 *
 * Nothing here evaluates a formula or scores coverage. This is the data a later task
 * reads; writing it correctly is the whole job.
 */
export class LibraryStructure1757970000000 implements MigrationInterface {
  name = 'LibraryStructure1757970000000';

  public async up(q: QueryRunner): Promise<void> {
    // --------------------------------------------------------- sensor requirements
    await q.query(`
      CREATE TABLE "equipment_class_sensor_requirement" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "measurement_role" text NOT NULL,
        "component_scope" text NOT NULL DEFAULT '',
        "criticality" text NOT NULL DEFAULT 'required',
        "min_count" int NOT NULL DEFAULT 1,
        "canonical_unit" text,
        "enables" text[] NOT NULL DEFAULT '{}',
        "notes" text,
        -- Legal because uq_equipment_class_profile_version already exists.
        CONSTRAINT "fk_sensor_requirement_class"
          FOREIGN KEY ("class_slug", "class_version")
          REFERENCES "equipment_class_profile" ("slug", "version")
      )`);
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement" ADD CONSTRAINT "ck_sensor_requirement_criticality"
        CHECK ("criticality" IN ('required', 'recommended', 'optional'))`);
    // A composite machine legitimately needs two probes for one role — min_count says
    // how many, but zero is not "none required", it is a requirement nothing can satisfy.
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement" ADD CONSTRAINT "ck_sensor_requirement_min_count"
        CHECK ("min_count" >= 1)`);
    // What a missing role blocks, so readiness can name the intelligence layer instead
    // of reporting a single ready/not flag.
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement" ADD CONSTRAINT "ck_sensor_requirement_enables"
        CHECK ("enables" <@ ARRAY[
          'data_quality', 'physics_calculation', 'physics_forecast', 'approved_rule',
          'statistical_anomaly', 'recommendation_ai', 'predictive_ml', 'agent_action'
        ]::text[])`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_sensor_requirement" ON "equipment_class_sensor_requirement"
        ("class_slug", "class_version", "measurement_role", "component_scope")`);
    await q.query(`
      CREATE INDEX "ix_sensor_requirement_class" ON "equipment_class_sensor_requirement"
        ("class_slug", "class_version")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_class_sensor_requirement" TO "ta_app"`);

    // A required role the class never declares in expected_signals makes coverage
    // permanently unreachable and looks forever like a data problem rather than a typo
    // in a spreadsheet. Enforced here, not only in a service, because a service check
    // loses to a concurrent write.
    await q.query(`
      CREATE FUNCTION "ck_sensor_requirement_role_declared"() RETURNS trigger AS $$
      DECLARE
        class_exists boolean;
        declared boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM "equipment_class_profile" ecp
          WHERE ecp."slug" = NEW."class_slug" AND ecp."version" = NEW."class_version"
        ) INTO class_exists;

        -- A class/version that does not exist at all is the foreign key's failure to
        -- report, with its own name — not this trigger's, which only has an opinion
        -- once the class it is asking about actually exists.
        IF NOT class_exists THEN
          RETURN NEW;
        END IF;

        SELECT EXISTS (
          SELECT 1
          FROM "equipment_class_profile" ecp,
               jsonb_array_elements(ecp."expected_signals") sig
          WHERE ecp."slug" = NEW."class_slug"
            AND ecp."version" = NEW."class_version"
            AND sig ->> 'signal' = NEW."measurement_role"
        ) INTO declared;

        IF NOT declared THEN
          RAISE EXCEPTION
            'measurement_role "%" is not declared in expected_signals for class %/% (ck_sensor_requirement_role_declared)',
            NEW."measurement_role", NEW."class_slug", NEW."class_version";
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_sensor_requirement_role_declared"
        BEFORE INSERT OR UPDATE ON "equipment_class_sensor_requirement"
        FOR EACH ROW EXECUTE FUNCTION "ck_sensor_requirement_role_declared"()`);

    // ------------------------------------------------------------- sensor capability
    // What answers "which catalogued sensor could satisfy this unmet requirement".
    await q.query(`
      CREATE TABLE "sensor_role_capability" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sensor_id" uuid NOT NULL REFERENCES "sensor" ("id") ON DELETE CASCADE,
        "measurement_role" text NOT NULL,
        "parameter_key" text,
        "canonical_unit" text
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_sensor_role_capability" ON "sensor_role_capability"
        ("sensor_id", "measurement_role", "parameter_key")`);
    await q.query(`
      CREATE INDEX "ix_sensor_role_capability_role" ON "sensor_role_capability" ("measurement_role")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "sensor_role_capability" TO "ta_app"`);

    // ------------------------------------------------------------------------ formulas
    // The expression is stored, never evaluated, in this slice. Formulas are written by
    // domain people and loaded as data; the evaluator is a later task.
    await q.query(`
      CREATE TABLE "equipment_class_formula" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "formula_key" text NOT NULL,
        "kind" text NOT NULL,
        "expression" text NOT NULL,
        "inputs" text[] NOT NULL DEFAULT '{}',
        "output_unit" text,
        "basis" text,
        "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" text NOT NULL DEFAULT 'proposed',
        "approved_by" text,
        "approved_at" timestamptz,
        "version" int NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        -- Written by the approval step, never by the importer.
        "compiled_plan" jsonb,
        "compiled_at" timestamptz,
        "compiler_version" text,
        CONSTRAINT "fk_class_formula_class"
          FOREIGN KEY ("class_slug", "class_version")
          REFERENCES "equipment_class_profile" ("slug", "version")
      )`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_kind"
        CHECK ("kind" IN ('physics', 'empirical', 'ml_feature'))`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_status"
        CHECK ("status" IN ('proposed', 'approved', 'retired'))`);
    // An approved formula with no named approver is indistinguishable from nobody
    // having reviewed it.
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_approved_by"
        CHECK ("status" <> 'approved' OR "approved_by" IS NOT NULL)`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_physics_inputs"
        CHECK ("kind" <> 'physics' OR cardinality("inputs") > 0)`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_class_formula_version" ON "equipment_class_formula"
        ("class_slug", "class_version", "formula_key", "version")`);
    // Two approved rows for one formula_key would mean the runtime's answer depends on
    // which row it read — the same reasoning as uq_equipment_parameter_approved.
    await q.query(`
      CREATE UNIQUE INDEX "uq_class_formula_approved" ON "equipment_class_formula"
        ("class_slug", "class_version", "formula_key") WHERE "status" = 'approved'`);
    await q.query(`
      CREATE INDEX "ix_class_formula_class" ON "equipment_class_formula" ("class_slug", "class_version")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_class_formula" TO "ta_app"`);

    // No immutability trigger for a published class version's requirements or formulas
    // here, deliberately: `npm run seed:catalog` re-runs against the same slug/version
    // on every deploy, and a trigger that refused a second identical write would break
    // that re-run rather than protect anything. Immutability for a published version is
    // the service layer's job, the same place it is already enforced for the catalog
    // tables this one references.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_sensor_requirement_role_declared" ON "equipment_class_sensor_requirement"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_sensor_requirement_role_declared"()`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_formula"`);
    await q.query(`DROP TABLE IF EXISTS "sensor_role_capability"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_sensor_requirement"`);
  }
}
