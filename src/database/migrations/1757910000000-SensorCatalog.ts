import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The reference sensor catalog: what a sensor is, and the telemetry channels it
 * exposes (task: master-data pipeline for device onboarding).
 *
 * Platform-owned, flat master data — no tenant column, no row-level security, no
 * draft/publish lifecycle. `category_id` is a plain FK rather than jsonb: a category
 * is a real row a sensor points at, unlike the parameter specs, which are inherently
 * a per-sensor structure with no identity of their own.
 */
export class SensorCatalog1757910000000 implements MigrationInterface {
  name = 'SensorCatalog1757910000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sensor" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sensor_name" text NOT NULL,
        "category_id" uuid REFERENCES "sensor_category" ("id"),
        "description" text,
        "protocol" text,
        "parameter_specs" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_sensor_category" ON "sensor" ("category_id")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "sensor" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sensor"`);
  }
}
