import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A job raised from an alert says which alert (D-002, phase 1 manual testing, B6).
 *
 * Until now the only thread between the two was the machine: a manager raising a job
 * from an alert could not record why, and "which of our alerts did anyone act on" was
 * answerable only by reading titles. `prediction_id` already gives the scorer's jobs
 * that thread; this gives a person's the same.
 *
 * The foreign key carries the machine as well as the id, so the database refuses a job
 * on one machine linked to an alert on another — or in another account. A service check
 * would hold until the first code path that forgot it; this holds for all of them. The
 * unique constraint it needs on `alert_event` adds nothing the primary key does not
 * already guarantee; a composite foreign key simply needs one to point at.
 *
 * Nullable, and a null skips the check: most jobs are not raised from an alert.
 */
export class WorkOrderAlertLink1759000000000 implements MigrationInterface {
  name = 'WorkOrderAlertLink1759000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "alert_event" ADD CONSTRAINT "uq_alert_event_machine_id"
        UNIQUE ("tenant_id", "source_system", "external_id", "id")`);
    await q.query(`ALTER TABLE "work_order" ADD COLUMN "alert_id" uuid`);
    await q.query(`
      ALTER TABLE "work_order" ADD CONSTRAINT "fk_work_order_alert"
        FOREIGN KEY ("tenant_id", "source_system", "external_id", "alert_id")
        REFERENCES "alert_event" ("tenant_id", "source_system", "external_id", "id")`);
    await q.query(`CREATE INDEX "ix_work_order_alert" ON "work_order" ("tenant_id", "alert_id") WHERE "alert_id" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "ix_work_order_alert"`);
    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT "fk_work_order_alert"`);
    await q.query(`ALTER TABLE "work_order" DROP COLUMN "alert_id"`);
    await q.query(`ALTER TABLE "alert_event" DROP CONSTRAINT "uq_alert_event_machine_id"`);
  }
}
