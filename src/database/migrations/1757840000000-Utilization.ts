import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Duty cycle per shift (task P4-05).
 *
 * The first thing the platform answers that is not a prediction, and the one a
 * customer can check against their own foreman's account of the day — which is why
 * the unobserved time has a column of its own. A utilization report that quietly
 * counts an outage as "off" is a report that turns every connectivity problem into an
 * accusation about an operator.
 *
 * Unique on the window, and upserted, because this is a measurement of a fixed
 * interval rather than an opinion formed at a moment: re-scoring a window with late
 * telemetry replaces the thin answer instead of filing a second, contradictory one.
 */
export class Utilization1757840000000 implements MigrationInterface {
  name = 'Utilization1757840000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "utilization_shift" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "shift_id" uuid NOT NULL,
        "shift_name" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "plant_id" uuid,
        "equipment_class_slug" text,
        "local_date" text NOT NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "total_seconds" double precision NOT NULL,
        "productive_seconds" double precision NOT NULL,
        "idle_seconds" double precision NOT NULL,
        "running_unclassified_seconds" double precision NOT NULL,
        "off_seconds" double precision NOT NULL,
        "unknown_seconds" double precision NOT NULL,
        "engine_on_seconds" double precision NOT NULL,
        "carry_seconds" double precision NOT NULL,
        "coverage" double precision NOT NULL,
        "utilization_rate" double precision,
        "productive_rate" double precision,
        "idle_rate" double precision,
        "runtime_delta" double precision,
        "runtime_unit" text,
        "runtime_counter_reset" boolean NOT NULL DEFAULT false,
        "samples" int NOT NULL DEFAULT 0,
        "signals_present" text[] NOT NULL DEFAULT '{}'::text[],
        "computed_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // The upsert target. One measurement per window, whatever happens to the window.
    //
    // The asset is in the key as well as the shift. On today's schema a shift belongs
    // to one machine and the two columns are redundant — but if a shift id ever
    // reached two machines the narrower key would not reject the second row, it would
    // overwrite the first, and one machine's hours would become another's silently.
    await q.query(`
      CREATE UNIQUE INDEX "uq_utilization_shift_window"
        ON "utilization_shift" (
          "tenant_id", "source_system", "external_id", "shift_id", "window_start"
        )`);
    // "This machine over the last month" and "this site over the last month".
    await q.query(`
      CREATE INDEX "ix_utilization_shift_asset"
        ON "utilization_shift" ("tenant_id", "source_system", "external_id", "window_start")`);
    await q.query(`
      CREATE INDEX "ix_utilization_shift_plant"
        ON "utilization_shift" ("tenant_id", "plant_id", "window_start")`);

    // The buckets partition the window. A row where they do not is arithmetic that
    // went wrong somewhere upstream, and the database is the last place to catch it
    // before somebody adds the columns up on a screen and gets a different total.
    // A tenth of a second of slack for the rounding, no more.
    await q.query(`
      ALTER TABLE "utilization_shift" ADD CONSTRAINT "ck_utilization_shift_partition"
        CHECK (abs(
          "productive_seconds" + "idle_seconds" + "running_unclassified_seconds"
          + "off_seconds" + "unknown_seconds" - "total_seconds"
        ) < 0.1)`);
    await q.query(`
      ALTER TABLE "utilization_shift" ADD CONSTRAINT "ck_utilization_shift_coverage"
        CHECK ("coverage" >= 0 AND "coverage" <= 1)`);

    await q.query(`ALTER TABLE "utilization_shift" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "utilization_shift" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "utilization_shift"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    // UPDATE as well as INSERT: the upsert rewrites a window when late telemetry
    // arrives. Nothing deletes — a window that was measured stays measured.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "utilization_shift" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "utilization_shift"`);
  }
}
