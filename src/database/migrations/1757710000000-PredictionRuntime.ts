import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The prediction runtime's store: baselines and a partitioned prediction table
 * (tasks P1-12, P1-13).
 *
 * Two things here are worth more than they cost.
 *
 * The first is partitioning on day one. A prediction table grows with fleet size
 * times active scenarios times scoring frequency, and it is queried almost entirely
 * for recent rows. Retrofitting partitions means rewriting the whole table under an
 * exclusive lock, and that job only gets scheduled after the table is too big to
 * lock — so it never gets scheduled.
 *
 * The second is that creating a partition is a function rather than a piece of SQL
 * somebody writes each month. A hand-created partition works perfectly while missing
 * its row-level security policy, and the result is one month of predictions readable
 * by every tenant, indistinguishable from the other months on every screen. The
 * function creates the partition, enables and forces the policy, and grants the
 * application role its access, as one indivisible act.
 */
export class PredictionRuntime1757710000000 implements MigrationInterface {
  name = 'PredictionRuntime1757710000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "prediction_baseline" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal" text NOT NULL,
        "window_days" int NOT NULL,
        "mean" double precision NOT NULL,
        "stddev" double precision NOT NULL,
        "sample_count" int NOT NULL,
        "coverage_ratio" double precision NOT NULL,
        "first_sample_at" timestamptz NOT NULL,
        "last_sample_at" timestamptz NOT NULL,
        "source" text NOT NULL DEFAULT 'live',
        "computed_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // The refresh upserts on this key, which is what makes recomputing a window
    // idempotent instead of accumulating a new baseline every time it runs.
    await q.query(`
      CREATE UNIQUE INDEX "uq_prediction_baseline"
        ON "prediction_baseline" ("tenant_id", "source_system", "external_id", "signal", "window_days")`);
    await q.query(`
      CREATE INDEX "ix_prediction_baseline_asset"
        ON "prediction_baseline" ("tenant_id", "source_system", "external_id")`);

    await q.query(`
      CREATE TABLE "prediction" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" timestamptz NOT NULL,
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "client_scenario_slug" text NOT NULL,
        "severity" text NOT NULL,
        "risk_score" double precision NOT NULL,
        "abnormal_count" int NOT NULL DEFAULT 0,
        "high_priority" boolean NOT NULL DEFAULT false,
        "confidence" text NOT NULL,
        "signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "window_days" int NOT NULL,
        "model_ref" text NOT NULL DEFAULT 'tier1@1',
        "model_tier" int NOT NULL DEFAULT 1,
        "source" text NOT NULL DEFAULT 'live',
        "computed_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id", "occurred_at")
      ) PARTITION BY RANGE ("occurred_at")`);

    // Scoring the same window twice is one prediction, updated. Postgres requires the
    // partition key in this constraint; the key that makes a re-score idempotent
    // already contains it, so the constraint the database insists on and the one the
    // domain needs are the same constraint.
    await q.query(`
      CREATE UNIQUE INDEX "uq_prediction_idempotent"
        ON "prediction" ("tenant_id", "source_system", "external_id", "client_scenario_slug", "occurred_at")`);

    // Latest-per-(asset, scenario): the query behind every list screen. Descending on
    // time and covering the summary columns, so the common read is answered from the
    // index without touching the row — which matters most on the partitions nobody
    // has in cache.
    await q.query(`
      CREATE INDEX "ix_prediction_latest"
        ON "prediction" ("tenant_id", "source_system", "external_id", "client_scenario_slug", "occurred_at" DESC)
        INCLUDE ("severity", "risk_score", "high_priority", "confidence")`);
    await q.query(`
      CREATE INDEX "ix_prediction_tenant_time" ON "prediction" ("tenant_id", "occurred_at" DESC)`);

    for (const table of ['prediction_baseline', 'prediction']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
    }

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "prediction_baseline" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "prediction" TO "ta_app"`);

    /**
     * Creating a month, safely, exactly once.
     *
     * A policy on the parent governs reads that go through the parent, which is all
     * the application ever does. A partition read directly answers to its own
     * policies, so each one gets the same policy of its own — the cost is three
     * statements at creation, and the alternative is a table that is protected
     * everywhere except the one place somebody looked.
     */
    await q.query(`
      CREATE OR REPLACE FUNCTION ta_ensure_prediction_partition(p_month date)
      RETURNS text
      LANGUAGE plpgsql
      AS $fn$
      DECLARE
        v_start date := date_trunc('month', p_month)::date;
        v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
        v_name  text := 'prediction_' || to_char(v_start, 'YYYY_MM');
      BEGIN
        IF to_regclass('public.' || quote_ident(v_name)) IS NOT NULL THEN
          RETURN v_name;
        END IF;

        EXECUTE format(
          'CREATE TABLE %I PARTITION OF "prediction" FOR VALUES FROM (%L) TO (%L)',
          v_name, v_start, v_end);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);
        EXECUTE format($p$
          CREATE POLICY "tenant_isolation" ON %I
            USING (
              current_setting('ta.bypass', true) = 'on'
              OR "tenant_id" = current_setting('ta.tenant_id', true)
            )
            WITH CHECK (
              current_setting('ta.bypass', true) = 'on'
              OR "tenant_id" = current_setting('ta.tenant_id', true)
            )$p$, v_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO "ta_app"', v_name);

        RETURN v_name;
      END;
      $fn$`);

    /**
     * A catch-all, so an insert never fails for want of a partition.
     *
     * It is a safety net and is meant to stay empty. A row landing here does not just
     * lose the benefit of partitioning: once the default holds a row for August,
     * creating the August partition fails, because attaching it would have to move
     * that row. So the default silently converts a missed maintenance run into a
     * table that cannot be repaired without downtime — which is why a test asserts it
     * is empty rather than trusting the schedule.
     */
    await q.query(`CREATE TABLE "prediction_default" PARTITION OF "prediction" DEFAULT`);
    await q.query(`ALTER TABLE "prediction_default" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "prediction_default" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "prediction_default"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "prediction_default" TO "ta_app"`);

    // Two months behind and three ahead. Behind, because a backfill or a logger
    // reconnecting with a week of buffered readings arrives dated in the past.
    await q.query(`
      DO $$
      DECLARE m int;
      BEGIN
        FOR m IN -2..3 LOOP
          PERFORM ta_ensure_prediction_partition((date_trunc('month', now()) + (m || ' month')::interval)::date);
        END LOOP;
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS ta_ensure_prediction_partition(date)`);
    // Dropping the parent takes every partition with it; naming them individually
    // would miss the ones created after this migration ran, which is all of them.
    await q.query(`DROP TABLE IF EXISTS "prediction" CASCADE`);
    await q.query(`DROP TABLE IF EXISTS "prediction_baseline" CASCADE`);
  }
}
