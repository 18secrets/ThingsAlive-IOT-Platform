import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fuel per machine per shift, forecast from the existing platform's own shift totals
 * (D50).
 *
 * Two tables. `legacy_shift_metric` is a copy of the rows 2.0 reads from the existing
 * platform's `equipment_shift_metrics` — litres and working hours per machine per shift —
 * placed under the account that owns the machine. `shift_fuel_forecast` is what 2.0
 * predicted for a shift before it had happened.
 *
 * The copy is revised rather than appended. The existing platform rewrites a shift's row
 * when late data arrives, so the same (machine, date, shift) comes back with a different
 * figure, and the unique key makes the second read an update of the first rather than a
 * second answer to the same question.
 *
 * A forecast is the opposite: it is only worth anything if it was made before the answer
 * was known, so the database holds the three rules that make one scorable. It saw nothing
 * from its own day (`inputs_through` < `sdate`); it was issued before its shift ended; and
 * once its shift has started it is never rewritten. The last is a trigger rather than a
 * grant alone because the app role is not the only thing that can reach this table — a
 * hand-run fix as the owner is exactly when somebody "corrects" yesterday's forecast to
 * match what happened.
 *
 * Shift boundaries are the existing platform's — 08:00 and 20:00 in Asia/Kolkata, its
 * SHIFT_1_IN and SHIFT_2_IN — and appear here once, as the generated `starts_at` and
 * `ends_at`, so the trigger and the API read the same instants. The same constants live in
 * `src/shift-fuel/shift-fuel-forecast.ts`, and the spec holds the two together.
 */
export class ShiftFuelForecast1763000000000 implements MigrationInterface {
  name = 'ShiftFuelForecast1763000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "legacy_shift_metric" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "sdate" date NOT NULL,
        "shift" smallint NOT NULL,
        -- Nullable, as they are upstream: a shift the existing platform has a row for but
        -- no figure is not a shift that burned nothing, and a zero here would say it was.
        "fuel_l" numeric(12,2),
        "work_hrs" numeric(10,2),
        "legacy_updated_at" timestamptz,
        "synced_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_legacy_shift_metric_shift" CHECK ("shift" IN (1, 2)),
        CONSTRAINT "ck_legacy_shift_metric_fuel" CHECK ("fuel_l" IS NULL OR "fuel_l" >= 0),
        CONSTRAINT "ck_legacy_shift_metric_work_hrs" CHECK ("work_hrs" IS NULL OR "work_hrs" >= 0),
        CONSTRAINT "fk_legacy_shift_metric_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_legacy_shift_metric_shift"
        ON "legacy_shift_metric" ("tenant_id", "source_system", "external_id", "sdate", "shift")`);

    await q.query(`
      CREATE TABLE "shift_fuel_forecast" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "sdate" date NOT NULL,
        "shift" smallint NOT NULL,
        "predicted_l" numeric(12,2) NOT NULL,
        "method" text NOT NULL,
        -- The newest day the arithmetic used; null when the machine had no history for
        -- this shift and the forecast is the zero that says so.
        "inputs_through" date,
        "issued_at" timestamptz NOT NULL DEFAULT now(),
        "starts_at" timestamptz GENERATED ALWAYS AS (
          ("sdate" + CASE WHEN "shift" = 1 THEN interval '8 hours' ELSE interval '20 hours' END) AT TIME ZONE 'Asia/Kolkata'
        ) STORED,
        "ends_at" timestamptz GENERATED ALWAYS AS (
          ("sdate" + CASE WHEN "shift" = 1 THEN interval '20 hours' ELSE interval '32 hours' END) AT TIME ZONE 'Asia/Kolkata'
        ) STORED,
        CONSTRAINT "ck_shift_fuel_forecast_shift" CHECK ("shift" IN (1, 2)),
        CONSTRAINT "ck_shift_fuel_forecast_predicted" CHECK ("predicted_l" >= 0),
        CONSTRAINT "ck_shift_fuel_forecast_method" CHECK (length(btrim("method")) > 0),
        -- Nothing from the target's own day. A forecast that had seen the shift it
        -- forecasts would score perfectly and mean nothing.
        CONSTRAINT "ck_shift_fuel_forecast_inputs" CHECK ("inputs_through" IS NULL OR "inputs_through" < "sdate"),
        -- Issued while the shift could still surprise it. The existing platform totals a
        -- shift only after it ends, so this is the latest moment a forecast is still one.
        CONSTRAINT "ck_shift_fuel_forecast_in_time" CHECK ("issued_at" < "ends_at"),
        CONSTRAINT "fk_shift_fuel_forecast_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE
      )`);
    // Method in the key, so a second way of forecasting the same shift sits beside the
    // first and the two can be scored against each other rather than one replacing it.
    await q.query(`
      CREATE UNIQUE INDEX "uq_shift_fuel_forecast_target"
        ON "shift_fuel_forecast" ("tenant_id", "source_system", "external_id", "sdate", "shift", "method")`);
    await q.query(`CREATE INDEX "ix_shift_fuel_forecast_recent" ON "shift_fuel_forecast" ("tenant_id", "method", "sdate")`);

    await q.query(`
      CREATE FUNCTION "shift_fuel_forecast_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."starts_at" <= now() THEN
          RAISE EXCEPTION 'shift_fuel_forecast %: shift % of % has started, so its forecast is final', OLD."id", OLD."shift", OLD."sdate"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_shift_fuel_forecast_frozen" BEFORE UPDATE ON "shift_fuel_forecast"
        FOR EACH ROW EXECUTE FUNCTION "shift_fuel_forecast_frozen"()`);

    for (const table of ['legacy_shift_metric', 'shift_fuel_forecast']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    }
    // UPDATE because the existing platform revises a shift after the fact. No DELETE: a
    // row goes when its machine does, by the cascade, and never because a read came back
    // without it — a missing row upstream is more often a grant or a timeout than a
    // shift that did not happen.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "legacy_shift_metric" TO "ta_app"`);
    // Insert only. The service never rewrites a forecast, so the app role cannot either;
    // the trigger above is for every other role.
    await q.query(`GRANT SELECT, INSERT ON "shift_fuel_forecast" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shift_fuel_forecast"`);
    await q.query(`DROP FUNCTION IF EXISTS "shift_fuel_forecast_frozen"()`);
    await q.query(`DROP TABLE IF EXISTS "legacy_shift_metric"`);
  }
}
