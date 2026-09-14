import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A fourth alert trigger: fuel leaving a machine that was not running (task P4-04).
 *
 * First in Things Alive's own build order for the telemetry use cases, and the reason
 * is that it needs nothing: no baseline, no model, no history. A tank, a key and a GPS
 * fix.
 */
export class FuelLossTrigger1757830000000 implements MigrationInterface {
  name = 'FuelLossTrigger1757830000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN ('prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Any rule of the new kind has to go before the old constraint can hold again.
    await q.query(`DELETE FROM "alert_rule" WHERE "trigger" = 'fuel-loss'`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN ('prediction-severity', 'signal-threshold', 'no-telemetry'))`);
  }
}
