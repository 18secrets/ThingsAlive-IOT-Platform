import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Users, roles and assignment, owned by 2.0 (tasks P1-21, P1-83, P1-84).
 *
 * Roles are rows and capabilities are code. A client composes a role from a fixed
 * vocabulary the application actually checks, which is what lets them add the roles
 * they need without being able to invent a permission nothing reads — a role granting
 * something no code has heard of is a permission that looks given and does nothing.
 *
 * Email is unique across the platform rather than within an account. One person, one
 * login; what varies is what they are assigned to, and assignment already spans as
 * many sites and machines as anybody needs. The index is therefore global, and it is
 * the one thing here that is genuinely expensive to change later.
 *
 * The access tables are separate rather than one table with a `kind` column: "which
 * sites does this person run" and "who is on this machine" are different queries with
 * different indexes, and a polymorphic table serves both badly.
 */
export class Identity1757730000000 implements MigrationInterface {
  name = 'Identity1757730000000';

  private readonly tables = ['tenant_role', 'app_user', 'user_plant_access', 'user_equipment_access'];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tenant_role" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "capabilities" text[] NOT NULL DEFAULT '{}'::text[],
        "scope_shape" text NOT NULL DEFAULT 'equipment',
        "is_built_in" boolean NOT NULL DEFAULT false,
        "template_slug" text,
        "copied_at" timestamptz,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_tenant_role" ON "tenant_role" ("tenant_id", "slug")`);
    // Three shapes, not three levels. Enforced here as well as in the service, because
    // a value outside this set would make the resolver fall through to no scope at all.
    await q.query(`
      ALTER TABLE "tenant_role" ADD CONSTRAINT "ck_tenant_role_scope_shape"
        CHECK ("scope_shape" IN ('tenant', 'plant', 'equipment'))`);

    await q.query(`
      CREATE TABLE "app_user" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "email" text NOT NULL,
        "full_name" text NOT NULL,
        "phone" text,
        "role_slug" text NOT NULL,
        "status" text NOT NULL DEFAULT 'invited',
        "password_hash" text,
        "external_user_id" text,
        "external_source_system" text,
        "invited_by" text,
        "invited_at" timestamptz,
        "activated_at" timestamptz,
        "suspended_at" timestamptz,
        "suspended_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // Global, not per tenant. Deliberate, and the hardest line here to reverse.
    await q.query(`CREATE UNIQUE INDEX "uq_app_user_email" ON "app_user" ("email")`);
    await q.query(`CREATE INDEX "ix_app_user_tenant" ON "app_user" ("tenant_id", "status")`);
    await q.query(`
      ALTER TABLE "app_user" ADD CONSTRAINT "ck_app_user_status"
        CHECK ("status" IN ('invited', 'active', 'suspended'))`);
    // Empty today. Present from the first migration because the existing platform's
    // users are to be merged in later, and a merge with nowhere to record the
    // correspondence silently becomes a duplicate instead.
    await q.query(`
      CREATE UNIQUE INDEX "uq_app_user_external" ON "app_user" ("external_source_system", "external_user_id")
        WHERE "external_user_id" IS NOT NULL`);

    await q.query(`
      CREATE TABLE "user_plant_access" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "user_id" uuid NOT NULL,
        "source_system" text NOT NULL,
        "plant_external_id" text NOT NULL,
        "granted_by" text,
        "granted_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_user_plant_access"
        ON "user_plant_access" ("tenant_id", "user_id", "source_system", "plant_external_id")`);
    await q.query(`CREATE INDEX "ix_user_plant_access_user" ON "user_plant_access" ("tenant_id", "user_id")`);

    await q.query(`
      CREATE TABLE "user_equipment_access" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "user_id" uuid NOT NULL,
        "source_system" text NOT NULL,
        "equipment_external_id" text NOT NULL,
        "granted_by" text,
        "granted_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_user_equipment_access"
        ON "user_equipment_access" ("tenant_id", "user_id", "source_system", "equipment_external_id")`);
    await q.query(`CREATE INDEX "ix_user_equipment_access_user" ON "user_equipment_access" ("tenant_id", "user_id")`);
    // The other direction: who is on this machine. Asked by every screen that shows
    // an asset, and unanswerable from the index above.
    await q.query(`
      CREATE INDEX "ix_user_equipment_access_asset"
        ON "user_equipment_access" ("tenant_id", "source_system", "equipment_external_id")`);

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

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_role" TO "ta_app"`);
    // A person is suspended, never deleted: everything they did names them, and
    // removing the row turns every one of those records into an unresolvable id.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "app_user" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "user_plant_access" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "user_equipment_access" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "user_equipment_access"`);
    await q.query(`DROP TABLE IF EXISTS "user_plant_access"`);
    await q.query(`DROP TABLE IF EXISTS "app_user"`);
    await q.query(`DROP TABLE IF EXISTS "tenant_role"`);
  }
}
