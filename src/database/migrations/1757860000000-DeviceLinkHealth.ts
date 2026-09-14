import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Why a window was thin, not just how thin (task P4-08).
 *
 * `utilization_shift.coverage` says how much of a shift nobody saw. Four different
 * faults produce the same number there and want four different people: a logger
 * holding a backlog that is coming, a link dropping readings that are gone, a device
 * that is off the air, and a device that is fine with dead sensors on it. A platform
 * that reports the percentage and stops has handed the diagnosis back to the customer.
 *
 * Keyed on the device rather than the machine, because the fault belongs to the
 * logger: it takes its weak antenna with it when it is refitted, and one machine can
 * carry two loggers with different problems.
 */
export class DeviceLinkHealth1757860000000 implements MigrationInterface {
  name = 'DeviceLinkHealth1757860000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "device_link_health" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "imei" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "plant_id" uuid,
        "local_date" text NOT NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "state" text NOT NULL,
        "detail" text NOT NULL,
        "signal_scale" text,
        "signal_median" double precision,
        "signal_worst" double precision,
        "signal_band" text,
        "signal_worst_band" text,
        "longest_gap_seconds" double precision,
        "median_lag_seconds" double precision,
        "max_lag_seconds" double precision,
        "reported_signals" text[] NOT NULL DEFAULT '{}'::text[],
        "missing_signals" text[] NOT NULL DEFAULT '{}'::text[],
        "samples" int NOT NULL DEFAULT 0,
        "computed_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // The upsert target: one verdict per device per window.
    await q.query(`
      CREATE UNIQUE INDEX "uq_device_link_health_window"
        ON "device_link_health" ("tenant_id", "imei", "window_start")`);
    await q.query(`
      CREATE INDEX "ix_device_link_health_asset"
        ON "device_link_health" ("tenant_id", "external_id", "window_start")`);
    // "Show me everything dark" is the screen this table exists for.
    await q.query(`
      CREATE INDEX "ix_device_link_health_state"
        ON "device_link_health" ("tenant_id", "state", "window_start")`);

    await q.query(`
      ALTER TABLE "device_link_health" ADD CONSTRAINT "ck_device_link_health_state"
        CHECK ("state" IN (
          'dark', 'partial', 'intermittent', 'buffering', 'weak-signal', 'healthy', 'unknown'
        ))`);
    // Null is "could not tell"; a value outside the vocabulary is a bug getting stored.
    await q.query(`
      ALTER TABLE "device_link_health" ADD CONSTRAINT "ck_device_link_health_scale"
        CHECK ("signal_scale" IS NULL OR "signal_scale" IN ('dbm', 'csq', 'percent'))`);
    await q.query(`
      ALTER TABLE "device_link_health" ADD CONSTRAINT "ck_device_link_health_band"
        CHECK (
          ("signal_band" IS NULL OR "signal_band" IN ('excellent', 'good', 'fair', 'poor'))
          AND ("signal_worst_band" IS NULL
               OR "signal_worst_band" IN ('excellent', 'good', 'fair', 'poor'))
        )`);
    // A band without a scale is a verdict nobody can interpret: -95 is fair on dBm and
    // poor on CSQ, and the band alone does not say which question it answered.
    await q.query(`
      ALTER TABLE "device_link_health" ADD CONSTRAINT "ck_device_link_health_band_needs_scale"
        CHECK ("signal_band" IS NULL OR "signal_scale" IS NOT NULL)`);

    await q.query(`ALTER TABLE "device_link_health" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "device_link_health" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "device_link_health"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    await q.query(`GRANT SELECT, INSERT, UPDATE ON "device_link_health" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "device_link_health"`);
  }
}
