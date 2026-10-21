import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The device pool and its movements (task P1-19).
 *
 * The nullable tenant is the whole design. A device in a warehouse belongs to nobody,
 * and the projection layer cannot represent that at all — the sync refuses a record
 * whose client does not resolve to a tenant, correctly, because an untenanted
 * projection row is a row every tenant can read. So stock lives here instead, with a
 * null tenant, and the ordinary isolation policy does the rest: null is never equal
 * to anything in SQL, so unassigned devices are invisible from inside an account
 * without a second rule to write or maintain.
 *
 * That is worth stating loudly because it looks like an omission. Anyone who adds
 * `OR tenant_id IS NULL` to make the pool readable from a tenant session has removed
 * the protection, and nothing will fail.
 *
 * Identity is the IMEI alone rather than (source_system, external_id) as everywhere
 * else in 2.0. An IMEI is globally unique by construction, and stock has no source
 * system — it comes from a purchase order rather than from an upstream database.
 */
export class DeviceInventory1757720000000 implements MigrationInterface {
  name = 'DeviceInventory1757720000000';

  private readonly tables = ['device_inventory', 'device_inventory_event'];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "device_inventory" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "imei" text NOT NULL,
        "tenant_id" text,
        "state" text NOT NULL DEFAULT 'in-stock',
        "model" text,
        "batch_ref" text,
        "received_at" timestamptz,
        "assigned_at" timestamptz,
        "assigned_by" text,
        "equipment_external_id" text,
        "claimed_at" timestamptz,
        "claimed_by" text,
        "notes" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // One row per physical device. Two rows for one IMEI would mean one logger
    // assigned to two customers, which is the failure this constraint exists for.
    await q.query(`CREATE UNIQUE INDEX "uq_device_inventory_imei" ON "device_inventory" ("imei")`);
    await q.query(`CREATE INDEX "ix_device_inventory_tenant" ON "device_inventory" ("tenant_id", "state")`);
    await q.query(`CREATE INDEX "ix_device_inventory_state" ON "device_inventory" ("state")`);
    // The onboarding query: what is left in stock. Partial, because the pool is the
    // small end of this table once a few customers are live.
    await q.query(`
      CREATE INDEX "ix_device_inventory_available" ON "device_inventory" ("batch_ref")
        WHERE "tenant_id" IS NULL AND "state" = 'in-stock'`);

    await q.query(`
      CREATE TABLE "device_inventory_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "imei" text NOT NULL,
        "action" text NOT NULL,
        "from_state" text,
        "to_state" text NOT NULL,
        "tenant_id" text,
        "equipment_external_id" text,
        "reason" text,
        "actor_user_id" text NOT NULL,
        "actor_roles" text[] NOT NULL DEFAULT '{}'::text[],
        "at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_device_inventory_event_imei" ON "device_inventory_event" ("imei", "at")`);
    await q.query(`CREATE INDEX "ix_device_inventory_event_tenant" ON "device_inventory_event" ("tenant_id", "at")`);

    for (const table of this.tables) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
    }

    // A customer updates their own devices when fitting one to a machine, and never
    // inserts or deletes: stock arriving and stock leaving are Things Alive's acts,
    // and they happen through the platform path.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "device_inventory" TO "ta_app"`);
    // Movements are a record. No update, no delete, by either side.
    await q.query(`GRANT SELECT, INSERT ON "device_inventory_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "device_inventory_event"`);
    await q.query(`DROP TABLE IF EXISTS "device_inventory"`);
  }
}
