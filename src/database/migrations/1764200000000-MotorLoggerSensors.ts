import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The motor logger's added sensors (firmware team, 9 Nov): ambient temperature,
 * vibration velocity, the device's own load figure, and the water / air-gap reading.
 *
 * Nullable, because the loggers in the field and the demo simulator do not send them
 * yet, and the receiver must keep accepting what they do send. A null is "no such
 * sensor on this logger", which the motor job carries through as no signal at all.
 *
 * ADD COLUMN IF NOT EXISTS, for the same reason the receiver's own tables are created
 * IF NOT EXISTS (MotorLoggerIngest): the receiver adds these columns itself on start, so
 * whichever of the two runs first, the other finds them and carries on.
 *
 * No range CHECKs, as before: the receiver is the writer of record and a CHECK would turn
 * one odd reading into a 500 the device retries for ever.
 */
export class MotorLoggerSensors1764200000000 implements MigrationInterface {
  name = 'MotorLoggerSensors1764200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "motor_sensor_records"
        ADD COLUMN IF NOT EXISTS "ambient_c" NUMERIC(6,1),
        ADD COLUMN IF NOT EXISTS "vibration_mm_s" NUMERIC(7,2),
        ADD COLUMN IF NOT EXISTS "load_pct" NUMERIC(6,1),
        ADD COLUMN IF NOT EXISTS "water_air_gap" NUMERIC(10,2)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "motor_sensor_records"
        DROP COLUMN IF EXISTS "water_air_gap",
        DROP COLUMN IF EXISTS "load_pct",
        DROP COLUMN IF EXISTS "vibration_mm_s",
        DROP COLUMN IF EXISTS "ambient_c"`);
  }
}
