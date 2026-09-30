import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A stable key for `sensor`, and a place to record who approved or dismissed a
 * proposed one (task QIMP5).
 *
 * The diagnostic that led here found the deployed resolver keyed on `sensor_name` —
 * a display string, matched case-sensitively, exact. Two workbooks spelling the same
 * physical sensor differently is not a possibility this schema should depend on
 * nobody ever doing. `slug` is what the validator, the diff and the approval
 * endpoint all key on from here forward; `sensor_name` stays the display string.
 *
 * Backfilled here rather than by a script: three rows in Development, cheap enough
 * to do inline, and a slug backfill that silently leaves a row null is a NOT NULL
 * constraint away from being caught at the worst possible time (the next INSERT)
 * instead of now. Assigned one row at a time, in creation order, so two sensors
 * whose names slugify to the same base do not collide — the second gets `-2`, not a
 * unique-index violation.
 */
export class SensorSlugAndApprovals1758060000000 implements MigrationInterface {
  name = 'SensorSlugAndApprovals1758060000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sensor" ADD COLUMN "slug" text`);

    await q.query(`
      DO $$
      DECLARE
        r RECORD;
        base_slug text;
        candidate text;
        suffix int;
      BEGIN
        FOR r IN SELECT id, sensor_name FROM "sensor" ORDER BY created_at, id LOOP
          base_slug := lower(regexp_replace(regexp_replace(trim(r.sensor_name), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+)|(-+$)', '', 'g'));
          IF base_slug = '' THEN base_slug := 'sensor'; END IF;
          candidate := base_slug;
          suffix := 1;
          WHILE EXISTS (SELECT 1 FROM "sensor" WHERE slug = candidate) LOOP
            suffix := suffix + 1;
            candidate := base_slug || '-' || suffix;
          END LOOP;
          UPDATE "sensor" SET slug = candidate WHERE id = r.id;
        END LOOP;
      END
      $$`);

    // A row left null here is a row the loop above did not reach — a bug in the
    // backfill, not a state this migration should complete over silently.
    const [{ remaining }] = await q.query(`SELECT count(*)::int AS remaining FROM "sensor" WHERE slug IS NULL`);
    if (remaining > 0) {
      throw new Error(`sensor.slug backfill left ${remaining} row(s) unassigned.`);
    }

    await q.query(`ALTER TABLE "sensor" ALTER COLUMN "slug" SET NOT NULL`);
    await q.query(`
      ALTER TABLE "sensor" ADD CONSTRAINT "ck_sensor_slug_shape"
        CHECK ("slug" ~ '^[a-z0-9-]+$')`);
    await q.query(`CREATE UNIQUE INDEX "uq_sensor_slug" ON "sensor" ("slug")`);

    // Who approved or dismissed a proposed sensor or category, against this batch —
    // the audit trail `acknowledgeWarnings` (QIMP4) already established the pattern
    // for: a field the caller sets deliberately, recorded, not a UI checkbox nobody
    // remembers clicking past.
    await q.query(`
      ALTER TABLE "catalog_import_batch" ADD COLUMN "sensor_decisions" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "catalog_import_batch" DROP COLUMN IF EXISTS "sensor_decisions"`);
    await q.query(`DROP INDEX IF EXISTS "uq_sensor_slug"`);
    await q.query(`ALTER TABLE "sensor" DROP CONSTRAINT IF EXISTS "ck_sensor_slug_shape"`);
    await q.query(`ALTER TABLE "sensor" DROP COLUMN IF EXISTS "slug"`);
  }
}
