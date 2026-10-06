import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Failure modes and recommendations become rows; KPI and forecast declarations get
 * the columns they were missing (task QREC0a).
 *
 * `equipment_class_profile.failure_modes` was jsonb, which was fine while nothing
 * referenced it. A recommendation has to point at a failure mode, and jsonb has no
 * identity to point at — so the foreign key below is the reason for the whole
 * conversion, not a tidy-up.
 *
 * The jsonb columns stay — on the platform class and on every tenant copy —
 * deprecated, still written, no longer read. Dropping them in the same migration
 * that populates their replacement leaves no way back if the conversion is wrong on
 * a row nobody has looked at. QREC0c drops them.
 *
 * Every conversion asserts its row count before it is allowed to commit (the
 * lesson of QPART1's check): an entry the SQL below cannot turn into a row — not an
 * object, or no code and no name to derive one from — is skipped by the INSERT and
 * then caught by the count, naming the class version, instead of disappearing.
 */
export class LibraryContent1758100000000 implements MigrationInterface {
  name = 'LibraryContent1758100000000';

  public async up(q: QueryRunner): Promise<void> {
    // ----------------------------------------------------------- platform: failure modes
    await q.query(`
      CREATE TABLE "equipment_class_failure_mode" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "symptom" text NOT NULL DEFAULT '',
        "severity" text,
        "signals" text[] NOT NULL DEFAULT '{}',
        "source" text NOT NULL DEFAULT 'manual',
        "import_batch_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_class_failure_mode_class"
          FOREIGN KEY ("class_slug", "class_version")
          REFERENCES "equipment_class_profile" ("slug", "version")
      )`);
    // Nullable with no default (D32): a converted entry never had a severity, and
    // "nobody said" must not become "somebody said none".
    await q.query(`
      ALTER TABLE "equipment_class_failure_mode" ADD CONSTRAINT "ck_class_failure_mode_severity"
        CHECK ("severity" IS NULL OR "severity" IN ('none', 'low', 'medium', 'high', 'critical'))`);
    // No snake_case CHECK on "code", although QREC0a asks for snake_case: the shipped
    // seed catalog (src/database/seeds/catalog/equipment-classes.json) uses codes like
    // FUEL-PILFERAGE, and a CHECK would fail this migration on any database seeded
    // from it. Left for a decision rather than enforced by surprise — a CHECK can be
    // added by a later migration once the existing codes have an answer.
    await q.query(`
      ALTER TABLE "equipment_class_failure_mode" ADD CONSTRAINT "ck_class_failure_mode_code"
        CHECK (btrim("code") <> '')`);
    await q.query(`
      ALTER TABLE "equipment_class_failure_mode" ADD CONSTRAINT "ck_class_failure_mode_source"
        CHECK ("source" IN ('manual', 'excel-import'))`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_class_failure_mode" ON "equipment_class_failure_mode"
        ("class_slug", "class_version", "code")`);

    // ----------------------------------------------------------- platform: recommendations
    await q.query(`
      CREATE TABLE "equipment_class_recommendation" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "failure_mode_code" text NOT NULL,
        "action" text NOT NULL,
        "urgency" text NOT NULL,
        "estimated_hours" numeric,
        "required_parts" jsonb,
        "source" text NOT NULL DEFAULT 'manual',
        "import_batch_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        -- A recommendation for a failure mode the class version does not have is a
        -- defect, not a draft. Refused here as well as at validate and publish,
        -- because a service check loses to a concurrent write.
        CONSTRAINT "fk_class_recommendation_failure_mode"
          FOREIGN KEY ("class_slug", "class_version", "failure_mode_code")
          REFERENCES "equipment_class_failure_mode" ("class_slug", "class_version", "code")
      )`);
    // Urgency is how soon someone acts; severity is how bad the failure is. Two
    // axes, so two vocabularies — sharing one would let "critical" mean "now".
    await q.query(`
      ALTER TABLE "equipment_class_recommendation" ADD CONSTRAINT "ck_class_recommendation_urgency"
        CHECK ("urgency" IN ('immediate', 'next_shift', 'next_service', 'monitor'))`);
    await q.query(`
      ALTER TABLE "equipment_class_recommendation" ADD CONSTRAINT "ck_class_recommendation_hours"
        CHECK ("estimated_hours" IS NULL OR "estimated_hours" >= 0)`);
    await q.query(`
      ALTER TABLE "equipment_class_recommendation" ADD CONSTRAINT "ck_class_recommendation_source"
        CHECK ("source" IN ('manual', 'excel-import'))`);
    await q.query(`
      CREATE INDEX "ix_class_recommendation_class" ON "equipment_class_recommendation"
        ("class_slug", "class_version")`);

    // DELETE is granted here, unlike the sibling library tables, because authoring
    // edits a draft's failure modes in place (CatalogAuthoringService.editClass) and
    // has to be able to remove one. What it must never do is reach a published
    // version — so that is refused by the database, not left to the service.
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_class_failure_mode" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_class_recommendation" TO "ta_app"`);

    // UPDATE and DELETE only, not INSERT: the seeder and this migration both insert
    // rows under versions that are already published, and an insert cannot change
    // anything a tenant copy was made from — only an edit or a removal can.
    await q.query(`
      CREATE FUNCTION "ck_class_content_draft_only"() RETURNS trigger AS $$
      DECLARE
        version_status text;
      BEGIN
        SELECT ecp."status" INTO version_status
          FROM "equipment_class_profile" ecp
          WHERE ecp."slug" = OLD."class_slug" AND ecp."version" = OLD."class_version";
        IF version_status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION
            '% on %/% refused: that class version is "%", and only a draft may change (ck_class_content_draft_only)',
            TG_OP, OLD."class_slug", OLD."class_version", version_status;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql`);
    for (const table of ['equipment_class_failure_mode', 'equipment_class_recommendation']) {
      await q.query(`
        CREATE TRIGGER "trg_${table}_draft_only"
          BEFORE UPDATE OR DELETE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "ck_class_content_draft_only"()`);
    }

    // ------------------------------------------------------------- tenant copies
    // Same shape as client_formula (1758080000000-ClientFormula.ts): tenant-owned,
    // row-level security, no platform write path.
    await q.query(`
      CREATE TABLE "client_equipment_class_failure_mode" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "symptom" text NOT NULL DEFAULT '',
        "severity" text,
        "signals" text[] NOT NULL DEFAULT '{}',
        "template_version" int,
        "copied_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_client_failure_mode_severity"
          CHECK ("severity" IS NULL OR "severity" IN ('none', 'low', 'medium', 'high', 'critical'))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_client_failure_mode" ON "client_equipment_class_failure_mode"
        ("tenant_id", "client_equipment_class_slug", "code")`);

    await q.query(`
      CREATE TABLE "client_equipment_class_recommendation" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "failure_mode_code" text NOT NULL,
        "action" text NOT NULL,
        "urgency" text NOT NULL,
        "estimated_hours" numeric,
        "required_parts" jsonb,
        "template_version" int,
        "copied_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_client_recommendation_urgency"
          CHECK ("urgency" IN ('immediate', 'next_shift', 'next_service', 'monitor')),
        CONSTRAINT "ck_client_recommendation_hours"
          CHECK ("estimated_hours" IS NULL OR "estimated_hours" >= 0),
        -- The copy keeps the same guarantee the platform row had: a tenant editing
        -- their own content still cannot leave a recommendation pointing at nothing.
        CONSTRAINT "fk_client_recommendation_failure_mode"
          FOREIGN KEY ("tenant_id", "client_equipment_class_slug", "failure_mode_code")
          REFERENCES "client_equipment_class_failure_mode" ("tenant_id", "client_equipment_class_slug", "code")
      )`);
    await q.query(`
      CREATE INDEX "ix_client_recommendation_class" ON "client_equipment_class_recommendation"
        ("tenant_id", "client_equipment_class_slug")`);

    for (const table of ['client_equipment_class_failure_mode', 'client_equipment_class_recommendation']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
      await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "ta_app"`);
    }

    // ------------------------------------------------------------- jsonb -> rows
    await this.refuseNonArrays(q, 'equipment_class_profile', `"slug" || ' v' || "version"`);
    await q.query(`
      INSERT INTO "equipment_class_failure_mode"
        ("class_slug", "class_version", "code", "name", "symptom", "severity", "signals", "source", "import_batch_id")
      SELECT p."slug", p."version", m.code, coalesce(m.entry ->> 'name', m.code),
             coalesce(m.entry ->> 'symptom', ''), NULL, m.signals, p."source", p."import_batch_id"
        FROM "equipment_class_profile" p
        CROSS JOIN LATERAL (${ENTRIES_SQL('p')}) m
       WHERE m.code IS NOT NULL`);
    await this.assertConverted(q, `
      SELECT p."slug" || ' v' || p."version" AS label,
             jsonb_array_length(p."failure_modes") AS expected,
             (SELECT count(*) FROM "equipment_class_failure_mode" fm
               WHERE fm."class_slug" = p."slug" AND fm."class_version" = p."version") AS converted
        FROM "equipment_class_profile" p`);

    await this.refuseNonArrays(q, 'client_equipment_class', `"tenant_id" || '/' || "slug"`);
    await q.query(`
      INSERT INTO "client_equipment_class_failure_mode"
        ("tenant_id", "client_equipment_class_slug", "code", "name", "symptom", "severity", "signals",
         "template_version", "copied_at")
      SELECT c."tenant_id", c."slug", m.code, coalesce(m.entry ->> 'name', m.code),
             coalesce(m.entry ->> 'symptom', ''), NULL, m.signals, c."template_version", c."copied_at"
        FROM "client_equipment_class" c
        CROSS JOIN LATERAL (${ENTRIES_SQL('c')}) m
       WHERE m.code IS NOT NULL`);
    await this.assertConverted(q, `
      SELECT c."tenant_id" || '/' || c."slug" AS label,
             jsonb_array_length(c."failure_modes") AS expected,
             (SELECT count(*) FROM "client_equipment_class_failure_mode" fm
               WHERE fm."tenant_id" = c."tenant_id" AND fm."client_equipment_class_slug" = c."slug") AS converted
        FROM "client_equipment_class" c`);

    await q.query(`
      COMMENT ON COLUMN "equipment_class_profile"."failure_modes" IS
        'Deprecated by QREC0a: still written, no longer read. equipment_class_failure_mode is the source. Dropped by QREC0c.'`);
    await q.query(`
      COMMENT ON COLUMN "client_equipment_class"."failure_modes" IS
        'Deprecated by QREC0a: still written, no longer read. client_equipment_class_failure_mode is the source. Dropped by QREC0c.'`);

    // ------------------------------------------------------------- KPI presentation (D30)
    // QCE1 (1758010000000-FormulaCompilerMetadata.ts) already shipped every D30 column;
    // the one gap is a chart that shows only the latest value. 'line' on a scalar is
    // refused at publish by the compiler, not here: the kind is inferred, and a CHECK
    // cannot see an inference.
    await q.query(`ALTER TABLE "equipment_class_formula" DROP CONSTRAINT "ck_class_formula_chart_type"`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_chart_type"
        CHECK ("chart_type" IN ('none', 'line', 'bar', 'area', 'gauge', 'number'))`);

    // ------------------------------------------------------------- forecast declarations (D40)
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement"
        ADD COLUMN "forecast_enabled" boolean NOT NULL DEFAULT false`);
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement"
        ADD COLUMN "forecast_horizon_hours" integer NULL`);
    await q.query(`
      COMMENT ON COLUMN "equipment_class_sensor_requirement"."forecast_enabled" IS
        'D40: false unless an author declares this signal worth forecasting. This is the control that keeps QML1 affordable - 500 machines x every signal is the arithmetic that broke the budget in D40; 500 machines x three declared signals is not. Do not default it to true.'`);
    // A horizon with forecasting off is a setting that silently does nothing.
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement" ADD CONSTRAINT "ck_sensor_requirement_forecast_horizon"
        CHECK ("forecast_horizon_hours" IS NULL OR ("forecast_enabled" AND "forecast_horizon_hours" > 0))`);
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement" ADD CONSTRAINT "ck_sensor_requirement_stale_after"
        CHECK ("stale_after_seconds" IS NULL OR "stale_after_seconds" > 0)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // 'number' has no meaning under the old constraint, and quietly rewriting it to
    // something else would change what an author declared. Refused instead.
    const [{ count }] = await q.query(
      `SELECT count(*)::int AS count FROM "equipment_class_formula" WHERE "chart_type" = 'number'`,
    );
    if (count > 0) {
      throw new Error(
        `LibraryContent1758100000000 down refused: ${count} formula(s) use chart_type 'number', `
          + 'which the previous constraint does not allow. Change them first.',
      );
    }

    await q.query(`ALTER TABLE "equipment_class_sensor_requirement" DROP CONSTRAINT IF EXISTS "ck_sensor_requirement_stale_after"`);
    await q.query(`ALTER TABLE "equipment_class_sensor_requirement" DROP CONSTRAINT IF EXISTS "ck_sensor_requirement_forecast_horizon"`);
    await q.query(`ALTER TABLE "equipment_class_sensor_requirement" DROP COLUMN IF EXISTS "forecast_horizon_hours"`);
    await q.query(`ALTER TABLE "equipment_class_sensor_requirement" DROP COLUMN IF EXISTS "forecast_enabled"`);

    await q.query(`ALTER TABLE "equipment_class_formula" DROP CONSTRAINT "ck_class_formula_chart_type"`);
    await q.query(`
      ALTER TABLE "equipment_class_formula" ADD CONSTRAINT "ck_class_formula_chart_type"
        CHECK ("chart_type" IN ('none', 'line', 'bar', 'area', 'gauge'))`);

    await q.query(`COMMENT ON COLUMN "equipment_class_profile"."failure_modes" IS NULL`);
    await q.query(`COMMENT ON COLUMN "client_equipment_class"."failure_modes" IS NULL`);

    // The jsonb was written alongside every row this migration's tables held, so
    // dropping them loses severity and recommendations only — never a failure mode.
    for (const table of ['client_equipment_class_recommendation', 'client_equipment_class_failure_mode']) {
      await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await q.query(`DROP TABLE IF EXISTS "equipment_class_recommendation"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_failure_mode"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_class_content_draft_only"()`);
  }

  private async refuseNonArrays(q: QueryRunner, table: string, labelSql: string): Promise<void> {
    const rows: { label: string }[] = await q.query(
      `SELECT ${labelSql} AS label FROM "${table}" WHERE jsonb_typeof("failure_modes") <> 'array'`,
    );
    if (rows.length) {
      throw new Error(
        `LibraryContent1758100000000: ${table}.failure_modes is not an array for `
          + `${rows.map((r) => r.label).join(', ')}; nothing was converted.`,
      );
    }
  }

  private async assertConverted(q: QueryRunner, sql: string): Promise<void> {
    const rows: { label: string; expected: number; converted: string }[] = await q.query(sql);
    const mismatched = rows.filter((r) => Number(r.converted) !== Number(r.expected));
    if (mismatched.length) {
      throw new Error(
        'LibraryContent1758100000000: failure mode conversion count mismatch — '
          + mismatched.map((r) => `${r.label}: ${r.expected} in jsonb, ${r.converted} converted`).join('; ')
          + '. Nothing was converted; fix the entries named and run again.',
      );
    }
  }
}

/**
 * One row per jsonb entry: the entry itself, its code (its own where it has one,
 * otherwise slugified from its name), and its signals as text[]. A code that comes
 * out NULL — no code, no usable name — is left for the count assertion to name.
 */
const ENTRIES_SQL = (alias: string): string => `
  SELECT e.entry,
         coalesce(
           nullif(btrim(e.entry ->> 'code'), ''),
           nullif(btrim(regexp_replace(lower(coalesce(e.entry ->> 'name', '')), '[^a-z0-9]+', '_', 'g'), '_'), '')
         ) AS code,
         CASE WHEN jsonb_typeof(e.entry -> 'signals') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(e.entry -> 'signals'))
              ELSE '{}'::text[] END AS signals
    FROM jsonb_array_elements(${alias}."failure_modes") AS e(entry)
   WHERE jsonb_typeof(e.entry) = 'object'`;
