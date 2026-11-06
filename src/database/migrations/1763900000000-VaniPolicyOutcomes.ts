import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two outcomes Vani reports when it accepted a trigger and decided not to ring:
 * `held_for_inbound_review` and `suppressed_by_policy` (Machine Lane Spec §3.4).
 *
 * The Nov 3 guide listed five outcomes and the first migration took it at its word. The
 * spec's §3 is the contract the live service was built and tested against (Phase 0
 * answers, 5 Nov), and since the four-lane scope a switched-off feature is reported as
 * `suppressed_by_policy` with reason `feature_not_enabled` — as is a call over the daily
 * cap. Refusing those callbacks would leave the alert history silent about exactly the
 * calls a customer asks "why didn't you ring me?" about.
 *
 * Down puts the five back. It fails, rather than deleting anything, while a stored
 * outcome uses one of the two: an outcome is a record of what Vani did, and losing it
 * to make a rollback succeed is the wrong trade.
 */
export class VaniPolicyOutcomes1763900000000 implements MigrationInterface {
  name = 'VaniPolicyOutcomes1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vani_call_outcome" DROP CONSTRAINT "ck_vani_call_outcome_outcome"`);
    await q.query(`
      ALTER TABLE "vani_call_outcome" ADD CONSTRAINT "ck_vani_call_outcome_outcome" CHECK ("outcome" IN (
        'completed_spoke_with_customer', 'voicemail_dropped', 'voicemail_not_delivered',
        'no_answer', 'failed', 'held_for_inbound_review', 'suppressed_by_policy'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vani_call_outcome" DROP CONSTRAINT "ck_vani_call_outcome_outcome"`);
    await q.query(`
      ALTER TABLE "vani_call_outcome" ADD CONSTRAINT "ck_vani_call_outcome_outcome" CHECK ("outcome" IN (
        'completed_spoke_with_customer', 'voicemail_dropped', 'voicemail_not_delivered',
        'no_answer', 'failed'))`);
  }
}
