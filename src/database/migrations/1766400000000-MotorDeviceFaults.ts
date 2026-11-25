import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The fault codes the logger itself saw, per record (Motor Logger server payload spec,
 * 25 Nov 2026: a `faults` array in every record, e.g. ["P101","P702"]).
 *
 * Kept apart from `device_dtc_episode`, which is 2.0's own judgement of the same readings
 * against the account's thresholds. The two can disagree — the firmware's limits are fixed
 * at flashing, the account's are parameters — and the disagreement is worth seeing, so
 * neither overwrites the other.
 *
 * Null and empty mean different things: null is a record from firmware that did not send
 * the field (everything before this build), `{}` is a second with no fault active.
 *
 * ADD COLUMN IF NOT EXISTS and no CHECK, as MotorFirmwareScores explains: the receiver
 * adds the same column itself, and a CHECK would turn one odd code into a 500 the device
 * retries for ever, holding every reading behind it.
 */
export class MotorDeviceFaults1766400000000 implements MigrationInterface {
  name = 'MotorDeviceFaults1766400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "motor_sensor_records" ADD COLUMN IF NOT EXISTS "device_faults" text[]`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "motor_sensor_records" DROP COLUMN IF EXISTS "device_faults"`);
  }
}
