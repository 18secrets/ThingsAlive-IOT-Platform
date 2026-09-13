import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the runner did, kept where a screen can read it (task P1-115).
 *
 * A scheduled job whose only record is its own log output is a job nobody can ask
 * questions of. "Why has this machine not been scored since Tuesday" is the first
 * question anybody asks, and the answer should not depend on who has access to a log
 * aggregator.
 *
 * Tenant-owned, because the answer belongs to the customer whose machine it is. The
 * runner writes it inside that account's own session even though the runner itself
 * has no request behind it.
 */
export class ShiftRunLedger1757820000000 implements MigrationInterface {
  name = 'ShiftRunLedger1757820000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "shift_run" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "shift_id" uuid NOT NULL,
        "shift_name" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "local_date" text NOT NULL,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "status" text NOT NULL,
        "detail" text,
        "readings" int NOT NULL DEFAULT 0,
        "predictions" int NOT NULL DEFAULT 0,
        "jobs_raised" int NOT NULL DEFAULT 0,
        "alerts_fired" int NOT NULL DEFAULT 0,
        "duration_ms" int,
        "ran_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // "What has happened to this machine lately" and "what has this shift been doing".
    await q.query(`
      CREATE INDEX "ix_shift_run_asset"
        ON "shift_run" ("tenant_id", "source_system", "external_id", "ran_at")`);
    await q.query(`
      CREATE INDEX "ix_shift_run_shift" ON "shift_run" ("tenant_id", "shift_id", "ran_at")`);
    await q.query(`
      ALTER TABLE "shift_run" ADD CONSTRAINT "ck_shift_run_status"
        CHECK ("status" IN ('scored', 'nothing-to-score', 'not-running', 'failed'))`);

    await q.query(`ALTER TABLE "shift_run" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "shift_run" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "shift_run"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    // A record of what happened. Written once and read; never amended.
    await q.query(`GRANT SELECT, INSERT ON "shift_run" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shift_run"`);
  }
}
