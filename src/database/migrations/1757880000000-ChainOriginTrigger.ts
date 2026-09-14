import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A fifth alert trigger: where a physical chain says the fault entered (task P4-01).
 *
 * The difference from the threshold trigger is the point of the whole intelligence
 * layer. A threshold on coolant temperature fires on a machine working hard, because a
 * hard-working machine really is hot. This fires when a stage is off the curve its own
 * drivers predict — which a hard-working machine is not — and because the chain names
 * the stage, the alert arrives pointing at a component instead of at a number.
 */
export class ChainOriginTrigger1757880000000 implements MigrationInterface {
  name = 'ChainOriginTrigger1757880000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN (
          'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss',
          'chain-origin'
        ))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Any rule of the new kind has to go before the old constraint can hold again.
    await q.query(`DELETE FROM "alert_rule" WHERE "trigger" = 'chain-origin'`);
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger"
        CHECK ("trigger" IN (
          'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss'
        ))`);
  }
}
