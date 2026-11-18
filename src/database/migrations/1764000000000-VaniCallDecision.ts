import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What 2.0 did about what a customer decided on a Vani call (D57, Lane D).
 *
 * Vani reports the decision on its outcome callback as `customer_decision`; the
 * platform acts on it — acknowledges the alert, raises the inspection. One row per call,
 * written in the same transaction as the acknowledgement and the work order, so the
 * three commit together or not at all, and the unique index is what makes a repeated
 * or concurrent callback act once. A decision that was not acted on is a row too, with
 * the reason: "Vani said they approved it, so why is there no job?" must be answerable.
 *
 * Append-only. It records what was done on somebody's word; nobody edits that after.
 */
export class VaniCallDecision1764000000000 implements MigrationInterface {
  name = 'VaniCallDecision1764000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vani_call_action" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "alert_event_id" uuid NOT NULL,
        "attempt" int NOT NULL,
        -- As Vani sent it, even when it is not one we act on, so an unknown value is
        -- visible rather than dropped.
        "decision" text NOT NULL,
        "status" text NOT NULL,
        "reason" text,
        -- The customer it was done as: the phone Vani dialled, matched to a 2.0 user.
        "acted_as_user_id" uuid,
        "acknowledged" boolean NOT NULL DEFAULT false,
        "work_order_id" uuid REFERENCES "work_order" ("id"),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_vani_call_action_call"
          FOREIGN KEY ("tenant_id", "alert_event_id") REFERENCES "vani_call" ("tenant_id", "alert_event_id"),
        CONSTRAINT "ck_vani_call_action_status" CHECK ("status" IN ('acted', 'recorded', 'not_acted')),
        -- Not acting always says why; acting or recording never carries a refusal.
        CONSTRAINT "ck_vani_call_action_reason" CHECK (("status" = 'not_acted') = ("reason" IS NOT NULL)),
        -- Only the four decisions D57 names are ever acted on or recorded as such.
        CONSTRAINT "ck_vani_call_action_decision" CHECK ("status" = 'not_acted' OR "decision" IN
          ('inspection_approved', 'call_back_requested', 'declined', 'acknowledged')),
        -- Nothing is done on the word of somebody we could not name.
        CONSTRAINT "ck_vani_call_action_actor" CHECK ("status" <> 'acted' OR "acted_as_user_id" IS NOT NULL),
        -- A job is raised only for an approved inspection.
        CONSTRAINT "ck_vani_call_action_work_order" CHECK (
          "work_order_id" IS NULL OR ("status" = 'acted' AND "decision" = 'inspection_approved'))
      )`);
    // One per call: a call has one customer and one decision, whichever attempt and
    // however many times the callback arrives.
    await q.query(`CREATE UNIQUE INDEX "uq_vani_call_action_call" ON "vani_call_action" ("tenant_id", "alert_event_id")`);
    await q.query(`ALTER TABLE "vani_call_action" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "vani_call_action" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "vani_call_action"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT ON "vani_call_action" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vani_call_action"`);
  }
}
