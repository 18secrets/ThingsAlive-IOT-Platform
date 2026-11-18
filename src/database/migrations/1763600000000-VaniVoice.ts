import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What 2.0 needs to have Vani phone a customer about an alert, and to remember what
 * happened when it did (Vani integration guide, 3 Nov 2026, phase 1).
 *
 * Vani is a separate service with its own customer registry. It does not know our
 * tenant ids or our equipment ids and will not resolve them, so both identities are
 * mapped here, explicitly, rather than derived from names that happen to match.
 *
 * - `vani_account_link` — which Vani account a tenant is. One per tenant. One tenant
 *   per Vani account is NOT yet enforced: that needs a unique index without
 *   tenant_id, which `rls-coverage.spec.ts` refuses until it is listed there, and that
 *   listing is waiting on a decision. Until then two tenants linked to one Vani account
 *   would have one tenant's alerts read out to the other's customer, so links are made
 *   by platform staff only.
 * - `vani_machine_link` — the `machine_id` and spoken name Vani has registered for one
 *   of our machines. The name is said aloud on the call, so it is whatever a person
 *   would say, never our external id.
 * - `vani_call` — one per alert, keyed on the alert. The alert's id is the `event_id`
 *   Vani treats as its idempotency key, so a unique alert here is the same promise Vani
 *   makes on its side: one alert, one call flow, however many times we retry the POST.
 *   It is also the send queue: written `pending`, then settled by Vani's answer.
 * - `vani_call_outcome` — what Vani reports after each attempt. Vani may send the same
 *   callback twice, so (event, attempt) is unique and the second one is a no-op.
 *
 * All four are tenant-owned and under row-level security. Who we phoned about which
 * machine, and what they were told, is the account's own record.
 */
export class VaniVoice1763600000000 implements MigrationInterface {
  name = 'VaniVoice1763600000000';

