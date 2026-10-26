import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ensure_telemetry_partition` runs as its owner (task QIMPORT-READINGS).
 *
 * `TelemetryPartitioning1758030000000` wrote it SECURITY INVOKER, and every caller in
 * the application — ingest, the daily maintenance task, now the readings import — runs
 * as `ta_app`, which cannot create a table. It only ever looked as if it worked: the
 * migration built partitions twelve months ahead, so the function took its "already
 * exists" path, and the specs that build a new month call it as the owner. The first
 * caller to need a month nobody built — a historical upload, a logger's long backlog,
 * maintenance a year from the migration — gets "permission denied for schema public".
 *
 * SECURITY DEFINER with a pinned search_path, the same arrangement as the delete and
 * seed-only guards, so a caller cannot put its own `telemetry_reading` ahead of ours.
 * The body is unchanged: it creates an empty partition with the parent's policy and
 * grants, and writes no tenant row. Bounding how far back a reading may land stays the
 * callers' job (`MAX_BACKFILL_MONTHS`), as it was.
 */
export class PartitionAsOwner1762200000000 implements MigrationInterface {
  name = 'PartitionAsOwner1762200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER FUNCTION ensure_telemetry_partition(date) SECURITY DEFINER SET search_path = public, pg_temp`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER FUNCTION ensure_telemetry_partition(date) SECURITY INVOKER RESET search_path`);
  }
}
