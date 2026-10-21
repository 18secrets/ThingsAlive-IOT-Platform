import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The first reader of the outbox, and who was told about an escalation (task QNOTIFY1).
 *
 * - `domain_event` gains `next_attempt_at`, so a failed delivery waits its backoff
 *   instead of being retried on every pass; a CHECK on `delivery_state`, which had none;
 *   and a trigger that makes a delivered or failed event final and the event itself
 *   unchangeable. An event is a record of something that happened. A bug that flipped a
 *   backlog back to `pending` would re-send every message in it, and a consumer that
 *   edited a payload would deliver something that never happened — the trigger is what
 *   refuses both, whichever code path tries.
 * - `notification_delivery` — one row per event, recipient and channel, unique. The
 *   consumer claims events with SKIP LOCKED so two passes do not normally meet; this
 *   is the backstop that holds when they do, because a service check loses to a
 *   concurrent write. Tenant-owned and under row-level security: who was told about an
 *   incident is the account's own record.
 * - `incident_event.kind` gains `notified` and `notification_skipped`, so the incident
 *   view can show who was told, or why nobody was.
 */
export class IncidentNotifier1760900000000 implements MigrationInterface {
  name = 'IncidentNotifier1760900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "domain_event" ADD COLUMN "next_attempt_at" timestamptz`);
    await q.query(`
      ALTER TABLE "domain_event" ADD CONSTRAINT "ck_domain_event_delivery_state"
        CHECK ("delivery_state" IN ('pending', 'delivered', 'failed'))`);
    await q.query(`
      CREATE FUNCTION "domain_event_delivery_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."delivery_state" <> 'pending' AND NEW."delivery_state" IS DISTINCT FROM OLD."delivery_state" THEN
          RAISE EXCEPTION 'domain_event %: % is final', OLD."id", OLD."delivery_state"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."event_type" IS DISTINCT FROM OLD."event_type" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
           OR NEW."subject" IS DISTINCT FROM OLD."subject" OR NEW."payload" IS DISTINCT FROM OLD."payload"
           OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" THEN
          RAISE EXCEPTION 'domain_event %: what happened cannot change, only its delivery', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_domain_event_delivery_guard" BEFORE UPDATE ON "domain_event"
        FOR EACH ROW EXECUTE FUNCTION "domain_event_delivery_guard"()`);

    await q.query(`
      CREATE TABLE "notification_delivery" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "event_id" uuid NOT NULL REFERENCES "domain_event" ("id"),
        "recipient_user_id" uuid NOT NULL,
        "channel" text NOT NULL,
        "sent_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_notification_delivery_channel" CHECK ("channel" IN ('email'))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_notification_delivery"
        ON "notification_delivery" ("tenant_id", "event_id", "recipient_user_id", "channel")`);
    await q.query(`ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "notification_delivery" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "notification_delivery"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    // Insert and read only. A delivery that happened is not edited or taken back.
    await q.query(`GRANT SELECT, INSERT ON "notification_delivery" TO "ta_app"`);

    await q.query(`ALTER TABLE "incident_event" DROP CONSTRAINT "ck_incident_event_kind"`);
    await q.query(`
      ALTER TABLE "incident_event" ADD CONSTRAINT "ck_incident_event_kind" CHECK ("kind" IN (
        'opened', 'alert_linked', 'severity_raised', 'acknowledged', 'assigned', 'work_raised',
        'escalated', 'resolved', 'notified', 'notification_skipped'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The two new kinds go with the code that writes them; the timeline keeps the rest.
    await q.query(`DELETE FROM "incident_event" WHERE "kind" IN ('notified', 'notification_skipped')`);
    await q.query(`ALTER TABLE "incident_event" DROP CONSTRAINT "ck_incident_event_kind"`);
    await q.query(`
      ALTER TABLE "incident_event" ADD CONSTRAINT "ck_incident_event_kind" CHECK ("kind" IN (
        'opened', 'alert_linked', 'severity_raised', 'acknowledged', 'assigned', 'work_raised',
        'escalated', 'resolved'))`);
    await q.query(`DROP TABLE IF EXISTS "notification_delivery"`);
    await q.query(`DROP TRIGGER IF EXISTS "trg_domain_event_delivery_guard" ON "domain_event"`);
    await q.query(`DROP FUNCTION IF EXISTS "domain_event_delivery_guard"()`);
    await q.query(`ALTER TABLE "domain_event" DROP CONSTRAINT IF EXISTS "ck_domain_event_delivery_state"`);
    await q.query(`ALTER TABLE "domain_event" DROP COLUMN IF EXISTS "next_attempt_at"`);
  }
}
