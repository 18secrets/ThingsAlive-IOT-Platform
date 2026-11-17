import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An account's alert rule may watch its machines' fault codes.
 *
 * DtcDiagnostics added the `dtc` trigger to the alert engine but not to
 * `ck_alert_rule_trigger`, so the database refused every such rule as it was saved and
 * the trigger could not be used at all. Only `alert_rule`: no library template is a
 * fault-code rule yet, and `alert_rule_template`'s list stays as it is until one is.
 */
const BEFORE = `'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss', 'chain-origin', 'composite'`;

export class DtcAlertTrigger1764900000000 implements MigrationInterface {
  name = 'DtcAlertTrigger1764900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger" CHECK ("trigger" IN (${BEFORE}, 'dtc'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Refused while a fault-code rule exists, which is the right answer: removing the
    // kind would leave rules the engine still runs and the database no longer allows.
    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_trigger"`);
    await q.query(`ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_trigger" CHECK ("trigger" IN (${BEFORE}))`);
  }
}
