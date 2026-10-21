import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The recommendation frame (task QREC2, D21, D36).
 *
 * One row is one rendering of one evidence bundle into a GroundedAnswerV1, by the
 * deterministic templates or by the model behind REC_FRAME_MODEL_ENABLED. QGEN1 and any
 * acceptance flow will cite an `answer_id`, so a frame that could be edited after it was
 * cited would make that citation a claim about prose nobody can see any more. Append-only
 * twice over, as the bundle is: the role may only INSERT and SELECT, and a trigger
 * refuses UPDATE and DELETE for anyone.
 *
 * A refused model frame keeps its refusal and never its prose
 * (`ck_rec_frame_answer_iff_passed`): unvalidated text is not stored anywhere it could be
 * served from. A template frame that fails the critic is a bug and a 500, never a row
 * (`ck_rec_frame_template_passed`), so every stored template row is servable.
 *
 * The unique index is on an expression, which is why it is an index and not a table
 * constraint: one row per bundle per renderer version (and per model, for the model
 * path), however often it is asked for. Led by the tenant, as every unique index on a
 * tenant-owned table is (`rls-coverage.spec.ts`). The template renderer is deterministic, so a
 * second request finds the first row instead of writing a twin.
 *
 * The bundle reference carries the tenant as well as the id. The policy stops a session
 * writing another tenant's frame, but a foreign key is checked without RLS, so a plain
 * `bundle_id` FK would accept a frame in tenant A pointing at tenant B's evidence. The
 * composite key makes that a constraint violation rather than a service check.
 */
export class RecFrame1761200000000 implements MigrationInterface {
  name = 'RecFrame1761200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE UNIQUE INDEX "uq_rec_evidence_bundle_id_tenant" ON "rec_evidence_bundle" ("id", "tenant_id")`);

    await q.query(`
      CREATE TABLE "rec_frame" (
        "id" uuid PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "bundle_id" uuid NOT NULL,
        "renderer" text NOT NULL,
        "renderer_version" text NOT NULL,
        "model_id" text,
        "model_version" text,
        "validation" text NOT NULL,
        "refused_checks" text[] NOT NULL DEFAULT '{}',
        "answer" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_rec_frame_bundle" FOREIGN KEY ("bundle_id", "tenant_id")
          REFERENCES "rec_evidence_bundle" ("id", "tenant_id"),
        CONSTRAINT "ck_rec_frame_renderer" CHECK ("renderer" IN ('template', 'model')),
        CONSTRAINT "ck_rec_frame_validation" CHECK ("validation" IN ('passed', 'refused')),
        CONSTRAINT "ck_rec_frame_model_named" CHECK (
          ("renderer" = 'model') = ("model_id" IS NOT NULL AND "model_version" IS NOT NULL)
          AND ("renderer" = 'model' OR ("model_id" IS NULL AND "model_version" IS NULL))),
        CONSTRAINT "ck_rec_frame_answer_iff_passed" CHECK (("validation" = 'passed') = ("answer" IS NOT NULL)),
        CONSTRAINT "ck_rec_frame_refusal_named" CHECK (("validation" = 'refused') = (cardinality("refused_checks") > 0)),
        CONSTRAINT "ck_rec_frame_template_passed" CHECK ("renderer" = 'model' OR "validation" = 'passed')
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_rec_frame" ON "rec_frame"
        ("tenant_id", "bundle_id", "renderer", "renderer_version", COALESCE("model_id", ''), COALESCE("model_version", ''))`);

    await q.query(`
      CREATE FUNCTION "rec_frame_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'rec_frame is append-only: a frame that may have been cited is not edited or taken back'
          USING ERRCODE = 'check_violation';
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_rec_frame_append_only" BEFORE UPDATE OR DELETE ON "rec_frame"
        FOR EACH ROW EXECUTE FUNCTION "rec_frame_append_only"()`);

    await q.query(`ALTER TABLE "rec_frame" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "rec_frame" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "rec_frame"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT ON "rec_frame" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "rec_frame"`);
    await q.query(`DROP FUNCTION IF EXISTS "rec_frame_append_only"()`);
    await q.query(`DROP INDEX IF EXISTS "uq_rec_evidence_bundle_id_tenant"`);
  }
}
