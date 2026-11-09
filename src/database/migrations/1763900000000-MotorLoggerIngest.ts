import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The motor loggers' own landing tables (SIM800L GSM loggers, `POST /api/sensor-data/bulk`).
 *
 * The first device that posts to 2.0 directly rather than reaching it through the
 * existing platform's sensor map. The two tables are the logger contract's, column for
 * column, so the firmware's guarantees hold as written: one row per (device_id, seq),
 * inserted with ON CONFLICT DO NOTHING, so a resent range — after a lost ACK, or halved
 * after a 413 — is stored once whatever its batch size.
 *
 * What is added to the contract, and why:
 *   - `reading_at`: the reading's wall-clock time. The device's `timestamp` is its own
 *     clock, not Unix time, and a batch can arrive hours late after a GSM outage, so
 *     `received_at` is not when anything was measured. The firmware sends `device_now`
 *     (its clock at send time) and the reading happened `device_now - timestamp`
 *     seconds before the request arrived.
 *   - `time_basis`: 'device_now' when that arithmetic was possible; 'approximate' when a
 *     batch came without `device_now` (older firmware), and the newest record was
 *     assumed to be taken as it arrived. Kept on the row, so nothing downstream mistakes
 *     a guessed time for a measured one.
 *   - `motor_logger_key`: a hash of each logger's key. Plain HTTP and no TLS is what the
 *     modem can do; without a key anyone with a device_id could post readings as that
 *     motor. The key itself is shown once, when issued, and never stored.
 *
 * No tenant column on the readings. They arrive before 2.0 knows whose they are: a
 * logger maps to an account through `device_inventory`, and a logger can move between
 * machines. Reads go through that mapping, never straight from these tables to a tenant.
 */
export class MotorLoggerIngest1763900000000 implements MigrationInterface {
  name = 'MotorLoggerIngest1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "motor_sensor_records" (
        "device_id"     varchar(64)   NOT NULL,
        "seq"           bigint        NOT NULL,
        "device_ts"     bigint        NOT NULL,
        "voltage_v"     numeric(7,1)  NOT NULL,
        "current_a"     numeric(7,2)  NOT NULL,
        "power_factor"  numeric(4,2)  NOT NULL,
        "temperature_c" numeric(7,1)  NOT NULL,
        "rpm"           integer       NOT NULL,
        "batch_id"      varchar(128)  NOT NULL,
        "received_at"   timestamptz   NOT NULL DEFAULT now(),
        "reading_at"    timestamptz   NOT NULL,
        "time_basis"    text          NOT NULL,
        PRIMARY KEY ("device_id", "seq"),
        -- The contract's ranges. A reading outside them is a firmware or wiring fault,
        -- and storing it would put it on a chart as a measurement.
        CONSTRAINT "ck_motor_sensor_records_seq" CHECK ("seq" BETWEEN 1 AND 4294967295),
        CONSTRAINT "ck_motor_sensor_records_values" CHECK (
          "voltage_v" BETWEEN 0 AND 6553.5 AND "current_a" BETWEEN 0 AND 655.35
          AND "power_factor" BETWEEN 0 AND 1 AND "temperature_c" BETWEEN -3276.8 AND 3276.7
          AND "rpm" BETWEEN 0 AND 65535),
        CONSTRAINT "ck_motor_sensor_records_time_basis" CHECK ("time_basis" IN ('device_now', 'approximate'))
      )`);
    // "This motor's readings over the last hour" is the only read shape.
    await q.query(`CREATE INDEX "ix_motor_sensor_records_reading_at" ON "motor_sensor_records" ("device_id", "reading_at")`);

    await q.query(`
      CREATE TABLE "motor_upload_log" (
        "id"            bigserial     PRIMARY KEY,
        "device_id"     varchar(64)   NOT NULL,
        "batch_id"      varchar(128)  NOT NULL,
        "first_seq"     bigint        NOT NULL,
        "last_seq"      bigint        NOT NULL,
        "record_count"  integer       NOT NULL,
        "stored_count"  integer       NOT NULL,
        "boot"          bigint,
        "lost_total"    bigint,
        "dropped_total" bigint,
        "device_now"    bigint,
        "received_at"   timestamptz   NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_motor_upload_log_device" ON "motor_upload_log" ("device_id", "received_at" DESC)`);

    await q.query(`
      CREATE TABLE "motor_logger_key" (
        "device_id"  varchar(64) PRIMARY KEY,
        "key_hash"   text        NOT NULL,
        "issued_by"  text        NOT NULL,
        "issued_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_motor_logger_key_hash" CHECK ("key_hash" ~ '^[0-9a-f]{64}$')
      )`);

    // Device-level rows, no tenant: guarded by grants, like the projection mirrors. The
    // log and the readings are append-only from the app's side.
    await q.query(`GRANT SELECT, INSERT ON "motor_sensor_records" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "motor_upload_log" TO "ta_app"`);
    await q.query(`GRANT USAGE ON SEQUENCE "motor_upload_log_id_seq" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "motor_logger_key" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "motor_logger_key"`);
    await q.query(`DROP TABLE IF EXISTS "motor_upload_log"`);
    await q.query(`DROP TABLE IF EXISTS "motor_sensor_records"`);
  }
}
