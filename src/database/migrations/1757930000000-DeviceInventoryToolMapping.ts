import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A device is registered against a tool mapping, so its expected telemetry is known
 * before any client has claimed it onto their own equipment (task: complete the
 * master-admin flow — Devices).
 *
 * Nullable: registering a device without picking a tool mapping stays valid, exactly
 * like `model` already is. `ON DELETE SET NULL` rather than a restrict — tool mappings
 * have no delete route today, but a device's own record should never become
 * un-updatable because of a future change to its reference data.
 */
export class DeviceInventoryToolMapping1757930000000 implements MigrationInterface {
  name = 'DeviceInventoryToolMapping1757930000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "device_inventory" ADD COLUMN "tool_mapping_id" uuid
        REFERENCES "tool_mapping" ("id") ON DELETE SET NULL`);
    await q.query(`CREATE INDEX "ix_device_inventory_tool_mapping" ON "device_inventory" ("tool_mapping_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "device_inventory" DROP COLUMN IF EXISTS "tool_mapping_id"`);
  }
}
