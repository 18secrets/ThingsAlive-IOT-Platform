import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sites and the equipment register, owned by the client (tasks P1-85, P1-86).
 *
 * The decision behind this migration: a client's CEO or manager owns their equipment
 * master and where it stands. That cannot live in the projection layer, which is a
 * read-only mirror by construction — so the register moves to 2.0 and the mirror
 * stays a mirror.
 *
 * `equipment_profile` gains the descriptive columns rather than being replaced. Its
 * identity was always `(source_system, external_id)`, because two upstream systems
 * could legitimately report the same machine; equipment created here is simply
 * another source system, `ta-2.0`, so every consumer built over the last twelve
 * slices keeps working without knowing which kind it is holding.
 *
 * `user_plant_access` changes shape, and the note left on it last slice — that its
 * key would survive equipment moving into 2.0 — was wrong. Sites are rows now, so an
 * assignment points at a row. The old pair would have let a site renamed upstream
 * quietly take somebody's access with it.
 */
export class EquipmentRegister1757760000000 implements MigrationInterface {
  name = 'EquipmentRegister1757760000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "plant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "address" text,
        "site_area" text,
        "capacity" text,
        "project_type" text,
        "operational_status" text,
        "description" text,
        "status" text NOT NULL DEFAULT 'active',
        "source_system" text,
        "external_id" text,
        "created_by" text,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // The code is the client's, unique inside their account and nowhere else: two
    // customers both calling a site "PLANT-A" is ordinary.
    await q.query(`CREATE UNIQUE INDEX "uq_plant_code" ON "plant" ("tenant_id", "code")`);
    await q.query(`CREATE INDEX "ix_plant_tenant" ON "plant" ("tenant_id", "status")`);
    await q.query(`
      ALTER TABLE "plant" ADD CONSTRAINT "ck_plant_status" CHECK ("status" IN ('active', 'retired'))`);
    // Half a link is worse than none: an upstream id with no system to read it against
    // matches nothing during an adoption and looks, on a screen, exactly like a site
    // that has been linked. Both or neither.
    await q.query(`
      ALTER TABLE "plant" ADD CONSTRAINT "ck_plant_external_pair"
        CHECK (("source_system" IS NULL) = ("external_id" IS NULL))`);
    // At most one site here per upstream site, so adopting a fleet twice cannot split
    // it across two rows that each hold half the machines.
    await q.query(`
      CREATE UNIQUE INDEX "uq_plant_external" ON "plant" ("tenant_id", "source_system", "external_id")
        WHERE "external_id" IS NOT NULL`);

    await q.query(`
      CREATE TABLE "equipment_placement_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "from_plant_id" uuid,
        "to_plant_id" uuid,
        "reason" text,
        "actor_user_id" text NOT NULL,
        "at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE INDEX "ix_equipment_placement_asset"
        ON "equipment_placement_event" ("tenant_id", "source_system", "external_id", "at")`);
    await q.query(`
      CREATE INDEX "ix_equipment_placement_plant"
        ON "equipment_placement_event" ("tenant_id", "to_plant_id", "at")`);

    for (const column of [
      `"origin" text NOT NULL DEFAULT 'client'`,
      `"status" text NOT NULL DEFAULT 'active'`,
      `"name" text`,
      `"manufacturer" text`,
      `"model_number" text`,
      `"serial_number" text`,
      `"description" text`,
      `"plant_id" uuid`,
      `"created_by" text`,
    ]) {
      await q.query(`ALTER TABLE "equipment_profile" ADD COLUMN ${column}`);
    }
    await q.query(`
      ALTER TABLE "equipment_profile" ADD CONSTRAINT "ck_equipment_origin"
        CHECK ("origin" IN ('mirrored', 'client'))`);
    await q.query(`
      ALTER TABLE "equipment_profile" ADD CONSTRAINT "ck_equipment_status"
        CHECK ("status" IN ('active', 'retired'))`);
    // A site manager's fleet is this query. It runs on every request they make.
    await q.query(`
      CREATE INDEX "ix_equipment_profile_plant" ON "equipment_profile" ("tenant_id", "plant_id")
        WHERE "status" = 'active'`);

    // An assignment points at a site row rather than at an upstream identifier. The
    // old columns held a pair that could be renamed upstream and take somebody's
    // access with it; there is no data to migrate because nothing has shipped.
    await q.query(`DROP INDEX IF EXISTS "uq_user_plant_access"`);
    await q.query(`ALTER TABLE "user_plant_access" DROP COLUMN "source_system"`);
    await q.query(`ALTER TABLE "user_plant_access" DROP COLUMN "plant_external_id"`);
    await q.query(`ALTER TABLE "user_plant_access" ADD COLUMN "plant_id" uuid NOT NULL`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_user_plant_access"
        ON "user_plant_access" ("tenant_id", "user_id", "plant_id")`);

    for (const table of ['plant', 'equipment_placement_event']) {
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

    // A site is closed rather than deleted, for the same reason a user is suspended:
    // machines, work and predictions all point at it.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "plant" TO "ta_app"`);
    // Where a machine has been is a record. Insert and read, nothing else.
    await q.query(`GRANT SELECT, INSERT ON "equipment_placement_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_user_plant_access"`);
    await q.query(`ALTER TABLE "user_plant_access" DROP COLUMN IF EXISTS "plant_id"`);
    await q.query(`ALTER TABLE "user_plant_access" ADD COLUMN "source_system" text NOT NULL DEFAULT ''`);
    await q.query(`ALTER TABLE "user_plant_access" ADD COLUMN "plant_external_id" text NOT NULL DEFAULT ''`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_user_plant_access"
        ON "user_plant_access" ("tenant_id", "user_id", "source_system", "plant_external_id")`);

    await q.query(`DROP INDEX IF EXISTS "ix_equipment_profile_plant"`);
    for (const column of ['created_by', 'plant_id', 'description', 'serial_number',
      'model_number', 'manufacturer', 'name', 'status', 'origin']) {
      await q.query(`ALTER TABLE "equipment_profile" DROP COLUMN IF EXISTS "${column}"`);
    }
    await q.query(`DROP TABLE IF EXISTS "equipment_placement_event"`);
    await q.query(`DROP TABLE IF EXISTS "plant"`);
  }
}
