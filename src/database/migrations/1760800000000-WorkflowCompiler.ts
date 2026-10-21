import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Workflows, and the compiler between them and `alert_rule` (task QWF1, D16, D43).
 *
 * D16 settled the expensive part: an alert workflow compiles to `alert_rule`, and the
 * shift runner keeps evaluating rules exactly as it does now. A workflow is the
 * authored layer above them. So this adds three tenant-owned tables — the workflow,
 * its versions, and the canvas layout kept apart from both — three provenance columns
 * on `alert_rule`, and one new trigger kind. It rewrites no existing rule: hand-authored
 * and template-copied rules keep working untouched, with the new columns null.
 *
 * Every rule that protects what runs is here rather than only in the service, because
 * a service check loses to a concurrent write or to a second door:
 *
 *  - a published version cannot change, and a version's status only moves forward;
 *  - one published version per workflow, by a partial unique index;
 *  - a compiled rule's content cannot be edited — edit the graph and republish. A rule
 *    and a graph that can both be edited drift apart, and then neither describes what
 *    runs. Switching one off is still allowed (D43 Q7): that is operational, not
 *    semantic, and a noisy alert at 3 a.m. must not need a republish;
 *  - the three provenance columns are all set or all null;
 *  - a composite is compiler-only, because a hand-written one has no graph to read it
 *    back from;
 *  - `kind = 'agent'` is refused: a stored agent draft with nothing able to run it
 *    looks like a configured workflow.
 */
export class WorkflowCompiler1760800000000 implements MigrationInterface {
  name = 'WorkflowCompiler1760800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "workflow_definition" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "kind" text NOT NULL DEFAULT 'alert',
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        -- Widened by a later migration, when an agent runtime exists to run one (D16).
        CONSTRAINT "ck_workflow_definition_kind" CHECK ("kind" = 'alert')
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_workflow_definition_slug" ON "workflow_definition" ("tenant_id", "slug")`);

    await q.query(`
      CREATE TABLE "workflow_version" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "workflow_id" uuid NOT NULL REFERENCES "workflow_definition" ("id"),
        "version" integer NOT NULL,
        "spec" jsonb NOT NULL,
        "graph_hash" text NOT NULL,
        "status" text NOT NULL DEFAULT 'draft',
        "source" text NOT NULL DEFAULT 'manual',
        "proposal_id" uuid,
        "published_by" text,
        "published_at" timestamptz,
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_workflow_version_status" CHECK ("status" IN ('draft', 'published', 'superseded', 'retired')),
        CONSTRAINT "ck_workflow_version_source" CHECK ("source" IN ('manual', 'generated')),
        -- A proposal id on a hand-drawn graph would claim a provenance it does not have.
        CONSTRAINT "ck_workflow_version_proposal" CHECK ("source" = 'generated' OR "proposal_id" IS NULL),
        CONSTRAINT "ck_workflow_version_positive" CHECK ("version" >= 1),
        -- Anything that has been published says who published it and when.
        CONSTRAINT "ck_workflow_version_published" CHECK (
          "status" = 'draft' OR ("published_at" IS NOT NULL AND "published_by" IS NOT NULL))
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_workflow_version" ON "workflow_version" ("tenant_id", "workflow_id", "version")`);
    // Two published versions would mean two sets of live rules for one workflow, and the
    // graph a person sees would describe only one of them.
    await q.query(`
      CREATE UNIQUE INDEX "uq_workflow_version_published" ON "workflow_version" ("tenant_id", "workflow_id")
        WHERE "status" = 'published'`);

    await q.query(`
      CREATE FUNCTION "workflow_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."status" <> 'draft' AND (
             NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."graph_hash" IS DISTINCT FROM OLD."graph_hash"
          OR NEW."workflow_id" IS DISTINCT FROM OLD."workflow_id" OR NEW."version" IS DISTINCT FROM OLD."version"
          OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."source" IS DISTINCT FROM OLD."source"
          OR NEW."proposal_id" IS DISTINCT FROM OLD."proposal_id"
          OR NEW."published_by" IS DISTINCT FROM OLD."published_by"
          OR NEW."published_at" IS DISTINCT FROM OLD."published_at") THEN
          RAISE EXCEPTION 'workflow version % is %; its content cannot change. Publish a new version', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT (
             (OLD."status" = 'draft' AND NEW."status" IN ('draft', 'published'))
          OR (OLD."status" = 'published' AND NEW."status" IN ('published', 'superseded', 'retired'))
          OR (OLD."status" IN ('superseded', 'retired') AND NEW."status" = OLD."status")) THEN
          RAISE EXCEPTION 'workflow version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_workflow_version_guard" BEFORE UPDATE ON "workflow_version"
        FOR EACH ROW EXECUTE FUNCTION "workflow_version_guard"()`);

