import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The motor loggers' landing tables (SIM800L GSM loggers).
 *
 * The receiver is `motor_logger_http_server.py` (Flask): it takes the loggers' POSTs to
 * `/api/sensor-data/bulk`, inserts with ON CONFLICT DO NOTHING, ACKs after commit, and
 * writes straight into this database. These two tables are its schema, column for
 * column and index for index, so its own `CREATE TABLE IF NOT EXISTS` finds them here
 * and its inserts — which name their columns — work unchanged. Created IF NOT EXISTS for
 * the same reason the other way round: if the receiver ran first, its tables are
 * adopted, not refused.
 *
 * What 2.0 adds is nullable, so the receiver never has to know about it:
 *   - `reading_at` / `time_basis`: the reading's wall-clock time, filled in by 2.0's
 *     motor telemetry job. The device's `timestamp` is its own clock, not Unix time; the
 *     receiver keeps no device clock at send time, so the newest record of each batch is
 *     anchored to the batch's `received_at` and the rest placed by the device clock
 *     before it — 'approximate', and said so on the row.
 *   - `processed_at` on the upload log: the job's mark that a batch's logger-health
 *     counters have been turned into signals.
 *   A row whose `reading_at` is null is the job's queue; a partial index keeps finding it
 *   cheap however large the table grows.
 *
 * No tenant column: readings arrive before 2.0 knows whose they are. A logger maps to
 * an account through `device_inventory`, and reads go through that mapping.
 *
 * No range CHECKs, deliberately. The receiver is the writer of record and validates
 * shape, not range; a CHECK here would turn one odd reading into a 500, and the device
 * retries a 500 for ever, holding everything behind it. The job skips what it cannot
 * use instead.
 */
export class MotorLoggerIngest1763900000000 implements MigrationInterface {
  name = 'MotorLoggerIngest1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "motor_sensor_records" (
        "device_id"     VARCHAR(64)   NOT NULL,
        "seq"           BIGINT        NOT NULL,
        "device_ts"     BIGINT        NOT NULL,
        "voltage_v"     NUMERIC(7,1)  NOT NULL,
        "current_a"     NUMERIC(7,2)  NOT NULL,
        "power_factor"  NUMERIC(4,2)  NOT NULL,
        "temperature_c" NUMERIC(7,1)  NOT NULL,
        "rpm"           INTEGER       NOT NULL,
        "batch_id"      VARCHAR(128)  NOT NULL,
        "received_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("device_id", "seq")
      )`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "motor_upload_log" (
        "id"            BIGSERIAL     PRIMARY KEY,
        "device_id"     VARCHAR(64)   NOT NULL,
        "batch_id"      VARCHAR(128)  NOT NULL,
        "first_seq"     BIGINT        NOT NULL,
        "last_seq"      BIGINT        NOT NULL,
        "record_count"  INTEGER       NOT NULL,
        "stored_count"  INTEGER       NOT NULL,
        "boot"          BIGINT,
        "lost_total"    BIGINT,
        "dropped_total" BIGINT,
        "received_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )`);
    // The receiver's own indexes, by its own names, so its IF NOT EXISTS finds them.
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_motor_records_device_received" ON "motor_sensor_records" ("device_id", "received_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_motor_upload_log_device" ON "motor_upload_log" ("device_id", "received_at")`);

    await q.query(`ALTER TABLE "motor_sensor_records" ADD COLUMN IF NOT EXISTS "reading_at" timestamptz`);
    await q.query(`ALTER TABLE "motor_sensor_records" ADD COLUMN IF NOT EXISTS "time_basis" text`);
    await q.query(`
      ALTER TABLE "motor_sensor_records" ADD CONSTRAINT "ck_motor_sensor_records_time_basis"
        CHECK ("time_basis" IS NULL OR "time_basis" IN ('device_now', 'approximate'))`);
    await q.query(`ALTER TABLE "motor_upload_log" ADD COLUMN IF NOT EXISTS "processed_at" timestamptz`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_motor_sensor_records_reading_at" ON "motor_sensor_records" ("device_id", "reading_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_motor_sensor_records_pending" ON "motor_sensor_records" ("received_at") WHERE "reading_at" IS NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_motor_upload_log_pending" ON "motor_upload_log" ("id") WHERE "processed_at" IS NULL`);

    // The app reads both and fills in its own columns; the receiver inserts as its own login.
    await q.query(`GRANT SELECT, UPDATE ON "motor_sensor_records" TO "ta_app"`);
    await q.query(`GRANT SELECT, UPDATE ON "motor_upload_log" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "motor_upload_log"`);
    await q.query(`DROP TABLE IF EXISTS "motor_sensor_records"`);
  }
}