  public async up(q: QueryRunner): Promise<void> {
    // ------------------------------------------------------------ account link
    await q.query(`
      CREATE TABLE "vani_account_link" (
        "tenant_id" text PRIMARY KEY REFERENCES "tenant" ("tenant_id") ON DELETE CASCADE,
        "vani_account_id" text NOT NULL,
        "customer_phone" text,
        "callback_url" text,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_vani_account_id" CHECK (length(btrim("vani_account_id")) > 0),
        -- Vani refuses a number that is not E.164 and registered; storing anything
        -- looser only moves that refusal to the moment an alert is being phoned in.
        CONSTRAINT "ck_vani_customer_phone" CHECK ("customer_phone" IS NULL OR "customer_phone" ~ '^\\+[1-9][0-9]{6,14}$'),
        -- Vani posts call outcomes here. Plain http would carry them, and whatever
        -- secret authenticates them, in the clear.
        CONSTRAINT "ck_vani_callback_url" CHECK ("callback_url" IS NULL OR "callback_url" ~ '^https://')
      )`);
    await q.query(`CREATE INDEX "ix_vani_account_link_account" ON "vani_account_link" ("vani_account_id")`);

    // ------------------------------------------------------------ machine link
    await q.query(`
      CREATE TABLE "vani_machine_link" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "machine_id" text NOT NULL,
        "spoken_name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_vani_machine_link_equipment"
          FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id")
          ON DELETE CASCADE,
        -- A machine can only be linked once its account is: a machine id means nothing
        -- to Vani outside the account it was registered under.
        CONSTRAINT "fk_vani_machine_link_account"
          FOREIGN KEY ("tenant_id") REFERENCES "vani_account_link" ("tenant_id") ON DELETE CASCADE,
        CONSTRAINT "ck_vani_machine_id" CHECK (length(btrim("machine_id")) > 0),
        CONSTRAINT "ck_vani_spoken_name" CHECK (length(btrim("spoken_name")) > 0)
      )`);
    // One Vani identity per machine, and one machine per Vani identity. Either way
    // round, a duplicate means a call about one generator describes another.
    await q.query(`
      CREATE UNIQUE INDEX "uq_vani_machine_link_equipment"
        ON "vani_machine_link" ("tenant_id", "source_system", "external_id")`);
    await q.query(`CREATE UNIQUE INDEX "uq_vani_machine_link_machine" ON "vani_machine_link" ("tenant_id", "machine_id")`);

    // ------------------------------------------------------------ call request
    await q.query(`
      CREATE TABLE "vani_call" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "alert_event_id" uuid NOT NULL REFERENCES "alert_event" ("id"),
        -- Copied at send time, not joined. Relinking a machine later does not change
        -- which account and which machine Vani was actually asked to call about.
        "vani_account_id" text NOT NULL,
        "machine_id" text NOT NULL,
        "severity" text NOT NULL,
        -- The whole request body. Vani speaks only from this, so it is the record of
        -- what the customer could have been told.
        "request" jsonb NOT NULL,
        "state" text NOT NULL DEFAULT 'pending',
        "attempts" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "last_error" text,
        "http_status" int,
        "trigger_id" text,
        "call_id" text,
        "vani_status" text,
        "disposition" text,
        "reason" text,
        "retry_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_vani_call_severity" CHECK ("severity" IN ('critical', 'warning', 'info')),
        -- accepted: Vani answered 202 or 200 duplicate, and owns the call from here.
        -- rejected: Vani refused the body (422). Resending it unchanged gets the same answer.
        -- failed: never answered in time. A call about an alert from yesterday helps nobody.
        CONSTRAINT "ck_vani_call_state" CHECK ("state" IN ('pending', 'accepted', 'rejected', 'failed')),
        CONSTRAINT "ck_vani_call_attempts" CHECK ("attempts" >= 0)
      )`);
    // Tenant first, though an alert id alone is already unique: it is what lets an
    // outcome reference a call only within its own tenant (below).
    await q.query(`CREATE UNIQUE INDEX "uq_vani_call_alert" ON "vani_call" ("tenant_id", "alert_event_id")`);
    await q.query(`CREATE INDEX "ix_vani_call_due" ON "vani_call" ("next_attempt_at") WHERE "state" = 'pending'`);
    await q.query(`CREATE INDEX "ix_vani_call_tenant" ON "vani_call" ("tenant_id", "created_at")`);
    await q.query(`
      CREATE FUNCTION "vani_call_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."state" <> 'pending' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
          RAISE EXCEPTION 'vani_call %: % is final', OLD."id", OLD."state"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."alert_event_id" IS DISTINCT FROM OLD."alert_event_id"
           OR NEW."vani_account_id" IS DISTINCT FROM OLD."vani_account_id" OR NEW."machine_id" IS DISTINCT FROM OLD."machine_id"
           OR NEW."severity" IS DISTINCT FROM OLD."severity" OR NEW."request" IS DISTINCT FROM OLD."request" THEN
          RAISE EXCEPTION 'vani_call %: what was asked of Vani cannot change, only its answer', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    // A retry has to resend the same body under the same event id. A request edited
    // between attempts would have Vani treat the second body as a duplicate of a first
    // one we no longer hold, and the record here would describe a call never asked for.
    await q.query(`
      CREATE TRIGGER "trg_vani_call_guard" BEFORE UPDATE ON "vani_call"
        FOR EACH ROW EXECUTE FUNCTION "vani_call_guard"()`);

    // ------------------------------------------------------------ call outcome
    await q.query(`
      CREATE TABLE "vani_call_outcome" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "alert_event_id" uuid NOT NULL,
        "attempt" int NOT NULL,
        "call_id" text,
        "outcome" text NOT NULL,
        -- Written by Vani for an alert history, and shown as sent.
        "summary" text,
        "duration_s" double precision,
        "called_at" timestamptz,
        "payload" jsonb NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        -- An outcome is about a call this tenant asked for, never one of another's.
        CONSTRAINT "fk_vani_call_outcome_call"
          FOREIGN KEY ("tenant_id", "alert_event_id") REFERENCES "vani_call" ("tenant_id", "alert_event_id"),
        CONSTRAINT "ck_vani_call_outcome_attempt" CHECK ("attempt" >= 0),
        CONSTRAINT "ck_vani_call_outcome_outcome" CHECK ("outcome" IN (
          'completed_spoke_with_customer', 'voicemail_dropped', 'voicemail_not_delivered',
          'no_answer', 'failed'))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_vani_call_outcome_attempt"
        ON "vani_call_outcome" ("tenant_id", "alert_event_id", "attempt")`);

    for (const table of ['vani_account_link', 'vani_machine_link', 'vani_call', 'vani_call_outcome']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "vani_account_link", "vani_machine_link" TO "ta_app"`);
    // A call request is settled, never withdrawn: there is no DELETE.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "vani_call" TO "ta_app"`);
    // An outcome is what Vani said happened. It is kept as received.
    await q.query(`GRANT SELECT, INSERT ON "vani_call_outcome" TO "ta_app"`);
    // Nothing is granted to ta_eval. A replay that reached alert code which phones
    // a customer is refused by the database, not trusted not to (G10).
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vani_call_outcome"`);
    await q.query(`DROP TABLE IF EXISTS "vani_call"`);
    await q.query(`DROP FUNCTION IF EXISTS "vani_call_guard"()`);
    await q.query(`DROP TABLE IF EXISTS "vani_machine_link"`);
    await q.query(`DROP TABLE IF EXISTS "vani_account_link"`);
  }
}
