import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The catalog, entitlements and the 2.0-owned equipment profile (tasks P1-01,
 * P1-04, P1-06).
 *
 * Two kinds of table here, and the difference decides how each is protected.
 *
 * The catalog tables are platform-owned: one row describes a class of machine for
 * every customer that owns one, so they carry no tenant column and row-level security
 * has nothing to match on. What narrows a tenant's view is the entitlement join in
 * CatalogService. Copying the catalog per tenant instead would mean an OEM threshold
 * correction had to be applied in fifty places, and the fiftieth would be missed.
 *
 * `equipment_profile` is tenant-owned and joins the isolation policy alongside the
 * projections. It exists because 2.0 must not write into `equipment_projection`: that
 * table is a mirror, and a 2.0 column inside it would leave the next full reconcile
 * unable to tell drift from a local edit.
 */
export class Catalog1757680000000 implements MigrationInterface {
  name = 'Catalog1757680000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_class_profile" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "name" text NOT NULL,
        "description" text,
        "category" text,
        "expected_signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "failure_modes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "default_thresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // (slug, version) rather than slug alone: a published definition is immutable and
    // a change publishes a new version, so the same slug must be allowed to repeat.
    await q.query(`CREATE UNIQUE INDEX "uq_equipment_class_profile_version" ON "equipment_class_profile" ("slug", "version")`);
    await q.query(`CREATE INDEX "ix_equipment_class_profile_slug" ON "equipment_class_profile" ("slug")`);
    await q.query(`CREATE INDEX "ix_equipment_class_profile_status" ON "equipment_class_profile" ("status")`);

    await q.query(`
      CREATE TABLE "scenario_definition" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "equipment_class_slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "severity" text NOT NULL DEFAULT 'medium',
        "tier" int NOT NULL DEFAULT 1,
        "required_signals" text[] NOT NULL DEFAULT '{}'::text[],
        "minimum_history_days" int NOT NULL DEFAULT 0,
        "parameters" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_scenario_definition_version" ON "scenario_definition" ("slug", "version")`);
    await q.query(`CREATE INDEX "ix_scenario_definition_slug" ON "scenario_definition" ("slug")`);
    await q.query(`CREATE INDEX "ix_scenario_definition_class" ON "scenario_definition" ("equipment_class_slug")`);
    await q.query(`CREATE INDEX "ix_scenario_definition_status" ON "scenario_definition" ("status")`);

    await q.query(`
      CREATE TABLE "signal_alias" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "source_system" text NOT NULL DEFAULT '*',
        "alias" text NOT NULL,
        "canonical" text NOT NULL,
        "unit" text,
        "note" text
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_signal_alias" ON "signal_alias" ("source_system", "alias")`);
    await q.query(`CREATE INDEX "ix_signal_alias_canonical" ON "signal_alias" ("canonical")`);

    await q.query(`
      CREATE TABLE "client_catalog_entitlement" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "equipment_class_slug" text NOT NULL,
        "granted_by" text NOT NULL,
        "granted_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revoked_by" text,
        "note" text
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_client_catalog_entitlement" ON "client_catalog_entitlement" ("tenant_id", "equipment_class_slug")`);
    await q.query(`CREATE INDEX "ix_client_catalog_entitlement_tenant" ON "client_catalog_entitlement" ("tenant_id")`);

    await q.query(`
      CREATE TABLE "equipment_profile" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "equipment_class_slug" text,
        "class_version" int,
        "tier" text NOT NULL DEFAULT 'basic',
        "commissioned_at" timestamptz,
        "service_interval_hours" int,
        "readiness" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updated_by" text,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_equipment_profile_external" ON "equipment_profile" ("source_system", "external_id")`);
    await q.query(`CREATE INDEX "ix_equipment_profile_tenant" ON "equipment_profile" ("tenant_id")`);
    await q.query(`CREATE INDEX "ix_equipment_profile_class" ON "equipment_profile" ("tenant_id", "equipment_class_slug")`);

    // The new tenant-owned table joins the isolation policy. Forgetting this is the
    // silent failure P1-62 exists to catch: the table would work perfectly and be
    // readable by every tenant, and nothing would say so.
    await q.query(`ALTER TABLE "equipment_profile" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "equipment_profile" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "equipment_profile"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_profile" TO "ta_app"`);
    // The catalog is read-only to the application. Publishing a class or a scenario
    // is a migration or a seeder run by someone with the schema role — not something
    // a request can do, however privileged the caller's token says they are.
    await q.query(`GRANT SELECT ON "equipment_class_profile" TO "ta_app"`);
    await q.query(`GRANT SELECT ON "scenario_definition" TO "ta_app"`);
    await q.query(`GRANT SELECT ON "signal_alias" TO "ta_app"`);
    // Entitlements are the exception: a master admin grants and revokes them through
    // the API, because a commercial decision should not wait for a deploy.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "client_catalog_entitlement" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "equipment_profile"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_profile"`);
    await q.query(`DROP TABLE IF EXISTS "client_catalog_entitlement"`);
    await q.query(`DROP TABLE IF EXISTS "signal_alias"`);
    await q.query(`DROP TABLE IF EXISTS "scenario_definition"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_profile"`);
  }
}
