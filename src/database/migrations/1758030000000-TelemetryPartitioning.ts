import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monthly range partitioning for `telemetry_reading` (task QPART1, decision D13).
 *
 * The replay gate scans 90 days of readings for one machine per candidate rule, and
 * the machine page reads a bounded window per widget, many widgets per page. Against
 * one unpartitioned table both are full scans that only get slower as the table
 * grows; a partitioned table prunes to the months a query actually asks for. It is
 * also what makes retention possible at all — QARCH1 drops a month with `DROP TABLE`
 * rather than a `DELETE` that leaves bloat behind. Nothing here drops anything yet.
 *
 * Measured against the deployed Development database before writing any of this:
 * `telemetry_reading` holds 0 rows. Path A (copy) applies — the row-count guard
 * below is the same guard a populated table would need, just not the one currently
 * exercised there.
 *
 * The primary key changes from `(id)` to `(id, source_timestamp)`: Postgres requires
 * a partitioned table's primary key and every unique index to include the partition
 * key. `uq_telemetry_reading_dedupe` already carries `source_timestamp`, so it
 * survives unchanged and stays a *global* dedupe guarantee rather than a per-month
 * one — a given `(imei, signal, source_timestamp)` tuple can only ever route to one
 * partition, because the value that decides the partition is also the value the
 * constraint compares. `test/telemetry-partitioning.spec.ts` proves this rather than
 * assuming it.
 *
 * No DEFAULT partition. `prediction` (`1757710000000-PredictionRuntime`) has one, as
 * a safety net; this deliberately does not. A default silently accumulates rows that
 * belong to a real month and then blocks attaching that month's partition later,
 * turning a missed maintenance run into a repair that needs downtime. An insert with
 * no matching partition should fail loudly, today, rather than quietly months later —
 * see `ensure_telemetry_partition` and the daily maintenance task in
 * `TelemetryPartitionMaintenance` that keeps partitions ahead of the data.
 *
 * RLS is the part that is easy to get wrong: a policy on the partitioned parent
 * governs reads that go *through* the parent, which is all the application ever
 * does — but a query against a partition directly answers to that partition's own
 * policies, not the parent's. So `ensure_telemetry_partition` gives every partition
 * it creates its own `ENABLE`/`FORCE ROW LEVEL SECURITY`, its own copy of
 * `tenant_isolation`, and the same grant `ta_app` already holds on the parent —
 * whether the partition is created here, at deploy time, or months later by the
 * scheduler. One function, so there is one place this can be gotten right or wrong,
 * not one per caller.
 */
export class TelemetryPartitioning1758030000000 implements MigrationInterface {
  name = 'TelemetryPartitioning1758030000000';

