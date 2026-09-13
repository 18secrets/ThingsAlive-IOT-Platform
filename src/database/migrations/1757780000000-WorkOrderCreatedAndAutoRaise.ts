import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Jobs are "created", and the scorer can create them (tasks P1-87, P1-104).
 *
 * Two changes settled by Things Alive. The first is a rename: the three things that
 * happen to a job are created, in progress and completed, so the first state is called
 * what people call it.
 *
 * The second is that raising is automatic, with a person still in the loop. The loop
 * is the assignment: the scorer creates the job and leaves it unassigned, so it lands
 * in a manager's list and a human decides who goes.
 *
 * The partial unique index is the load-bearing part. A failing machine predicts
 * critical on every scoring run — every few minutes, for days — and a job per run is a
 * queue that is ignored within the hour, which is worse than no queue because it looks
 * like coverage. One live automatic job per machine per scenario, enforced here rather
 * than only in the service, because two scoring runs in flight would both read
 * "nothing live" and both insert.
 */
export class WorkOrderCreatedAndAutoRaise1757780000000 implements MigrationInterface {
  name = 'WorkOrderCreatedAndAutoRaise1757780000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT "ck_work_order_status"`);
    await q.query(`ALTER TABLE "work_order" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(`UPDATE "work_order" SET "status" = 'created' WHERE "status" = 'open'`);
    await q.query(`ALTER TABLE "work_order" ALTER COLUMN "status" SET DEFAULT 'created'`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_status"
        CHECK ("status" IN ('created', 'in-progress', 'completed', 'cancelled'))`);

    await q.query(`DROP INDEX IF EXISTS "ix_work_order_assignee"`);
    await q.query(`
      CREATE INDEX "ix_work_order_assignee" ON "work_order" ("tenant_id", "assigned_to_user_id")
        WHERE "status" IN ('created', 'in-progress')`);

    await q.query(`ALTER TABLE "work_order" ADD COLUMN "origin" text NOT NULL DEFAULT 'manual'`);
    await q.query(`ALTER TABLE "work_order" ADD COLUMN "raised_for_scenario" text`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_origin"
        CHECK ("origin" IN ('manual', 'prediction'))`);
    // An automatic job without the scenario that caused it cannot be de-duplicated,
    // and would silently raise a second one on the next run.
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_auto_scenario"
        CHECK ("origin" <> 'prediction' OR "raised_for_scenario" IS NOT NULL)`);

    await q.query(`
      CREATE UNIQUE INDEX "uq_work_order_live_auto"
        ON "work_order" ("tenant_id", "source_system", "external_id", "raised_for_scenario")
        WHERE "origin" = 'prediction' AND "status" IN ('created', 'in-progress')`);

    // "What was raised by the scorer, and did anybody act on it" — the question the
    // prediction link exists to answer.
    await q.query(`
      CREATE INDEX "ix_work_order_prediction" ON "work_order" ("tenant_id", "prediction_id")
        WHERE "prediction_id" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "ix_work_order_prediction"`);
    await q.query(`DROP INDEX IF EXISTS "uq_work_order_live_auto"`);
    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT IF EXISTS "ck_work_order_auto_scenario"`);
    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT IF EXISTS "ck_work_order_origin"`);
    await q.query(`ALTER TABLE "work_order" DROP COLUMN IF EXISTS "raised_for_scenario"`);
    await q.query(`ALTER TABLE "work_order" DROP COLUMN IF EXISTS "origin"`);

    await q.query(`DROP INDEX IF EXISTS "ix_work_order_assignee"`);
    await q.query(`
      CREATE INDEX "ix_work_order_assignee" ON "work_order" ("tenant_id", "assigned_to_user_id")
        WHERE "status" IN ('open', 'in-progress')`);

    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT "ck_work_order_status"`);
    await q.query(`ALTER TABLE "work_order" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(`UPDATE "work_order" SET "status" = 'open' WHERE "status" = 'created'`);
    await q.query(`ALTER TABLE "work_order" ALTER COLUMN "status" SET DEFAULT 'open'`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_status"
        CHECK ("status" IN ('open', 'in-progress', 'completed', 'cancelled'))`);
  }
}
