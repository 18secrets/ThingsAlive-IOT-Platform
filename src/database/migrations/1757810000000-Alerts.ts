import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alerts, which are 2.0's (task P1-119).
 *
 * Settled by Things Alive: alerting is enabled from the new version, so nothing here
 * mirrors or reads the existing platform's alert table. That also means no write-back
 * to worry about and no second vocabulary to reconcile.
 *
 * Three tables' worth of concepts live in two, because a rule and a firing are
 * genuinely different things: a rule is a standing request the customer edits, and a
 * firing is a fact that must not change when they edit it. The event carries a copy of
 * the rule's name and the evidence behind it for exactly that reason.
 */
export class Alerts1757810000000 implements MigrationInterface {
  name = 'Alerts1757810000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "alert_rule" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "trigger" text NOT NULL,
        "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "applies_to" text NOT NULL DEFAULT 'account',
        "plant_id" uuid,
        "source_system" text,
        "external_id" text,
        "severity" text NOT NULL DEFAULT 'high',
        "enabled" boolean NOT NULL DEFAULT true,
        "created_by" text,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_alert_rule_slug" ON "alert_rule" ("tenant_id", "slug")`);
    // The runner's question on every window: which rules are live in this account.
    await q.query(`
      CREATE INDEX "ix_alert_rule_tenant" ON "alert_rule" ("tenant_id", "enabled")`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN ('prediction-severity', 'signal-threshold', 'no-telemetry'))`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_applies"
        CHECK ("applies_to" IN ('account', 'plant', 'equipment'))`);
    // A scoped rule with nothing to scope to would look configured and never fire,
    // which is the most expensive way for an alert to be wrong.
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_scope"
        CHECK (
          ("applies_to" = 'account')
          OR ("applies_to" = 'plant' AND "plant_id" IS NOT NULL)
          OR ("applies_to" = 'equipment' AND "source_system" IS NOT NULL AND "external_id" IS NOT NULL)
        )`);

    await q.query(`
      CREATE TABLE "alert_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "rule_id" uuid NOT NULL,
        "rule_name" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "severity" text NOT NULL,
        "summary" text NOT NULL,
        "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "shift_local_date" text,
        "window_start" timestamptz,
        "window_end" timestamptz,
        "prediction_id" uuid,
        "state" text NOT NULL DEFAULT 'open',
        "acknowledged_by" text,
        "acknowledged_at" timestamptz,
        "resolved_by" text,
        "resolved_at" timestamptz,
        "resolution_note" text,
        "fired_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_alert_event_tenant" ON "alert_event" ("tenant_id", "fired_at")`);
    await q.query(`
      CREATE INDEX "ix_alert_event_asset"
        ON "alert_event" ("tenant_id", "source_system", "external_id", "fired_at")`);
    await q.query(`
      CREATE INDEX "ix_alert_event_rule" ON "alert_event" ("tenant_id", "rule_id", "state")`);
    await q.query(`
      ALTER TABLE "alert_event" ADD CONSTRAINT "ck_alert_event_state"
        CHECK ("state" IN ('open', 'acknowledged', 'resolved'))`);
    // Resolved without a note is a record that says something was dealt with and
    // cannot say what was found, which is the only part anybody reads a month later.
    await q.query(`
      ALTER TABLE "alert_event" ADD CONSTRAINT "ck_alert_event_resolution"
        CHECK ("state" <> 'resolved' OR "resolution_note" IS NOT NULL)`);
    // The same fault on every shift for a week is one thing wrong with one machine.
    // A list of seven identical rows is a list nobody reads, which is the failure
    // alerting exists to prevent rather than cause.
    await q.query(`
      CREATE UNIQUE INDEX "uq_alert_event_standing"
        ON "alert_event" ("tenant_id", "rule_id", "source_system", "external_id")
        WHERE "state" IN ('open', 'acknowledged')`);

    for (const table of ['alert_rule', 'alert_event']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
    }

    await q.query(`GRANT SELECT, INSERT, UPDATE ON "alert_rule" TO "ta_app"`);
    // A firing is a fact. It is acknowledged and resolved in place; it is never undone.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "alert_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "alert_event"`);
    await q.query(`DROP TABLE IF EXISTS "alert_rule"`);
  }
}
