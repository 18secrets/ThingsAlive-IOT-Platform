import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The pump logger's email alerts go through the outbox (Motor Monitor integration spec,
 * 24 Nov 2026: "Alerts (email, SMS or push) when P101 … P708 becomes active, or a device
 * goes offline").
 *
 * One event per thing that happened, enforced here rather than by a check before the
 * insert: the motor job may run on two processes, and a lookup loses to a concurrent
 * write. The subject is what happened: a fault-code episode's id, or a logger and the
 * upload after which it fell silent. A second pass that sees the same silence inserts
 * nothing, and nobody is told twice about one outage.
 *
 * Partial, so the incident escalations — which carry the incident's id as subject and
 * may rightly escalate the same incident twice, once per level — are untouched.
 */
export class MotorAlertEvents1766300000000 implements MigrationInterface {
  name = 'MotorAlertEvents1766300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE UNIQUE INDEX "uq_domain_event_motor_alert"
        ON "domain_event" ("event_type", "tenant_id", "subject")
        WHERE "event_type" IN ('motor.fault_code_raised.v1', 'motor.logger_offline.v1')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_domain_event_motor_alert"`);
  }
}
