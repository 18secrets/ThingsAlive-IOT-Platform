import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a categorical signal's codes mean (task QCAT1).
 *
 * `telemetry_reading.value` stays numeric — a state arrives as its code, so the
 * biggest, partitioned table and every ingestion path are untouched. This table is
 * the other half: for `utilization_status`, 0 is `off`, 1 is `idle`, 2 is `working`.
 *
 * Platform reference data, the same shape as `sensor_role_capability`: no tenant_id,
 * because a code means the same thing on every machine that reports it. Published
 * formulas carry the code itself (resolved at publish), so editing this table later
 * cannot change what an already-published KPI measures.
 */
export class SignalStates1758510000000 implements MigrationInterface {
  name = 'SignalStates1758510000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "signal_state" (
        "measurement_role" text NOT NULL,
        "state" text NOT NULL,
        "code" int NOT NULL,
        "updated_by" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_signal_state" PRIMARY KEY ("measurement_role", "state"),
        -- One meaning per code. Two states on one code would make every reading of it
        -- ambiguous, and the fraction-in-state of each would silently double count.
        CONSTRAINT "uq_signal_state_code" UNIQUE ("measurement_role", "code"),
        -- The spelling a formula's quoted literal accepts, so every stored state is
        -- one a formula can name.
        CONSTRAINT "ck_signal_state_name" CHECK ("state" ~ '^[a-z][a-z0-9_]*$'),
        CONSTRAINT "ck_signal_state_code" CHECK ("code" >= 0)
      )`);
    await q.query(`GRANT SELECT ON "signal_state" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "signal_state"`);
  }
}
