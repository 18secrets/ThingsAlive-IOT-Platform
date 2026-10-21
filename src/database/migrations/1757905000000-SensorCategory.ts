import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sensor categories: the coarse grouping ('Engine', 'Hydraulics', 'Fuel') a sensor is
 * filed under (task: master-data pipeline for device onboarding).
 *
 * Platform-owned, no tenant column, no row-level security — Master Admin's own
 * reference data, protected by GRANT alone, same as `equipment_class_profile`.
 */
export class SensorCategory1757905000000 implements MigrationInterface {
  name = 'SensorCategory1757905000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sensor_category" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_sensor_category_name" ON "sensor_category" ("name")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "sensor_category" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sensor_category"`);
  }
}
