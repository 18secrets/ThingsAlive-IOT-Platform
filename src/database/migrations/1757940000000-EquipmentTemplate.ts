import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Common onboarding fields for a named/categorised kind of equipment (task: help a
 * client's Add Equipment form pre-fill from a matching template).
 *
 * Platform-owned, no tenant column, no row-level security — Master Admin's own
 * reference data, protected by GRANT alone. Deliberately separate from
 * `equipment_class_profile`: that table is the prediction catalog and stays
 * untouched by this migration.
 */
export class EquipmentTemplate1757940000000 implements MigrationInterface {
  name = 'EquipmentTemplate1757940000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_template" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "category" text,
        "manufacturer" text,
        "engine_type" text,
        "fuel_tank_capacity_liters" double precision,
        "service_interval_hours" int,
        "description" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_equipment_template_category" ON "equipment_template" ("category")`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_template" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "equipment_template"`);
  }
}
