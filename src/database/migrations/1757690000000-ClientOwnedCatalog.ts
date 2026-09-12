import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The client's own copies, and the grants that let templates be authored through the
 * API rather than a migration.
 *
 * The model this implements: the catalog is a **template library**. Granting a class
 * copies it into the client's account, and from that moment the copy is the client's.
 * Their super admin may rewrite any of it; nobody at Things Alive can write it at all.
 *
 * Two halves, and the asymmetry between them is the design.
 *
 * `client_equipment_class` and `client_scenario` are tenant-owned and join the
 * isolation policy, so a write can only ever land in the tenant whose session it runs
 * in. That is what makes "Things Alive cannot edit a client's settings" enforceable
 * rather than aspirational: the template-authoring service holds no repository for
 * these tables and runs in no tenant session, so there is no statement it could issue
 * that would reach them.
 *
 * The catalog tables gain INSERT and UPDATE for `ta_app`, which they deliberately did
 * not have before. The earlier reasoning — publishing is a deploy, not a request —
 * held while the catalog was the thing clients ran. It is not: clients run their
 * copies, and a template edit now changes nothing that is live. Making Things Alive
 * wait for a deploy to fix a typo in a template bought nothing and cost a day.
 *
 * No DELETE, on either side of the catalog. A template somebody has copied is part of
 * the provenance record of every copy made from it, and deleting it turns those
 * records into references to nothing. Retiring is a status change.
 */
export class ClientOwnedCatalog1757690000000 implements MigrationInterface {
  name = 'ClientOwnedCatalog1757690000000';

  private readonly tenantTables = ['client_equipment_class', 'client_scenario'];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "client_equipment_class" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "category" text,
        "expected_signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "failure_modes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "default_thresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "template_slug" text,
        "template_version" int,
        "template_checksum" text,
        "copied_at" timestamptz,
        "status" text NOT NULL DEFAULT 'active',
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    // Unique per tenant, not globally: two clients naming a class the same thing is
    // ordinary, and it is not the platform's business to stop them.
    await q.query(`CREATE UNIQUE INDEX "uq_client_equipment_class" ON "client_equipment_class" ("tenant_id", "slug")`);
    await q.query(`CREATE INDEX "ix_client_equipment_class_tenant" ON "client_equipment_class" ("tenant_id")`);

    await q.query(`
      CREATE TABLE "client_scenario" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "slug" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "severity" text NOT NULL DEFAULT 'medium',
        "tier" int NOT NULL DEFAULT 1,
        "required_signals" text[] NOT NULL DEFAULT '{}'::text[],
        "minimum_history_days" int NOT NULL DEFAULT 0,
        "parameters" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "enabled" boolean NOT NULL DEFAULT true,
        "template_slug" text,
        "template_version" int,
        "template_checksum" text,
        "copied_at" timestamptz,
        "status" text NOT NULL DEFAULT 'active',
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_client_scenario" ON "client_scenario" ("tenant_id", "slug")`);
    await q.query(`CREATE INDEX "ix_client_scenario_class" ON "client_scenario" ("tenant_id", "client_equipment_class_slug")`);

    for (const table of this.tenantTables) {
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
      await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "ta_app"`);
    }

    // Templates become writable through the API. See the class comment for why this
    // reverses the earlier decision, and why DELETE is still withheld.
    await q.query(`GRANT INSERT, UPDATE ON "equipment_class_profile" TO "ta_app"`);
    await q.query(`GRANT INSERT, UPDATE ON "scenario_definition" TO "ta_app"`);
    // Aliases are the exception: an alias is a fact about a device family, and a
    // wrong one is better removed than left as a row that silently mis-resolves
    // every reading from that logger.
    await q.query(`GRANT INSERT, UPDATE, DELETE ON "signal_alias" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE INSERT, UPDATE ON "equipment_class_profile" FROM "ta_app"`);
    await q.query(`REVOKE INSERT, UPDATE ON "scenario_definition" FROM "ta_app"`);
    await q.query(`REVOKE INSERT, UPDATE, DELETE ON "signal_alias" FROM "ta_app"`);

    for (const table of [...this.tenantTables].reverse()) {
      await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