  public async up(q: QueryRunner): Promise<void> {
    // Move the existing table and its named objects out of the way. The new parent
    // claims the same names, so the old ones cannot keep them while both exist.
    await q.query(`ALTER TABLE "telemetry_reading" RENAME TO "telemetry_reading_old"`);
    await q.query(`
      ALTER TABLE "telemetry_reading_old"
        RENAME CONSTRAINT "telemetry_reading_pkey" TO "telemetry_reading_old_pkey"`);
    await q.query(`ALTER INDEX "uq_telemetry_reading_dedupe" RENAME TO "uq_telemetry_reading_dedupe_old"`);
    await q.query(`ALTER INDEX "ix_telemetry_reading_lookup" RENAME TO "ix_telemetry_reading_lookup_old"`);

    await q.query(`
      CREATE TABLE "telemetry_reading" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "imei" text NOT NULL,
        "signal" text NOT NULL,
        "value" double precision NOT NULL,
        "unit" text,
        "source_timestamp" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "source" text NOT NULL DEFAULT 'live',
        PRIMARY KEY ("id", "source_timestamp")
      ) PARTITION BY RANGE ("source_timestamp")`);

    // Defined on the parent, so — unlike RLS — they are inherited automatically by
    // every partition created after this point, whether by this migration or later
    // by the maintenance task.
    await q.query(`
      CREATE UNIQUE INDEX "uq_telemetry_reading_dedupe"
        ON "telemetry_reading" ("imei", "signal", "source_timestamp")`);
    await q.query(`
      CREATE INDEX "ix_telemetry_reading_lookup"
        ON "telemetry_reading" ("tenant_id", "imei", "signal", "source_timestamp")`);

    await q.query(`ALTER TABLE "telemetry_reading" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "telemetry_reading" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "telemetry_reading"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "telemetry_reading" TO "ta_app"`);

    // Idempotent and safe under concurrent callers: the existence check is the fast
    // path, and the exception handler is what makes two simultaneous first callers
    // for the same month safe rather than merely usually-safe. Whichever one loses
    // the race to actually create the partition finds it already there and returns —
    // the winner already did the RLS setup below, and doing it twice would just be a
    // duplicate-policy error of its own.
    await q.query(`
      CREATE OR REPLACE FUNCTION ensure_telemetry_partition(p_month date)
      RETURNS text
      LANGUAGE plpgsql
      AS $fn$
      DECLARE
        v_start date := date_trunc('month', p_month)::date;
        v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
        v_name  text := 'telemetry_reading_' || to_char(v_start, 'YYYY_MM');
      BEGIN
        IF to_regclass('public.' || quote_ident(v_name)) IS NOT NULL THEN
          RETURN v_name;
        END IF;

        BEGIN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF "telemetry_reading" FOR VALUES FROM (%L) TO (%L)',
            v_name, v_start, v_end);
        EXCEPTION WHEN duplicate_table THEN
          RETURN v_name;
        END;

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
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "ta_app"', v_name);

        RETURN v_name;
      END;
      $fn$`);

    // From the earliest month the old table actually holds through 12 months ahead.
    // Development measured empty, so this falls back to 2 months behind the current
    // one rather than the current month itself — the same margin and the same
    // reason `PredictionRuntime1757710000000` gives its own partitioned table: a
    // backfill or a logger reconnecting with buffered readings arrives dated in the
    // past, and an empty table has no "earliest row" to anchor that margin to
    // otherwise. Empty partitions cost nothing, and this is the buffer the daily
    // maintenance task only has to top up, not build from scratch.
    await q.query(`
      DO $$
      DECLARE
        v_from date;
        v_to date := (date_trunc('month', now()) + interval '12 months')::date;
        v_cursor date;
      BEGIN
        SELECT COALESCE(
          date_trunc('month', min("source_timestamp"))::date,
          (date_trunc('month', now()) - interval '2 months')::date
        ) INTO v_from FROM "telemetry_reading_old";

        v_cursor := v_from;
        WHILE v_cursor <= v_to LOOP
          PERFORM ensure_telemetry_partition(v_cursor);
          v_cursor := (v_cursor + interval '1 month')::date;
        END LOOP;
      END
      $$`);

    await q.query(`
      INSERT INTO "telemetry_reading"
        ("id", "tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
      SELECT "id", "tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source"
        FROM "telemetry_reading_old"`);

    // Inside the same transaction as the drop below: a short copy raises here and
    // the whole migration rolls back, rather than discovering it after the old table
    // is already gone and unrecoverable.
    await q.query(`
      DO $$
      DECLARE
        v_old bigint;
        v_new bigint;
      BEGIN
        SELECT count(*) INTO v_old FROM "telemetry_reading_old";
        SELECT count(*) INTO v_new FROM "telemetry_reading";
        IF v_old <> v_new THEN
          RAISE EXCEPTION
            'telemetry_reading partition copy mismatch: % row(s) before, % after', v_old, v_new;
        END IF;
      END
      $$`);

    await q.query(`DROP TABLE "telemetry_reading_old"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Copy out to a plain table, verified, before touching the partitioned one — the
    // same reason the up path verifies before its drop.
    await q.query(`
      CREATE TABLE "telemetry_reading_plain" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "imei" text NOT NULL,
        "signal" text NOT NULL,
        "value" double precision NOT NULL,
        "unit" text,
        "source_timestamp" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "source" text NOT NULL DEFAULT 'live'
      )`);

    await q.query(`
      INSERT INTO "telemetry_reading_plain"
        ("id", "tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
      SELECT "id", "tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source"
        FROM "telemetry_reading"`);

    await q.query(`
      DO $$
      DECLARE
        v_partitioned bigint;
        v_plain bigint;
      BEGIN
        SELECT count(*) INTO v_partitioned FROM "telemetry_reading";
        SELECT count(*) INTO v_plain FROM "telemetry_reading_plain";
        IF v_partitioned <> v_plain THEN
          RAISE EXCEPTION
            'telemetry_reading down-path copy mismatch: % row(s) before, % after', v_partitioned, v_plain;
        END IF;
      END
      $$`);

    // Takes every partition with it, including any the maintenance task created
    // after this migration ran — naming them individually would miss those.
    await q.query(`DROP TABLE "telemetry_reading" CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS ensure_telemetry_partition(date)`);

    await q.query(`ALTER TABLE "telemetry_reading_plain" RENAME TO "telemetry_reading"`);
    // The PK constraint was named for the table it was declared on — "telemetry_
    // reading_plain" at the time — and a table rename does not rename it along.
    // Left alone, the next up() cannot find "telemetry_reading_pkey" to move aside.
    await q.query(`
      ALTER TABLE "telemetry_reading" RENAME CONSTRAINT "telemetry_reading_plain_pkey" TO "telemetry_reading_pkey"`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_telemetry_reading_dedupe"
        ON "telemetry_reading" ("imei", "signal", "source_timestamp")`);
    await q.query(`
      CREATE INDEX "ix_telemetry_reading_lookup"
        ON "telemetry_reading" ("tenant_id", "imei", "signal", "source_timestamp")`);

    await q.query(`ALTER TABLE "telemetry_reading" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "telemetry_reading" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "telemetry_reading"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "telemetry_reading" TO "ta_app"`);
  }
}
