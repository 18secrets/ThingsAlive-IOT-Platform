import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The in-shift fuel nowcast (D52): while a shift runs, its total as of a quarter hour —
 * litres burned so far, read off the existing platform's fuel counter, plus the pre-shift
 * forecast's share of the hours left.
 *
 * One table of snapshots, appended to and never rewritten. A snapshot is worth something
 * only as what was known at its `as_of`; scoring them against the shift's actual total, at
 * two, four and six hours in, is the point of keeping them, and a snapshot "corrected"
 * after the shift ended would score as well as it liked. So the app role can insert and
 * read and nothing else, and a trigger refuses an UPDATE from every role — the owner
 * included, because a hand-run fix as the owner is exactly how yesterday's figure gets
 * made to match what happened (D50's reasoning for its forecasts, held more strictly
 * here: a forecast may still be corrected before its shift starts, a snapshot never is).
 * DELETE is left to the owner and the cascade, so a machine deleted takes its snapshots.
 *
 * The rest is what makes a row one snapshot of one running shift. It lies inside its
 * shift, strictly — at the start nothing has burned, at the end it is no longer a forecast.
 * The counter it read was read inside the shift and not after the snapshot's own instant.
 * And the prediction sits between what had burned and that plus the whole base: the share
 * of the base is never negative and never more than all of it. The shift boundaries are
 * D50's generated `starts_at` and `ends_at`, the same expression, so the two tables
 * cannot disagree about when a shift is.
 */
export class ShiftFuelNowcast1763100000000 implements MigrationInterface {
  name = 'ShiftFuelNowcast1763100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "shift_fuel_nowcast" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "sdate" date NOT NULL,
        "shift" smallint NOT NULL,
        -- The instant the snapshot describes: a whole tick, so a second pass in the same
        -- quarter hour lands on the same key and writes nothing.
        "as_of" timestamptz NOT NULL,
        -- When the device took the newest counter reading used. Far behind as_of is a
        -- stale feed; kept beside the figure so whoever reads it can see that.
        "counter_at" timestamptz NOT NULL,
        "so_far_l" numeric(12,2) NOT NULL,
        "base_l" numeric(12,2) NOT NULL,
        -- 'issued': the shift's own forecast from shift_fuel_forecast. 'computed': none had
        -- been issued yet, so the same arithmetic was run on the same history.
        "base_source" text NOT NULL,
        "predicted_l" numeric(12,2) NOT NULL,
        "method" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "starts_at" timestamptz GENERATED ALWAYS AS (
          ("sdate" + CASE WHEN "shift" = 1 THEN interval '8 hours' ELSE interval '20 hours' END) AT TIME ZONE 'Asia/Kolkata'
        ) STORED,
        "ends_at" timestamptz GENERATED ALWAYS AS (
          ("sdate" + CASE WHEN "shift" = 1 THEN interval '20 hours' ELSE interval '32 hours' END) AT TIME ZONE 'Asia/Kolkata'
        ) STORED,
        CONSTRAINT "ck_shift_fuel_nowcast_shift" CHECK ("shift" IN (1, 2)),
        CONSTRAINT "ck_shift_fuel_nowcast_litres" CHECK ("so_far_l" >= 0 AND "base_l" >= 0),
        CONSTRAINT "ck_shift_fuel_nowcast_predicted"
          CHECK ("predicted_l" >= "so_far_l" AND "predicted_l" <= "so_far_l" + "base_l"),
        CONSTRAINT "ck_shift_fuel_nowcast_method" CHECK (length(btrim("method")) > 0),
        CONSTRAINT "ck_shift_fuel_nowcast_base_source" CHECK ("base_source" IN ('issued', 'computed')),
        CONSTRAINT "ck_shift_fuel_nowcast_in_shift" CHECK ("as_of" > "starts_at" AND "as_of" < "ends_at"),
        -- A counter read before the shift started, or after the instant the snapshot
        -- claims to describe, is a snapshot of something else.
        CONSTRAINT "ck_shift_fuel_nowcast_counter" CHECK ("counter_at" >= "starts_at" AND "counter_at" <= "as_of"),
        CONSTRAINT "fk_shift_fuel_nowcast_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE
      )`);
    // Method in the key, as in shift_fuel_forecast: a second way of nowcasting the same
    // shift sits beside the first and is scored against it rather than replacing it.
    await q.query(`
      CREATE UNIQUE INDEX "uq_shift_fuel_nowcast_snapshot"
        ON "shift_fuel_nowcast" ("tenant_id", "source_system", "external_id", "sdate", "shift", "method", "as_of")`);
    await q.query(`CREATE INDEX "ix_shift_fuel_nowcast_shift" ON "shift_fuel_nowcast" ("tenant_id", "method", "sdate", "shift")`);

    await q.query(`
      CREATE FUNCTION "shift_fuel_nowcast_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'shift_fuel_nowcast %: a snapshot is what was known at its as_of, so it is never rewritten', OLD."id"
          USING ERRCODE = 'check_violation';
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_shift_fuel_nowcast_append_only" BEFORE UPDATE ON "shift_fuel_nowcast"
        FOR EACH ROW EXECUTE FUNCTION "shift_fuel_nowcast_append_only"()`);

    await q.query(`ALTER TABLE "shift_fuel_nowcast" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "shift_fuel_nowcast" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "shift_fuel_nowcast"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT ON "shift_fuel_nowcast" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shift_fuel_nowcast"`);
    await q.query(`DROP FUNCTION IF EXISTS "shift_fuel_nowcast_append_only"()`);
  }
}
