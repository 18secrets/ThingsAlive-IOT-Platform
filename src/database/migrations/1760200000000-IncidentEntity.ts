import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The incident entity (phase 2, after closeout §4's view): ownership, an SLA clock and
 * escalation, over the alerts the view already groups by machine.
 *
 * - `incident` — one live (unresolved) incident per machine, enforced by a partial
 *   unique index: two alerts firing at once on one machine must land in one incident,
 *   and a service check loses that race.
 * - `incident_alert` — which alerts it gathered. An alert is in at most one incident.
 *   Deleting an alert removes its link, never the incident's history.
 * - `incident_event` — the timeline, append-only, by trigger as well as by grant.
 * - `incident_sla_policy` — per account and severity: minutes to acknowledge and to
 *   resolve. No defaults: a response time Things Alive chose would be a promise the
 *   customer never made, so an account with no policy has incidents with no clock.
 *
 * Work is not linked here: an incident's work orders are the ones raised against its
 * alerts, through `work_order.alert_id`, so a job raised from an alert joins it with
 * nothing else to keep in step.
 */
export class IncidentEntity1760200000000 implements MigrationInterface {
  name = 'IncidentEntity1760200000000';

  public async up(q: QueryRunner): Promise<void> {
    const severities = `'none', 'low', 'medium', 'high', 'critical'`;

    await q.query(`
      CREATE TABLE "incident_sla_policy" (
        "tenant_id" text NOT NULL,
        "severity" text NOT NULL,
        "ack_within_minutes" integer NOT NULL,
        "resolve_within_minutes" integer NOT NULL,
        "updated_by" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "severity"),
        CONSTRAINT "ck_incident_sla_severity" CHECK ("severity" IN (${severities})),
        CONSTRAINT "ck_incident_sla_positive" CHECK ("ack_within_minutes" > 0 AND "resolve_within_minutes" > 0),
        -- Resolving before anyone has looked is not a promise anybody can keep.
        CONSTRAINT "ck_incident_sla_order" CHECK ("resolve_within_minutes" >= "ack_within_minutes")
      )`);

    await q.query(`
      CREATE TABLE "incident" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "severity" text NOT NULL,
        "status" text NOT NULL DEFAULT 'open',
        "owner_user_id" text,
        "opened_at" timestamptz NOT NULL,
        "acknowledged_at" timestamptz,
        "acknowledged_by" text,
        "resolved_at" timestamptz,
        "resolved_by" text,
        "resolution_note" text,
        "ack_due_at" timestamptz,
        "resolve_due_at" timestamptz,
        "escalation_level" integer NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_incident_severity" CHECK ("severity" IN (${severities})),
        CONSTRAINT "ck_incident_status" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
        CONSTRAINT "ck_incident_acknowledged" CHECK (("status" = 'open') = ("acknowledged_at" IS NULL)),
        CONSTRAINT "ck_incident_resolved" CHECK (
          ("status" = 'resolved') = ("resolved_at" IS NOT NULL)
          AND ("resolved_at" IS NULL OR length(btrim(coalesce("resolution_note", ''))) > 0)),
        CONSTRAINT "ck_incident_escalation" CHECK ("escalation_level" BETWEEN 0 AND 2)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_incident_live_per_machine"
        ON "incident" ("tenant_id", "source_system", "external_id") WHERE "status" <> 'resolved'`);
    await q.query(`CREATE INDEX "ix_incident_tenant_status" ON "incident" ("tenant_id", "status", "opened_at" DESC)`);

    await q.query(`
      CREATE TABLE "incident_alert" (
        "incident_id" uuid NOT NULL REFERENCES "incident" ("id"),
        "alert_event_id" uuid NOT NULL REFERENCES "alert_event" ("id") ON DELETE CASCADE,
        "tenant_id" text NOT NULL,
        "linked_at" timestamptz NOT NULL DEFAULT now(),
        -- Led by the tenant, like every tenant-owned key (test/rls-coverage.spec.ts).
        PRIMARY KEY ("tenant_id", "incident_id", "alert_event_id"),
        CONSTRAINT "uq_incident_alert_once" UNIQUE ("tenant_id", "alert_event_id")
      )`);

    await q.query(`
      CREATE TABLE "incident_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "incident_id" uuid NOT NULL REFERENCES "incident" ("id"),
        "kind" text NOT NULL,
        "actor" text NOT NULL,
        "at" timestamptz NOT NULL,
        "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "ck_incident_event_kind" CHECK ("kind" IN (
          'opened', 'alert_linked', 'severity_raised', 'acknowledged', 'assigned', 'work_raised',
          'escalated', 'resolved'))
      )`);
    await q.query(`CREATE INDEX "ix_incident_event_incident" ON "incident_event" ("incident_id", "at")`);
    // `seed:demo:reset` may delete the demo tenant's timeline, and nothing else may: the
    // exemption `tenant_parameter_append_only` makes (SeedDemoParameterReset1759200000000),
    // as narrow — DELETE only, only from a session carrying `ta.seed_demo`, only for a
    // tenant the seeder provisioned. SECURITY DEFINER with a pinned search_path for its
    // reason: the `tenant` lookup must see the row whatever policies arrive later.
    await q.query(`
      CREATE FUNCTION "incident_event_append_only"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          AND coalesce(current_setting('ta.seed_demo', true), '') = 'on'
          AND EXISTS (SELECT 1 FROM "tenant" WHERE "tenant_id" = OLD."tenant_id" AND "provisioned_by" = 'seed-demo') THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'incident_event is append-only: the timeline is what happened (incident_event_append_only)';
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_incident_event_append_only"
        BEFORE UPDATE OR DELETE ON "incident_event"
        FOR EACH ROW EXECUTE FUNCTION "incident_event_append_only"()`);

    for (const table of ['incident_sla_policy', 'incident', 'incident_alert', 'incident_event']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    }
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "incident_sla_policy" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "incident" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "incident_alert" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "incident_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "incident_event"`);
    await q.query(`DROP FUNCTION IF EXISTS "incident_event_append_only"()`);
    await q.query(`DROP TABLE IF EXISTS "incident_alert"`);
    await q.query(`DROP TABLE IF EXISTS "incident"`);
    await q.query(`DROP TABLE IF EXISTS "incident_sla_policy"`);
  }
}
