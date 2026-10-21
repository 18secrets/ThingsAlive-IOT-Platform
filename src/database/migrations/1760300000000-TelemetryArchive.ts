import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telemetry past 90 days goes to Parquet, and its partition is dropped only once the
 * archive is proved (task QARCH1, D14, D24).
 *
 * - `telemetry_archive` — one row per object written: which account and month, the
 *   object key under that account's own prefix, its row count and checksum, and when it
 *   was verified by reading it back. A tenant-month whose rows changed after archiving
 *   (a late arrival) is exported again as the next part; the newest verified part is
 *   the one that counts.
 * - `telemetry_partition_drop` — the log of what was dropped, with what proved it.
 * - `drop_archived_telemetry_partition(month)` — the drop itself, and the rule with it:
 *   inside one transaction, under an exclusive lock so nothing lands mid-check, it counts
 *   every account's rows in the partition and refuses unless each has a verified archive
 *   holding exactly that many. Then it detaches and drops. D14's failure mode is
 *   "dropping first and discovering the truncation afterwards"; putting the check in the
 *   function that drops means no code path can skip it. SECURITY DEFINER because the
 *   application role cannot drop a table it does not own, and should not be able to
 *   drop any other way.
 */
export class TelemetryArchive1760300000000 implements MigrationInterface {
  name = 'TelemetryArchive1760300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "telemetry_archive" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "month" date NOT NULL,
        "part" integer NOT NULL,
        "object_key" text NOT NULL,
        "row_count" bigint NOT NULL,
        "checksum" text NOT NULL,
        "byte_size" bigint NOT NULL,
        "exported_at" timestamptz NOT NULL,
        "verified_at" timestamptz,
        "verify_error" text,
        CONSTRAINT "ck_telemetry_archive_month" CHECK (extract(day FROM "month") = 1),
        CONSTRAINT "ck_telemetry_archive_part" CHECK ("part" >= 1),
        CONSTRAINT "ck_telemetry_archive_count" CHECK ("row_count" >= 0),
        -- The object sits under its own account's prefix, and nowhere else (D14.3).
        CONSTRAINT "ck_telemetry_archive_prefix" CHECK ("object_key" LIKE 'tenants/' || "tenant_id" || '/telemetry/%'),
        CONSTRAINT "ck_telemetry_archive_verified" CHECK ("verified_at" IS NULL OR "verify_error" IS NULL)
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_telemetry_archive_part" ON "telemetry_archive" ("tenant_id", "month", "part")`);
    await q.query(`ALTER TABLE "telemetry_archive" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "telemetry_archive" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "telemetry_archive"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "telemetry_archive" TO "ta_app"`);

    await q.query(`
      CREATE TABLE "telemetry_partition_drop" (
        "partition_name" text PRIMARY KEY,
        "month" date NOT NULL,
        "rows_dropped" bigint NOT NULL,
        "proved_by" jsonb NOT NULL,
        "dropped_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`GRANT SELECT ON "telemetry_partition_drop" TO "ta_app"`);

    await q.query(`
      CREATE FUNCTION "drop_archived_telemetry_partition"(p_month date) RETURNS bigint
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE
        v_name   text := 'telemetry_reading_' || to_char(p_month, 'YYYY_MM');
        v_total  bigint := 0;
        v_proof  jsonb := '[]'::jsonb;
        r        record;
      BEGIN
        IF extract(day FROM p_month) <> 1 THEN
          RAISE EXCEPTION 'drop_archived_telemetry_partition: % is not the first of a month', p_month;
        END IF;
        IF to_regclass(v_name) IS NULL THEN
          RAISE EXCEPTION 'drop_archived_telemetry_partition: no partition % to drop', v_name;
        END IF;
        -- Nothing may land in the partition between the count and the drop.
        EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', v_name);

        FOR r IN EXECUTE format('SELECT "tenant_id", count(*)::bigint AS n FROM %I GROUP BY "tenant_id"', v_name) LOOP
          PERFORM 1 FROM (
            SELECT a."row_count" FROM "telemetry_archive" a
             WHERE a."tenant_id" = r."tenant_id" AND a."month" = p_month AND a."verified_at" IS NOT NULL
             ORDER BY a."part" DESC LIMIT 1
          ) latest WHERE latest."row_count" = r.n;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'drop_archived_telemetry_partition: % holds % row(s) for account % with no verified archive of exactly that many; refusing to drop',
              v_name, r.n, r."tenant_id";
          END IF;
          v_total := v_total + r.n;
          v_proof := v_proof || jsonb_build_object('tenantId', r."tenant_id", 'rows', r.n, 'archive', (
            SELECT jsonb_build_object('objectKey', a."object_key", 'checksum', a."checksum", 'part', a."part")
              FROM "telemetry_archive" a
             WHERE a."tenant_id" = r."tenant_id" AND a."month" = p_month AND a."verified_at" IS NOT NULL
             ORDER BY a."part" DESC LIMIT 1));
        END LOOP;

        EXECUTE format('ALTER TABLE "telemetry_reading" DETACH PARTITION %I', v_name);
        EXECUTE format('DROP TABLE %I', v_name);
        INSERT INTO "telemetry_partition_drop" ("partition_name", "month", "rows_dropped", "proved_by")
          VALUES (v_name, p_month, v_total, v_proof);
        RETURN v_total;
      END $$`);
    await q.query(`REVOKE ALL ON FUNCTION "drop_archived_telemetry_partition"(date) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION "drop_archived_telemetry_partition"(date) TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS "drop_archived_telemetry_partition"(date)`);
    await q.query(`DROP TABLE IF EXISTS "telemetry_partition_drop"`);
    await q.query(`DROP TABLE IF EXISTS "telemetry_archive"`);
  }
}
