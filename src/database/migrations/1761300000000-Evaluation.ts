import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The evaluation run namespace (task QEVAL1a; G10, D26, D28).
 *
 * - `eval_run` — one row per evaluation, of any of the three kinds QEVAL1 names, so the
 *   retrieval and replay parts add code, not an enum migration. Platform-owned, like
 *   `forecast_run`: it holds what was evaluated (the exact versions), the window, the
 *   dataset and the aggregate summary, and never a machine identifier — an aggregate
 *   that named a machine would be one account's data readable beside another's (Q7).
 * - `eval_result` — the per-machine numbers, tenant-owned under the same forced policy
 *   as every other tenant table, so an account reads its own results and nobody else's.
 *
 * Evidence, not working state. Once a run has finished, neither it nor any result under
 * it changes: a trigger refuses it for every role, because a grant is one `GRANT ALL`
 * away from not saying so, and an eval number that can be edited afterwards is not
 * evidence of anything. Results are append-only from the start, and a result cannot be
 * added to a run that has already finished.
 *
 * `ta_eval` is the role an evaluation runs as, and it is where G10 is enforced: it may
 * read what an evaluation reads and write the two tables above, and nothing else. An
 * eval that reached `forecast_latest`, raised an alert, opened a work order or moved a
 * model's status through shared code would be refused by the database, not by a code
 * review that missed the call. A later part grants it what that part reads, in its own
 * migration. Created only IF NOT EXISTS and never dropped, for the reason
 * `ScopeAndRls1757670000000` gives: a role is cluster-wide and a migration is not.
 */
export class Evaluation1761300000000 implements MigrationInterface {
  name = 'Evaluation1761300000000';

  /** What the TTM backtest reads, and the readers it calls (the band's dirty ranges). */
  private readonly evalReads = [
    'forecast_model', 'forecast_daily_sample', 'forecast_input_bucket', 'forecast_residual',
    'equipment_profile', 'equipment_class_sensor_requirement', 'alert_event', 'alert_rule', 'work_order',
    'telemetry_reading',
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ta_eval') THEN
          CREATE ROLE "ta_eval" NOLOGIN NOBYPASSRLS;
        END IF;
        -- SET ROLE is checked against the login user, not the role a session is in.
        BEGIN
          EXECUTE format('GRANT "ta_eval" TO %I', current_user);
        EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
          NULL;
        END;
      END
      $$`);

    await q.query(`
      CREATE TABLE "eval_run" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kind" text NOT NULL,
        "status" text NOT NULL,
        "dataset" text NOT NULL,
        "dataset_note" text,
        "versions" jsonb NOT NULL,
        "window_from" timestamptz NOT NULL,
        "window_to" timestamptz NOT NULL,
        "budget_seconds" int NOT NULL,
        "budget_series" int NOT NULL,
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz,
        "unreached" int NOT NULL DEFAULT 0,
        "summary" jsonb,
        "error" text,
        CONSTRAINT "ck_eval_run_kind" CHECK ("kind" IN ('ttm_backtest', 'retrieval', 'recommendation_replay')),
        CONSTRAINT "ck_eval_run_status"
          CHECK ("status" IN ('running', 'completed', 'budget_exhausted', 'failed', 'lock_held')),
        -- Seeded telemetry measures the seeder (§5). Which one a run used is not optional.
        CONSTRAINT "ck_eval_run_dataset" CHECK ("dataset" IN ('seeded', 'real')),
        CONSTRAINT "ck_eval_run_finished" CHECK (("status" = 'running') = ("finished_at" IS NULL)),
        CONSTRAINT "ck_eval_run_window" CHECK ("window_from" < "window_to"),
        CONSTRAINT "ck_eval_run_budget" CHECK ("budget_seconds" > 0 AND "budget_series" > 0 AND "unreached" >= 0)
      )`);
    await q.query(`CREATE INDEX "ix_eval_run_kind_started" ON "eval_run" ("kind", "started_at")`);
    await q.query(`
      CREATE FUNCTION "eval_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'eval_run %: an evaluation run is evidence and is never deleted', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."status" <> 'running' THEN
          RAISE EXCEPTION 'eval_run %: a finished run is immutable', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."dataset" IS DISTINCT FROM OLD."dataset"
           OR NEW."versions" IS DISTINCT FROM OLD."versions" OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
           OR NEW."window_from" IS DISTINCT FROM OLD."window_from" OR NEW."window_to" IS DISTINCT FROM OLD."window_to" THEN
          RAISE EXCEPTION 'eval_run %: what a run evaluates is fixed when it starts', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_eval_run_guard" BEFORE UPDATE OR DELETE ON "eval_run"
        FOR EACH ROW EXECUTE FUNCTION "eval_run_guard"()`);

    await q.query(`
      CREATE TABLE "eval_result" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "run_id" uuid NOT NULL REFERENCES "eval_run" ("id"),
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "subject" text NOT NULL,
        "variant" text NOT NULL,
        "metrics" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_eval_result_metrics" CHECK (jsonb_typeof("metrics") = 'object')
      )`);
    // Led by the tenant, as every tenant-owned key is. Written once per run: a second
    // write of the same result is a defect, and the index makes it an error.
    await q.query(`
      CREATE UNIQUE INDEX "uq_eval_result"
        ON "eval_result" ("tenant_id", "run_id", "source_system", "external_id", "subject", "variant")`);
    await q.query(`
      CREATE FUNCTION "eval_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        run_status text;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION 'eval_result %: an evaluation result is never changed or removed', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT "status" INTO run_status FROM "eval_run" WHERE "id" = NEW."run_id";
        IF run_status IS DISTINCT FROM 'running' THEN
          RAISE EXCEPTION 'eval_result: run % is %, and a finished run takes no more results', NEW."run_id", run_status
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_eval_result_guard" BEFORE INSERT OR UPDATE OR DELETE ON "eval_result"
        FOR EACH ROW EXECUTE FUNCTION "eval_result_guard"()`);
    await q.query(`ALTER TABLE "eval_result" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "eval_result" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "eval_result"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);

    await q.query(`GRANT USAGE ON SCHEMA public TO "ta_eval"`);
    for (const table of this.evalReads) await q.query(`GRANT SELECT ON "${table}" TO "ta_eval"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "eval_run" TO "ta_eval"`);
    await q.query(`GRANT SELECT, INSERT ON "eval_result" TO "ta_eval"`);
    // An account's own results, for the day there is a read path (Q6). No write.
    await q.query(`GRANT SELECT ON "eval_result" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "eval_result"`);
    await q.query(`DROP TABLE IF EXISTS "eval_run"`);
    await q.query(`DROP FUNCTION IF EXISTS "eval_result_guard"()`);
    await q.query(`DROP FUNCTION IF EXISTS "eval_run_guard"()`);
    // This database's grants to the role, and not the role: it is cluster-wide.
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ta_eval') THEN
          EXECUTE 'DROP OWNED BY "ta_eval"';
        END IF;
      END
      $$`);
  }
}
