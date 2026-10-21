import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The recommendation evidence bundle (task QREC1, D21).
 *
 * One row is what the five deterministic steps found for one machine at one instant:
 * what was detected, which library failure modes it points at, what this machine's own
 * history holds, what is already in hand, and what the client's own rates make of the
 * labour. QREC2 phrases it, QGEN1 cites its id as provenance, QEVAL1 replays against
 * it — so a bundle that could change after it was cited would turn each of those into
 * a claim about something nobody can see any more. It is append-only twice over: the
 * role may only INSERT and SELECT, and a trigger refuses UPDATE and DELETE for anyone,
 * because a grant is one `GRANT ALL` away from not saying so.
 *
 * The closed sets of status, reason and outcome are CHECKs rather than service
 * constants, and the two pairings are CHECKs too: a ready bundle has an outcome and
 * no reason, a refused one a reason and no outcome. A row that says "ready" with no
 * outcome is a bundle the UI cannot render, and the service is not the only writer
 * this table will ever have.
 *
 * Unique on what the evidence was (`inputs_hash`) under the engine that read it, led
 * by the tenant: two requests over unchanged data are the same evidence, and the
 * second one finds the first rather than writing a twin (§8).
 */
export class RecEvidenceBundle1761000000000 implements MigrationInterface {
  name = 'RecEvidenceBundle1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "rec_evidence_bundle" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "incident_id" uuid REFERENCES "incident" ("id"),
        "as_of" timestamptz NOT NULL,
        "engine_version" text NOT NULL,
        "class_slug" text,
        "class_template_version" integer,
        "inputs_hash" text NOT NULL,
        "status" text NOT NULL,
        "reason" text,
        "outcome" text,
        "detect" jsonb NOT NULL,
        "attribute" jsonb NOT NULL,
        "precedent" jsonb NOT NULL,
        "gap" jsonb NOT NULL,
        "cost" jsonb NOT NULL,
        "candidates" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_rec_evidence_bundle_status" CHECK ("status" IN ('ready', 'not_configured', 'blocked')),
        CONSTRAINT "ck_rec_evidence_bundle_reason" CHECK ("reason" IS NULL OR "reason" IN (
          'unclassified', 'class_not_in_account', 'no_library_content', 'insufficient_coverage')),
        CONSTRAINT "ck_rec_evidence_bundle_outcome" CHECK ("outcome" IS NULL OR "outcome" IN (
          'attributed', 'unattributed', 'inconclusive', 'nothing_detected')),
        CONSTRAINT "ck_rec_evidence_bundle_ready_reason" CHECK (("status" = 'ready') = ("reason" IS NULL)),
        CONSTRAINT "ck_rec_evidence_bundle_ready_outcome" CHECK (("status" = 'ready') = ("outcome" IS NOT NULL))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_rec_evidence_bundle_inputs" ON "rec_evidence_bundle"
        ("tenant_id", "source_system", "external_id", "inputs_hash", "engine_version")`);
    await q.query(`
      CREATE INDEX "ix_rec_evidence_bundle_machine" ON "rec_evidence_bundle"
        ("tenant_id", "source_system", "external_id", "created_at")`);

    await q.query(`
      CREATE FUNCTION "rec_evidence_bundle_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'rec_evidence_bundle is append-only: evidence that has been read is not edited or taken back'
          USING ERRCODE = 'check_violation';
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_rec_evidence_bundle_append_only" BEFORE UPDATE OR DELETE ON "rec_evidence_bundle"
        FOR EACH ROW EXECUTE FUNCTION "rec_evidence_bundle_append_only"()`);

    await q.query(`ALTER TABLE "rec_evidence_bundle" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "rec_evidence_bundle" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "rec_evidence_bundle"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT ON "rec_evidence_bundle" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "rec_evidence_bundle"`);
    await q.query(`DROP FUNCTION IF EXISTS "rec_evidence_bundle_append_only"()`);
  }
}
