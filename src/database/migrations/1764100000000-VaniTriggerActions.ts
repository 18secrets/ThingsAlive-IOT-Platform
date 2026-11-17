import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Calls about a prediction that raised no alert (D57, Lane B): `trigger.kind =
 * trigger_action` on the same `/platform/alert-call`.
 *
 * Until now every Vani call was about an alert, and the alert's id was the event id
 * Vani dedupes on. A prediction call has no alert, so the ledger gains `event_id`:
 * the alert's id for an alert call, a fresh id for a prediction call. It is generated
 * from the two, so no existing write changes, and an alert call's event id is still
 * its alert id — which is what Vani has already been told. Outcomes and actions now
 * reference the call by `event_id`; their `alert_event_id` columns hold the event id,
 * which for every alert call is the same value as before.
 *
 * One prediction call per machine, scenario and day, held by the database: the shift
 * runner scores a machine more than once a day, and a customer told about the same
 * prediction twice in an afternoon learns to stop answering.
 *
 * Down fails rather than deleting while a prediction call exists: what Vani was asked
 * to say to a customer is a record, not a cache.
 */
export class VaniTriggerActions1764100000000 implements MigrationInterface {
  name = 'VaniTriggerActions1764100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "vani_call"
        ADD COLUMN "kind" text NOT NULL DEFAULT 'alert',
        ADD COLUMN "trigger_event_id" uuid,
        ADD COLUMN "prediction_id" uuid,
        ADD COLUMN "source_system" text,
        ADD COLUMN "external_id" text,
        ADD COLUMN "client_scenario_slug" text,
        -- The machine's shift-local date the prediction was scored for.
        ADD COLUMN "trigger_day" date,
        ALTER COLUMN "alert_event_id" DROP NOT NULL`);
    await q.query(`
      ALTER TABLE "vani_call"
        ADD COLUMN "event_id" uuid GENERATED ALWAYS AS (COALESCE("alert_event_id", "trigger_event_id")) STORED`);
    await q.query(`
      ALTER TABLE "vani_call" ADD CONSTRAINT "ck_vani_call_kind" CHECK (
        ("kind" = 'alert' AND "alert_event_id" IS NOT NULL AND "trigger_event_id" IS NULL AND "prediction_id" IS NULL
          AND "source_system" IS NULL AND "external_id" IS NULL AND "client_scenario_slug" IS NULL AND "trigger_day" IS NULL)
        OR
        ("kind" = 'trigger_action' AND "alert_event_id" IS NULL AND "trigger_event_id" IS NOT NULL
          AND "prediction_id" IS NOT NULL AND "source_system" IS NOT NULL AND "external_id" IS NOT NULL
          AND "client_scenario_slug" IS NOT NULL AND "trigger_day" IS NOT NULL))`);
    await q.query(`CREATE UNIQUE INDEX "uq_vani_call_event" ON "vani_call" ("tenant_id", "event_id")`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_vani_call_prediction_day"
        ON "vani_call" ("tenant_id", "source_system", "external_id", "client_scenario_slug", "trigger_day")
        WHERE "kind" = 'trigger_action'`);

    for (const [table, fk] of [['vani_call_outcome', 'fk_vani_call_outcome_call'], ['vani_call_action', 'fk_vani_call_action_call']]) {
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${fk}"`);
      await q.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "${fk}"
          FOREIGN KEY ("tenant_id", "alert_event_id") REFERENCES "vani_call" ("tenant_id", "event_id")`);
    }

    // The guard keeps what was asked of Vani fixed once asked; the new columns are part
    // of what was asked.
    await q.query(`
      CREATE OR REPLACE FUNCTION "vani_call_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."state" <> 'pending' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
          RAISE EXCEPTION 'vani_call %: % is final', OLD."id", OLD."state"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."alert_event_id" IS DISTINCT FROM OLD."alert_event_id"
           OR NEW."vani_account_id" IS DISTINCT FROM OLD."vani_account_id" OR NEW."machine_id" IS DISTINCT FROM OLD."machine_id"
           OR NEW."severity" IS DISTINCT FROM OLD."severity" OR NEW."request" IS DISTINCT FROM OLD."request"
           OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."trigger_event_id" IS DISTINCT FROM OLD."trigger_event_id"
           OR NEW."prediction_id" IS DISTINCT FROM OLD."prediction_id"
           OR NEW."source_system" IS DISTINCT FROM OLD."source_system" OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
           OR NEW."client_scenario_slug" IS DISTINCT FROM OLD."client_scenario_slug"
           OR NEW."trigger_day" IS DISTINCT FROM OLD."trigger_day" THEN
          RAISE EXCEPTION 'vani_call %: what was asked of Vani cannot change, only its answer', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION "vani_call_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    for (const [table, fk] of [['vani_call_outcome', 'fk_vani_call_outcome_call'], ['vani_call_action', 'fk_vani_call_action_call']]) {
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${fk}"`);
      await q.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "${fk}"
          FOREIGN KEY ("tenant_id", "alert_event_id") REFERENCES "vani_call" ("tenant_id", "alert_event_id")`);
    }
    // Fails while a prediction call exists, which is the point: see the class comment.
    await q.query(`ALTER TABLE "vani_call" ALTER COLUMN "alert_event_id" SET NOT NULL`);
    await q.query(`DROP INDEX "uq_vani_call_prediction_day"`);
    await q.query(`DROP INDEX "uq_vani_call_event"`);
    await q.query(`
      ALTER TABLE "vani_call"
        DROP CONSTRAINT "ck_vani_call_kind",
        DROP COLUMN "event_id",
        DROP COLUMN "trigger_day",
        DROP COLUMN "client_scenario_slug",
        DROP COLUMN "external_id",
        DROP COLUMN "source_system",
        DROP COLUMN "prediction_id",
        DROP COLUMN "trigger_event_id",
        DROP COLUMN "kind"`);
  }
}
