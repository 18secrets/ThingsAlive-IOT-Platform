import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activation: a scenario running on one asset, its history, and the outbox (P1-09).
 *
 * Three tables, and the split between them is the design.
 *
 * `equipment_scenario` is the current state. `scenario_activation_event` is the
 * client's readable history of how it got there. `domain_event` is an outbox a worker
 * drains. The first two are tenant-owned and join the isolation policy; the third is
 * not, and that asymmetry is deliberate: an outbox is infrastructure that spans
 * tenants and carries delivery state — retry counts, last error — which no customer
 * should be reading, and which must survive being pruned without taking the answer to
 * "when did somebody turn this off" with it.
 *
 * The outbox exists before the broker does. P0-16 blocks the broker, but a publisher
 * is a loop over `pending` rows; everything that *produces* an event is already
 * correct, and it is correct at the point where getting it wrong is expensive to
 * discover. Publishing directly instead would mean a crash between commit and publish
 * loses the event silently: the scenario is active and nothing downstream was told,
 * which surfaces weeks later as "why was that machine never scored".
 */
export class Activation1757700000000 implements MigrationInterface {
  name = 'Activation1757700000000';

  private readonly tenantTables = ['equipment_scenario', 'scenario_activation_event'];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_scenario" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "client_scenario_slug" text NOT NULL,
        "state" text NOT NULL DEFAULT 'proposed',
        "parameter_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "blockers_at_activation" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "activated_by" text,
        "activated_at" timestamptz,
        "state_changed_by" text,
        "state_changed_at" timestamptz,
        "state_reason" text,
        "last_evaluated_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // One row per (asset, scenario). Activating the same scenario twice on the same
    // machine is not two activations, it is a state change to the one that exists.
    await q.query(`CREATE UNIQUE INDEX "uq_equipment_scenario" ON "equipment_scenario" ("tenant_id", "source_system", "external_id", "client_scenario_slug")`);
    // The scorer's access path: everything active for a tenant.
    await q.query(`CREATE INDEX "ix_equipment_scenario_state" ON "equipment_scenario" ("tenant_id", "state")`);
    await q.query(`CREATE INDEX "ix_equipment_scenario_scenario" ON "equipment_scenario" ("tenant_id", "client_scenario_slug")`);

    await q.query(`
      CREATE TABLE "scenario_activation_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "client_scenario_slug" text NOT NULL,
        "action" text NOT NULL,
        "from_state" text,
        "to_state" text NOT NULL,
        "reason" text,
        "blockers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "actor_user_id" text NOT NULL,
        "actor_roles" text[] NOT NULL DEFAULT '{}'::text[],
        "at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_activation_event_asset" ON "scenario_activation_event" ("tenant_id", "source_system", "external_id", "at")`);
    await q.query(`CREATE INDEX "ix_activation_event_scenario" ON "scenario_activation_event" ("tenant_id", "client_scenario_slug", "at")`);

    await q.query(`
      CREATE TABLE "domain_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_type" text NOT NULL,
        "tenant_id" text NOT NULL,
        "subject" text NOT NULL,
        "payload" jsonb NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "delivery_state" text NOT NULL DEFAULT 'pending',
        "delivered_at" timestamptz,
        "attempts" int NOT NULL DEFAULT 0,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // The publisher's only query: undelivered, oldest first. Partial, because the
    // delivered rows are the ones that accumulate and the publisher never reads them.
    await q.query(`
      CREATE INDEX "ix_domain_event_pending" ON "domain_event" ("occurred_at")
        WHERE "delivery_state" = 'pending'`);
    await q.query(`CREATE INDEX "ix_domain_event_tenant" ON "domain_event" ("tenant_id", "occurred_at")`);

    for (const table of this.tenantTables) {
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

    // No DELETE on the history: it is a record, and the value of a record is that it
    // is not edited afterwards by the party it describes.
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_scenario" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "scenario_activation_event" TO "ta_app"`);
    // The application writes events and the publisher marks them delivered. Neither
    // deletes: pruning an outbox is an operations decision with its own retention
    // policy, not something a request should be able to do.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "domain_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [...this.tenantTables].reverse()) {
      await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
    }
    await q.query(`DROP TABLE IF EXISTS "domain_event"`);
    await q.query(`DROP TABLE IF EXISTS "scenario_activation_event"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_scenario"`);
  }
}
