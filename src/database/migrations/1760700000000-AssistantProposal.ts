import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the onboarding assistant proposes, and what became of it (task QCHAT2, G09).
 *
 * The assistant does not act. It writes a proposal here — add this site, this
 * machine, fit this logger — and a person confirms or rejects it; confirming runs the
 * ordinary service as that person. The row is the approval record: what was proposed,
 * by whose question, who decided, and what the service answered.
 *
 * Approval is only exact if what is approved cannot change after it is shown. So the
 * trigger, not the service, refuses any edit to what was proposed, and refuses any
 * change at all once a proposal is decided: a confirm that raced an edit would
 * otherwise apply something nobody saw. The CHECK ties a decision to its decider — a
 * proposal is never applied by nobody.
 */
export class AssistantProposal1760700000000 implements MigrationInterface {
  name = 'AssistantProposal1760700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "assistant_proposal" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "kind" text NOT NULL,
        "payload" jsonb NOT NULL,
        "summary" text NOT NULL,
        "status" text NOT NULL DEFAULT 'proposed',
        "proposed_by" text NOT NULL,
        "proposed_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "decided_by" text,
        "decided_at" timestamptz,
        "result" jsonb,
        "error" text,
        CONSTRAINT "ck_assistant_proposal_kind" CHECK ("kind" IN ('create_site', 'create_equipment', 'fit_logger')),
        CONSTRAINT "ck_assistant_proposal_status" CHECK ("status" IN ('proposed', 'applied', 'failed', 'rejected', 'expired')),
        CONSTRAINT "ck_assistant_proposal_decided" CHECK (
          ("status" = 'proposed') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by" IS NULL)),
        CONSTRAINT "ck_assistant_proposal_expiry" CHECK ("expires_at" > "proposed_at")
      )`);
    await q.query(`CREATE INDEX "ix_assistant_proposal_open" ON "assistant_proposal" ("tenant_id", "status", "proposed_at")`);

    await q.query(`
      CREATE FUNCTION "assistant_proposal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."status" <> 'proposed' THEN
          RAISE EXCEPTION 'assistant proposal % is already %; a decision is final', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."kind" IS DISTINCT FROM OLD."kind"
           OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."summary" IS DISTINCT FROM OLD."summary"
           OR NEW."proposed_by" IS DISTINCT FROM OLD."proposed_by" OR NEW."proposed_at" IS DISTINCT FROM OLD."proposed_at"
           OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
          RAISE EXCEPTION 'assistant proposal %: what was proposed cannot change, only its decision', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_assistant_proposal_guard" BEFORE UPDATE ON "assistant_proposal"
        FOR EACH ROW EXECUTE FUNCTION "assistant_proposal_guard"()`);

    await q.query(`ALTER TABLE "assistant_proposal" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "assistant_proposal" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "assistant_proposal"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    // No DELETE: a rejected or failed proposal is still the record of what was asked.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "assistant_proposal" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "assistant_proposal"`);
    await q.query(`DROP FUNCTION IF EXISTS "assistant_proposal_guard"()`);
  }
}
