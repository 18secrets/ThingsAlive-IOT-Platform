import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-signal staleness threshold on `equipment_class_sensor_requirement` (task
 * Q08S s3).
 *
 * Nullable, and null means "use the platform default" (900 seconds — see
 * `src/signal-binding/services/signal-freshness.ts`), never "never stale". A
 * coolant probe reporting every 30 seconds is stale after five minutes; an hour
 * meter read once a shift is not stale after six. One global threshold was
 * wrong for both, and `stale`/`no_readings` could not be told apart reliably
 * without one.
 *
 * Published class versions are immutable, so this is set at authoring time and
 * read by (class_slug, class_version) at evaluation time — not copied to the
 * tenant. `equipment_class_sensor_requirement` is already excluded from
 * copy-on-grant (`class-content-inventory.ts`) for exactly this reason: a
 * tenant's `equipment_profile.class_version` pins which immutable platform row
 * it reads, which is what already guarantees a later platform change does not
 * reach an already-granted tenant — a second copy would duplicate a guarantee
 * version-pinning already provides.
 */
export class SignalFreshness1758090000000 implements MigrationInterface {
  name = 'SignalFreshness1758090000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement"
        ADD COLUMN "stale_after_seconds" integer NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_sensor_requirement"
        DROP COLUMN "stale_after_seconds"`);
  }
}
