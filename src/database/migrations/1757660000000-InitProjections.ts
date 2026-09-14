import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Projections, the tenant map, the rejection log and telemetry.
 *
 * Written as explicit SQL rather than generated, because the constraints are the
 * point: the dedupe key on telemetry and the external identity on every projection
 * are what make the sync idempotent and the readings safe to replay.
 */
export class InitProjections1757660000000 implements MigrationInterface {
  name = 'InitProjections1757660000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await q.query(`
      CREATE TABLE "tenant_map" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "source_system" text NOT NULL,
        "external_client_id" text NOT NULL,
        "tenant_id" text NOT NULL,
        "display_name" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_tenant_map_source" ON "tenant_map" ("source_system", "external_client_id")`);
    await q.query(`CREATE INDEX "ix_tenant_map_tenant" ON "tenant_map" ("tenant_id")`);

    // Columns every projection shares. Kept identical across the three tables so a
    // reconcile job can treat them uniformly.
    const projectionColumns = `
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "source_system" text NOT NULL,
      "external_id" text NOT NULL,
      "tenant_id" text NOT NULL,
      "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "source_updated_at" timestamptz,
      "synced_at" timestamptz NOT NULL DEFAULT now(),
      "checksum" text NOT NULL,
      "status" text NOT NULL DEFAULT 'live'`;

    await q.query(`
      CREATE TABLE "equipment_projection" (
        ${projectionColumns},
        "name" text,
        "class_id" text,
        "plant_external_id" text,
        "category" text
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_equipment_projection_external" ON "equipment_projection" ("source_system", "external_id")`);
    await q.query(`CREATE INDEX "ix_equipment_projection_tenant" ON "equipment_projection" ("tenant_id")`);
    await q.query(`CREATE INDEX "ix_equipment_projection_status" ON "equipment_projection" ("status")`);

    await q.query(`
      CREATE TABLE "device_projection" (
        ${projectionColumns},
        "imei" text NOT NULL,
        "equipment_external_id" text,
        "name" text
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_device_projection_external" ON "device_projection" ("source_system", "external_id")`);
    await q.query(`CREATE INDEX "ix_device_projection_tenant" ON "device_projection" ("tenant_id")`);
    await q.query(`CREATE INDEX "ix_device_projection_imei" ON "device_projection" ("imei")`);
    await q.query(`CREATE INDEX "ix_device_projection_status" ON "device_projection" ("status")`);

    await q.query(`
      CREATE TABLE "sensor_map_projection" (
        ${projectionColumns},
        "imei" text NOT NULL,
        "signal" text NOT NULL,
        "sensor_name" text,
        "unit" text
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_sensor_map_projection_external" ON "sensor_map_projection" ("source_system", "external_id")`);
    await q.query(`CREATE INDEX "ix_sensor_map_projection_tenant" ON "sensor_map_projection" ("tenant_id")`);
    await q.query(`CREATE INDEX "ix_sensor_map_projection_imei" ON "sensor_map_projection" ("imei")`);
    await q.query(`CREATE INDEX "ix_sensor_map_projection_status" ON "sensor_map_projection" ("status")`);

    await q.query(`
      CREATE TABLE "projection_rejection" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "source_system" text NOT NULL,
        "kind" text NOT NULL,
        "external_id" text,
        "reason" text NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_projection_rejection_kind" ON "projection_rejection" ("kind", "created_at")`);

    await q.query(`
      CREATE TABLE "telemetry_reading" (
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
    // The constraint that protects every baseline built on this table.
    await q.query(`CREATE UNIQUE INDEX "uq_telemetry_reading_dedupe" ON "telemetry_reading" ("imei", "signal", "source_timestamp")`);
    await q.query(`CREATE INDEX "ix_telemetry_reading_lookup" ON "telemetry_reading" ("tenant_id", "imei", "signal", "source_timestamp")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Reverse order of creation. Tested, not assumed: a migration without a working
    // down path is a one-way door, and nobody discovers that at a convenient moment.
    await q.query(`DROP TABLE IF EXISTS "telemetry_reading"`);
    await q.query(`DROP TABLE IF EXISTS "projection_rejection"`);
    await q.query(`DROP TABLE IF EXISTS "sensor_map_projection"`);
    await q.query(`DROP TABLE IF EXISTS "device_projection"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_projection"`);
    await q.query(`DROP TABLE IF EXISTS "tenant_map"`);
  }
}
