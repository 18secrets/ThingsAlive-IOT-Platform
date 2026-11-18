import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every question Vani put to the platform on a customer's behalf, and what it was told
 * (plan Phase 6, the analysis tool).
 *
 * Kept because the answer was spoken to a customer about their machine. When somebody
 * asks "why did the phone tell me that", the turn says who was asking, what scope they
 * were answered under, which lookups the answer rested on, and the exact words — or why
 * they were refused. It is also the conversation's memory: the machine being discussed
 * carries from one turn to the next through these rows, not through anything Vani holds.
 *
 * Append-only. A turn is a record of what was said; nobody edits it afterwards.
 */
export class VaniConversation1763800000000 implements MigrationInterface {
  name = 'VaniConversation1763800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vani_conversation_turn" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "conversation_id" text NOT NULL,
        -- Vani's id for this question within the conversation. A retry carries the same
        -- one, so the turn is answered once and the retry is told the same words.
        "turn_id" text,
        "caller_phone" text NOT NULL,
        -- Null when the caller was not recognised; that turn was refused.
        "user_id" uuid,
        -- The machine the turn was about, when there was one.
        "source_system" text,
        "external_id" text,
        "alert_event_id" uuid,
        "question" text NOT NULL,
        "answer" text NOT NULL,
        "status" text NOT NULL,
        "reason" text,
        "tools_used" text[] NOT NULL DEFAULT '{}',
        "tokens" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_vani_turn_status" CHECK ("status" IN ('answered', 'refused')),
        -- A refusal always says why; an answer never carries a refusal reason.
        CONSTRAINT "ck_vani_turn_reason" CHECK (("status" = 'refused') = ("reason" IS NOT NULL)),
        -- Nothing is answered for somebody we could not name.
        CONSTRAINT "ck_vani_turn_answered_user" CHECK ("status" <> 'answered' OR "user_id" IS NOT NULL),
        CONSTRAINT "ck_vani_turn_conversation" CHECK (length(btrim("conversation_id")) > 0),
        CONSTRAINT "ck_vani_turn_turn_id" CHECK ("turn_id" IS NULL OR length(btrim("turn_id")) > 0),
        CONSTRAINT "ck_vani_turn_machine" CHECK (("source_system" IS NULL) = ("external_id" IS NULL))
      )`);
    await q.query(`
      CREATE INDEX "ix_vani_turn_conversation"
        ON "vani_conversation_turn" ("tenant_id", "conversation_id", "created_at")`);
    // One answer per question. The service waits on a lock so a retry is not answered
    // a second time; this is what still holds if that is ever bypassed. Partial: a
    // turn without an id cannot be recognised as a retry, so it is not deduplicated.
    await q.query(`
      CREATE UNIQUE INDEX "uq_vani_turn_turn_id"
        ON "vani_conversation_turn" ("tenant_id", "conversation_id", "turn_id") WHERE "turn_id" IS NOT NULL`);
    await q.query(`ALTER TABLE "vani_conversation_turn" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "vani_conversation_turn" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "vani_conversation_turn"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT ON "vani_conversation_turn" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vani_conversation_turn"`);
  }
}
