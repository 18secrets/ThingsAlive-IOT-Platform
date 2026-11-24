import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The pump logger's three diagnostic scores get columns of their own (Motor Monitor
 * integration spec, 24 Nov 2026).
 *
 * The firmware sends `vibration`, `air_gap` and `load_loss` as 0-100 scores worked out
 * from current over a rolling 10 s window. The receiver had been aliasing the first two
 * into `vibration_mm_s` and `water_air_gap`, columns meant for real sensors, so a score
 * of 40 reached the library's ISO vibration zones as 40 mm/s. A score is not a velocity,
 * and the column it sits in is the only thing that says which one a number is.
 *
 * `load_loss` is added here as well: the receiver has created it on start since 16 Nov,
 * but no migration did, so a database the receiver never touched (every test database)
 * did not have it.
 *
 * ADD COLUMN IF NOT EXISTS and no CHECKs, as MotorLoggerSensors explains: the receiver
 * adds the same columns itself, and a CHECK would turn one odd score into a 500 the
 * device retries for ever.
 */
export class MotorFirmwareScores1766100000000 implements MigrationInterface {
  name = 'MotorFirmwareScores1766100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "motor_sensor_records"
        ADD COLUMN IF NOT EXISTS "load_loss" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "vibration_score" NUMERIC(6,1),
        ADD COLUMN IF NOT EXISTS "air_gap_score" NUMERIC(6,1)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "motor_sensor_records"
        DROP COLUMN IF EXISTS "air_gap_score",
        DROP COLUMN IF EXISTS "vibration_score",
        DROP COLUMN IF EXISTS "load_loss"`);
  }
}
