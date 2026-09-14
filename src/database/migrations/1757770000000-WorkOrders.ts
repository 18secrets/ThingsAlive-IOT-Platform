import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Jobs on machines (task P1-87).
 *
 * Nothing here mirrors anything. The existing platform has no work-order module, so
 * this is 2.0's own table and there is no write-back to worry about.
 *
 * The migration also appends `action.assign` to the built-in manager roles of accounts
 * that already exist. Provisioning deliberately never undoes a client's edit, so it
 * cannot be the thing that carries a new capability — but a capability introduced
 * today is not one a client chose to remove yesterday, and leaving it out would make
 * this feature invisible in every account provisioned before now.
 */
export class WorkOrders1757770000000 implements MigrationInterface {
  name = 'WorkOrders1757770000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "work_order" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "reference" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "title" text NOT NULL,
        "description" text,
        "status" text NOT NULL DEFAULT 'open',
        "priority" text NOT NULL DEFAULT 'normal',
        "assigned_to_user_id" uuid,
        "prediction_id" uuid,
        "due_at" timestamptz,
        "started_at" timestamptz,
        "ended_at" timestamptz,
        "resolution" text,
        "raised_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_work_order_reference" ON "work_order" ("tenant_id", "reference")`);
    await q.query(`
      CREATE INDEX "ix_work_order_asset"
        ON "work_order" ("tenant_id", "source_system", "external_id")`);
    // "What is on my list" is the operator's only screen, and it runs this.
    await q.query(`
      CREATE INDEX "ix_work_order_assignee" ON "work_order" ("tenant_id", "assigned_to_user_id")
        WHERE "status" IN ('open', 'in-progress')`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_status"
        CHECK ("status" IN ('open', 'in-progress', 'completed', 'cancelled'))`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_priority"
        CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'))`);
    // A completed job without a note is, a month later, indistinguishable from an
    // abandoned one. The service refuses it; the constraint means a script cannot.
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_resolution"
        CHECK ("status" <> 'completed' OR "resolution" IS NOT NULL)`);

    await q.query(`
      CREATE TABLE "work_order_counter" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "next_number" integer NOT NULL DEFAULT 1
      )`);
    // The ON CONFLICT target for handing out the next number.
    await q.query(`
      CREATE UNIQUE INDEX "uq_work_order_counter" ON "work_order_counter" ("tenant_id")`);

    await q.query(`
      CREATE TABLE "work_order_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "work_order_id" uuid NOT NULL,
        "kind" text NOT NULL,
        "from_status" text,
        "to_status" text,
        "from_assignee" uuid,
        "to_assignee" uuid,
        "note" text,
        "actor_user_id" text NOT NULL,
        "at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE INDEX "ix_work_order_event_order"
        ON "work_order_event" ("tenant_id", "work_order_id", "at")`);

    for (const table of ['work_order', 'work_order_counter', 'work_order_event']) {
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

    await q.query(`GRANT SELECT, INSERT, UPDATE ON "work_order" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "work_order_counter" TO "ta_app"`);
    // History is written and read. Never amended.
    await q.query(`GRANT SELECT, INSERT ON "work_order_event" TO "ta_app"`);

    // Reach the accounts that already exist. Appended rather than replacing the list,
    // so a client who took a capability away keeps it away.
    await q.query(`
      UPDATE "tenant_role"
         SET "capabilities" = array_append("capabilities", 'action.assign')
       WHERE "is_built_in" = true
         AND "slug" IN ('ceo-manager', 'site-manager')
         AND NOT ('action.assign' = ANY ("capabilities"))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "tenant_role"
         SET "capabilities" = array_remove("capabilities", 'action.assign')
       WHERE "is_built_in" = true`);
    await q.query(`DROP TABLE IF EXISTS "work_order_event"`);
    await q.query(`DROP TABLE IF EXISTS "work_order_counter"`);
    await q.query(`DROP TABLE IF EXISTS "work_order"`);
  }
}
