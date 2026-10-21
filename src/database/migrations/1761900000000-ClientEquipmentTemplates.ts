import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A client's own equipment templates (task QCLIENT-TEMPLATE): the same onboarding fields
 * as Master Admin's `equipment_template`, owned by one account.
 *
 * Its own table rather than a `tenant_id` on the shared one. `equipment_template` is
 * global reference data guarded by grants alone; mixing a client's rows into it would put
 * Things Alive's and every customer's templates under one policy, and the first query
 * that forgot its filter would show one client another's. The catalog already splits the
 * same way — `catalog` for the platform, `my-catalog` for the client's copies.
 *
 * Onboarding convenience, like the master: values are copied into equipment when it is
 * created, and nothing references a template afterwards. No lifecycle, no versions.
 */
export class ClientEquipmentTemplates1761900000000 implements MigrationInterface {
  name = 'ClientEquipmentTemplates1761900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "client_equipment_template" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "category" text,
        "manufacturer" text,
        "engine_type" text,
        "fuel_tank_capacity_liters" double precision,
        "service_interval_hours" int,
        "description" text,
        -- Where it was copied from, and nothing more. Not a foreign key: Master Admin's
        -- template may be edited or go away, and the client's copy is theirs either way.
        "copied_from_id" uuid,
        "created_by" text NOT NULL,
        "updated_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_client_equipment_template_name"
          CHECK (length(btrim("name")) > 0),
        -- Both feed calculations once copied into equipment — usable-fuel runtime and the
        -- service forecast — where a zero or a negative would be read as a real number.
        CONSTRAINT "ck_client_equipment_template_tank"
          CHECK ("fuel_tank_capacity_liters" IS NULL OR "fuel_tank_capacity_liters" > 0),
        CONSTRAINT "ck_client_equipment_template_interval"
          CHECK ("service_interval_hours" IS NULL OR "service_interval_hours" > 0)
      )`);
    // Picked from a list by name; two called "CAT 320" are two nobody can tell apart.
    await q.query(`
      CREATE UNIQUE INDEX "uq_client_equipment_template_name"
        ON "client_equipment_template" ("tenant_id", lower("name"))`);

    await q.query(`ALTER TABLE "client_equipment_template" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_equipment_template" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_equipment_template"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_equipment_template" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "client_equipment_template"`);
  }
}
