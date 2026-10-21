import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forecasting with TTM, and the residual that is the anomaly (task QML1; D18 layer 2,
 * D20, D26, D40, D41; answers recorded as D46).
 *
 * - `forecast_model` — the model registry. Platform-owned, no tenant column: each row is
 *   one exact, immutable model version (G13). At most one is `active`, by a partial
 *   unique index rather than a service check, because a service check loses to a
 *   concurrent write. Nothing on a row changes except `status`, and that only from
 *   `active` to `retired`: every forecast names the model that made it, and a row that
 *   could change would rewrite the provenance of every forecast already stored.
 *   A third registry, apart from `llm_provider_config` and the embedding profile (D08).
 *
 *   The seeded row is IBM's granite-timeseries-ttm-r2 at revision d6a79570…, the revision
 *   QML1-SIZE measured. Its model card at that revision declares **Apache-2.0** (commercial
 *   use permitted) and states that IBM "will not be maintaining this code going forward";
 *   both are recorded so nobody has to rediscover them (QML1 §16). Seeding it `active` is
 *   Tapas's recorded approval of 19 Oct 2026 (QML1 §17); any later activation is a staff
 *   action after QEVAL1 has reported on the candidate.
 *
 * - `forecast_run` — the pass ledger D41's triggers are read from. Platform-owned, and it
 *   holds counts and timings only: a pass spans every account, so a row naming machines
 *   would be one account's data readable beside another's. Which machines a pass skipped,
 *   and why, is `forecast_run_skip`, which each account reads under its own policy.
 *
 * - `forecast_input_bucket` — the hourly rollup each pass extends incrementally (QML1 §5),
 *   so a pass reads only the raw readings since its last bucket instead of 21 days of them.
 * - `forecast_latest` — one row per (machine, signal), replaced each pass (D40 §5).
 * - `forecast_residual` — actual minus predicted, per elapsed forecast step (QML1 §8), with
 *   whether the machine was operating in that hour, recorded once so the band never has
 *   to re-read 90 days of engine-running readings to know.
 * - `forecast_daily_sample` — one full forecast per (machine, signal) per UTC day, for
 *   QEVAL1's backtest.
 *
 * Every tenant-owned unique key leads with `tenant_id`: uniqueness is per account, and an
 * index that did not start with it would be one account's rows constraining another's.
 */
export class Forecasting1761100000000 implements MigrationInterface {
  name = 'Forecasting1761100000000';

