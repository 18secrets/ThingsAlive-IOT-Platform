import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Breakdown events and the two OEE parameters (task QOEE1).
 *
 * `breakdown_event` is derived: the detector writes it from telemetry and nothing else
 * may. Replaying the detector over unchanged telemetry must produce the same rows, so a
 * row is keyed by where it started, and a second write of the same start is a no-op.
 * The only change a row ever takes is an open event closing — `ended_at` and
 * `duration_minutes` going from NULL to a value. Everything else, the threshold in
 * particular, is fixed once written: a client who changes the threshold tomorrow must
 * not silently rewrite last month's history. A trigger enforces that rather than the
 * grant alone, because the owner and a managed Postgres's superuser bypass grants.
 *
 * The parameters join QPARAM1's value check with their own rules: a nominal above 0,
 * a threshold a whole number of minutes, at least 5 — the same floor the library class
 * holds (`ck_class_idle_breakdown_threshold`). The other arms are copied unchanged from
 * `1759400000000-ShieldEvidence.ts`.
 */
export class Oee1759900000000 implements MigrationInterface {
  name = 'Oee1759900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "breakdown_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "started_at" timestamptz NOT NULL,
        "ended_at" timestamptz,
        "duration_minutes" integer,
        "shift_id" uuid,
        "threshold_minutes" integer NOT NULL,
        "detected_from" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        -- Open is both NULL, closed is both set; never one without the other.
        CONSTRAINT "ck_breakdown_event_open"
          CHECK (("ended_at" IS NULL) = ("duration_minutes" IS NULL)),
        CONSTRAINT "ck_breakdown_event_order"
          CHECK ("ended_at" IS NULL OR "ended_at" > "started_at"),
        -- A closed event shorter than its own threshold was never a breakdown.
        CONSTRAINT "ck_breakdown_event_duration"
          CHECK ("duration_minutes" IS NULL OR "duration_minutes" >= "threshold_minutes"),
        CONSTRAINT "ck_breakdown_event_threshold"
          CHECK ("threshold_minutes" >= 5)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_breakdown_event_start"
        ON "breakdown_event" ("tenant_id", "source_system", "external_id", "started_at")`);

    await q.query(`
      CREATE FUNCTION "breakdown_event_close_only"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'breakdown_event rows are derived and kept: they are never deleted (breakdown_event_close_only)';
        END IF;
        IF OLD."ended_at" IS NOT NULL
           OR NEW."ended_at" IS NULL
           OR (NEW."tenant_id", NEW."source_system", NEW."external_id", NEW."started_at",
               NEW."shift_id", NEW."threshold_minutes", NEW."detected_from")
              IS DISTINCT FROM
              (OLD."tenant_id", OLD."source_system", OLD."external_id", OLD."started_at",
               OLD."shift_id", OLD."threshold_minutes", OLD."detected_from") THEN
          RAISE EXCEPTION 'breakdown_event rows only ever close: an open event may take ended_at and duration_minutes, nothing else changes (breakdown_event_close_only)';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_breakdown_event_close_only"
        BEFORE UPDATE OR DELETE ON "breakdown_event"
        FOR EACH ROW EXECUTE FUNCTION "breakdown_event_close_only"()`);

    await q.query(`ALTER TABLE "breakdown_event" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "breakdown_event" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "breakdown_event"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "breakdown_event" TO "ta_app"`);

    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`
      ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value"
        CHECK (CASE
          WHEN jsonb_typeof("value") = 'null' THEN true
          WHEN "name" = 'currency' THEN
            jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
          WHEN jsonb_typeof("value") <> 'number' THEN false
          WHEN "name" IN ('stale_after_seconds', 'shield_due_soon_days') THEN
            ("value" #>> '{}')::numeric > 0
            AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
          WHEN "name" = 'nominal_fuel_per_hour' THEN
            ("value" #>> '{}')::numeric > 0
          WHEN "name" = 'idle_breakdown_threshold_minutes' THEN
            ("value" #>> '{}')::numeric >= 5
            AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
          ELSE true
        END)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`
      ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value"
        CHECK (CASE
          WHEN jsonb_typeof("value") = 'null' THEN true
          WHEN "name" = 'currency' THEN
            jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
          WHEN jsonb_typeof("value") <> 'number' THEN false
          WHEN "name" IN ('stale_after_seconds', 'shield_due_soon_days') THEN
            ("value" #>> '{}')::numeric > 0
            AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
          ELSE true
        END)`);
    await q.query(`DROP TABLE IF EXISTS "breakdown_event"`);
    await q.query(`DROP FUNCTION IF EXISTS "breakdown_event_close_only"()`);
  }
}
