import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A job in progress has somebody doing it (testing sheet TC_191).
 *
 * The service refuses to start an unassigned job and to unassign one under way; this is
 * the same line where a concurrent write cannot step round it. NOT VALID: jobs started
 * unassigned before this rule are left as they are (they can still be reassigned,
 * completed or cancelled), and every new write is checked.
 */
export class WorkOrderStartAssigned1765000000000 implements MigrationInterface {
  name = 'WorkOrderStartAssigned1765000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "work_order" ADD CONSTRAINT "ck_work_order_in_progress_assigned"
      CHECK ("status" <> 'in-progress' OR "assigned_to_user_id" IS NOT NULL) NOT VALID`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "work_order" DROP CONSTRAINT "ck_work_order_in_progress_assigned"`);
  }
}