  private readonly tenantTables = [
    'forecast_run_skip', 'forecast_input_bucket', 'forecast_latest', 'forecast_residual', 'forecast_daily_sample',
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "forecast_model" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" text NOT NULL,
        "revision" text NOT NULL,
        "runtime" text NOT NULL,
        "context_length" int NOT NULL,
        "prediction_length" int NOT NULL,
        "weights_sha256" text NOT NULL,
        "license" text NOT NULL,
        "status" text NOT NULL,
        "approved_by" text NOT NULL,
        "approved_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_forecast_model_revision" UNIQUE ("key", "revision"),
        CONSTRAINT "ck_forecast_model_runtime" CHECK ("runtime" IN ('pytorch-cpu')),
        CONSTRAINT "ck_forecast_model_lengths" CHECK ("context_length" > 0 AND "prediction_length" > 0),
        CONSTRAINT "ck_forecast_model_sha" CHECK ("weights_sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_forecast_model_status" CHECK ("status" IN ('active', 'retired'))
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_forecast_model_one_active" ON "forecast_model" ((true)) WHERE "status" = 'active'`);
    await q.query(`
      CREATE FUNCTION "forecast_model_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'forecast_model %: a model forecasts were made with is never deleted', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
          RAISE EXCEPTION 'forecast_model %: a model version is immutable; only its status changes', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'active' AND NEW."status" = 'retired') THEN
          RAISE EXCEPTION 'forecast_model %: status moves active -> retired only', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_forecast_model_guard" BEFORE UPDATE OR DELETE ON "forecast_model"
        FOR EACH ROW EXECUTE FUNCTION "forecast_model_guard"()`);
    await q.query(`
      INSERT INTO "forecast_model" ("key", "revision", "runtime", "context_length", "prediction_length",
                                    "weights_sha256", "license", "status", "approved_by", "approved_at")
      VALUES ('granite-timeseries-ttm-r2', 'd6a79570cac0f33d526601cd3a0fc7c80a8f9a2f', 'pytorch-cpu', 512, 96,
              'a706726a7eb01bbcb42994b7dcb3c06ea9557898dbae8d480eb04fe8ccb89710', 'apache-2.0', 'active',
              'Tapas (QML1 question 17, recorded as D46)', '2026-10-19T00:00:00Z')`);
    // Read by the pass and the page; written only by migrations and the guarded status move.
    await q.query(`GRANT SELECT ON "forecast_model" TO "ta_app"`);

    await q.query(`
      CREATE TABLE "forecast_run" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz,
        "budget_seconds" int NOT NULL,
        "model_id" uuid REFERENCES "forecast_model" ("id"),
        "outcome" text NOT NULL,
        "considered" int NOT NULL DEFAULT 0,
        "forecast" int NOT NULL DEFAULT 0,
        "skipped" int NOT NULL DEFAULT 0,
        "refused" int NOT NULL DEFAULT 0,
        "python_load_seconds" double precision,
        "python_infer_seconds" double precision,
        "error" text,
        CONSTRAINT "ck_forecast_run_outcome"
          CHECK ("outcome" IN ('running', 'completed', 'budget_exhausted', 'failed', 'lock_held')),
        CONSTRAINT "ck_forecast_run_finished" CHECK (("outcome" = 'running') = ("finished_at" IS NULL)),
        CONSTRAINT "ck_forecast_run_budget" CHECK ("budget_seconds" > 0),
        CONSTRAINT "ck_forecast_run_counts" CHECK ("considered" >= 0 AND "forecast" >= 0 AND "skipped" >= 0 AND "refused" >= 0)
      )`);
    await q.query(`CREATE INDEX "ix_forecast_run_started" ON "forecast_run" ("started_at")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "forecast_run" TO "ta_app"`);

    await q.query(`
      CREATE TABLE "forecast_run_skip" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "run_id" uuid NOT NULL REFERENCES "forecast_run" ("id"),
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "reason" text NOT NULL,
        "detail" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_forecast_run_skip_reason" CHECK ("reason" IN (
          'stale', 'no_readings', 'unbound', 'insufficient_coverage', 'gap_at_edge', 'budget_exhausted', 'refused'))
      )`);
    await q.query(`CREATE INDEX "ix_forecast_run_skip_run" ON "forecast_run_skip" ("tenant_id", "run_id")`);

    await q.query(`
      CREATE TABLE "forecast_input_bucket" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "bucket_at" timestamptz NOT NULL,
        "value" double precision NOT NULL,
        "readings" int NOT NULL,
        CONSTRAINT "ck_forecast_input_bucket_readings" CHECK ("readings" > 0),
        -- On the hour in UTC, whatever the session's time zone: date_trunc on a timestamptz
        -- truncates in the session zone, which is off by half an hour in India.
        CONSTRAINT "ck_forecast_input_bucket_hour" CHECK (extract(epoch FROM "bucket_at")::bigint % 3600 = 0)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_forecast_input_bucket"
        ON "forecast_input_bucket" ("tenant_id", "source_system", "external_id", "signal", "bucket_at")`);

    await q.query(`
      CREATE TABLE "forecast_latest" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "model_id" uuid NOT NULL REFERENCES "forecast_model" ("id"),
        "run_id" uuid NOT NULL REFERENCES "forecast_run" ("id"),
        "generated_at" timestamptz NOT NULL,
        "step_seconds" int NOT NULL,
        "context_from" timestamptz NOT NULL,
        "context_to" timestamptz NOT NULL,
        "input_coverage" double precision NOT NULL,
        "imputed_steps" int NOT NULL,
        "horizon" jsonb NOT NULL,
        CONSTRAINT "ck_forecast_latest_step" CHECK ("step_seconds" > 0),
        CONSTRAINT "ck_forecast_latest_context" CHECK ("context_from" < "context_to"),
        CONSTRAINT "ck_forecast_latest_coverage" CHECK ("input_coverage" > 0 AND "input_coverage" <= 1),
        CONSTRAINT "ck_forecast_latest_imputed" CHECK ("imputed_steps" >= 0),
        CONSTRAINT "ck_forecast_latest_horizon" CHECK (jsonb_typeof("horizon") = 'array' AND jsonb_array_length("horizon") > 0)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_forecast_latest"
        ON "forecast_latest" ("tenant_id", "source_system", "external_id", "signal")`);

    await q.query(`
      CREATE TABLE "forecast_residual" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "model_id" uuid NOT NULL REFERENCES "forecast_model" ("id"),
        "run_id" uuid NOT NULL REFERENCES "forecast_run" ("id"),
        "step_at" timestamptz NOT NULL,
        "lead_steps" int NOT NULL,
        "predicted" double precision NOT NULL,
        "actual" double precision NOT NULL,
        "residual" double precision NOT NULL,
        "operating" boolean,
        CONSTRAINT "ck_forecast_residual_lead" CHECK ("lead_steps" >= 1),
        -- The residual is a definition, not a value someone may write differently.
        CONSTRAINT "ck_forecast_residual_value"
          CHECK (abs("residual" - ("actual" - "predicted")) <= 1e-9 * greatest(1, abs("actual"), abs("predicted")))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_forecast_residual"
        ON "forecast_residual" ("tenant_id", "source_system", "external_id", "signal", "model_id", "step_at")`);

    await q.query(`
      CREATE TABLE "forecast_daily_sample" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "day" date NOT NULL,
        "model_id" uuid NOT NULL REFERENCES "forecast_model" ("id"),
        "run_id" uuid NOT NULL REFERENCES "forecast_run" ("id"),
        "generated_at" timestamptz NOT NULL,
        "step_seconds" int NOT NULL,
        "horizon" jsonb NOT NULL
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_forecast_daily_sample"
        ON "forecast_daily_sample" ("tenant_id", "source_system", "external_id", "signal", "day")`);

    for (const table of this.tenantTables) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    }
    // DELETE only where retention removes rows (90 days, D14's hot window): the rollup,
    // the residuals, the daily samples and old skip records. `forecast_latest` is replaced,
    // never deleted.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "forecast_latest" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, DELETE ON "forecast_run_skip" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "forecast_input_bucket" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, DELETE ON "forecast_residual" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, DELETE ON "forecast_daily_sample" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['forecast_daily_sample', 'forecast_residual', 'forecast_latest', 'forecast_input_bucket', 'forecast_run_skip']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await q.query(`DROP TABLE IF EXISTS "forecast_run"`);
    await q.query(`DROP TABLE IF EXISTS "forecast_model"`);
    await q.query(`DROP FUNCTION IF EXISTS "forecast_model_guard"()`);
  }
}