    await q.query(`
      CREATE TABLE "workflow_layout" (
        "workflow_version_id" uuid NOT NULL REFERENCES "workflow_version" ("id"),
        "tenant_id" text NOT NULL,
        "positions" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        -- Keyed with the tenant, like every unique key on a tenant-owned table here.
        PRIMARY KEY ("tenant_id", "workflow_version_id")
      )`);

    for (const table of ['workflow_definition', 'workflow_version', 'workflow_layout']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
      // No DELETE: a version is what a compiled rule, and every alert it raised, points
      // back to. Retiring is the way out, as it is for a rule.
      await q.query(`GRANT SELECT, INSERT, UPDATE ON "${table}" TO "ta_app"`);
    }

    // --- alert_rule: provenance and the composite ---------------------------------
    await q.query(`
      ALTER TABLE "alert_rule"
        ADD COLUMN "compiled_from_workflow_id" uuid REFERENCES "workflow_definition" ("id"),
        ADD COLUMN "compiled_from_version_id" uuid REFERENCES "workflow_version" ("id"),
        ADD COLUMN "graph_hash" text`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_compiled_provenance" CHECK (
        ("compiled_from_workflow_id" IS NULL AND "compiled_from_version_id" IS NULL AND "graph_hash" IS NULL)
        OR ("compiled_from_workflow_id" IS NOT NULL AND "compiled_from_version_id" IS NOT NULL AND "graph_hash" IS NOT NULL))`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN (
          'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss',
          'chain-origin', 'composite'
        ))`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_composite_compiled"
        CHECK ("trigger" <> 'composite' OR "compiled_from_workflow_id" IS NOT NULL)`);
    await q.query(`CREATE INDEX "ix_alert_rule_compiled" ON "alert_rule" ("tenant_id", "compiled_from_workflow_id")`);

    // The compiler never rewrites a rule either: republishing switches the old version's
    // rules off and inserts new ones, so an alert event always resolves to the rule, and
    // the content, that raised it. Enabling and disabling stay open (D43 Q7).
    await q.query(`
      CREATE FUNCTION "alert_rule_compiled_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."compiled_from_workflow_id" IS NULL THEN
          IF NEW."compiled_from_workflow_id" IS NOT NULL THEN
            RAISE EXCEPTION 'alert rule % was written by hand; it cannot be adopted into a workflow by an update', OLD."id"
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW."trigger" IS DISTINCT FROM OLD."trigger" OR NEW."params" IS DISTINCT FROM OLD."params"
          OR NEW."applies_to" IS DISTINCT FROM OLD."applies_to" OR NEW."plant_id" IS DISTINCT FROM OLD."plant_id"
          OR NEW."source_system" IS DISTINCT FROM OLD."source_system" OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
          OR NEW."equipment_class_slug" IS DISTINCT FROM OLD."equipment_class_slug"
          OR NEW."severity" IS DISTINCT FROM OLD."severity"
          OR NEW."compiled_from_workflow_id" IS DISTINCT FROM OLD."compiled_from_workflow_id"
          OR NEW."compiled_from_version_id" IS DISTINCT FROM OLD."compiled_from_version_id"
          OR NEW."graph_hash" IS DISTINCT FROM OLD."graph_hash" THEN
          RAISE EXCEPTION 'alert rule % is compiled from a workflow; edit the workflow and republish it', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_alert_rule_compiled_guard" BEFORE UPDATE ON "alert_rule"
        FOR EACH ROW EXECUTE FUNCTION "alert_rule_compiled_guard"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_alert_rule_compiled_guard" ON "alert_rule"`);
    await q.query(`DROP FUNCTION IF EXISTS "alert_rule_compiled_guard"()`);
    await q.query(`DROP INDEX IF EXISTS "ix_alert_rule_compiled"`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT IF EXISTS "ck_alert_rule_composite_compiled"`);
    // A composite has no meaning without the compiler, and the old trigger list cannot
    // hold while one exists — the same way ChainOriginTrigger's down path clears its kind.
    await q.query(`DELETE FROM "alert_rule" WHERE "trigger" = 'composite'`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN (
          'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss',
          'chain-origin'
        ))`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT IF EXISTS "ck_alert_rule_compiled_provenance"`);
    await q.query(`
      ALTER TABLE "alert_rule"
        DROP COLUMN IF EXISTS "graph_hash",
        DROP COLUMN IF EXISTS "compiled_from_version_id",
        DROP COLUMN IF EXISTS "compiled_from_workflow_id"`);
    await q.query(`DROP TABLE IF EXISTS "workflow_layout"`);
    await q.query(`DROP TABLE IF EXISTS "workflow_version"`);
    await q.query(`DROP FUNCTION IF EXISTS "workflow_version_guard"()`);
    await q.query(`DROP TABLE IF EXISTS "workflow_definition"`);
  }
}
