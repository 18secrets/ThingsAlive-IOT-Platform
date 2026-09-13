import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The account itself (task P1-89).
 *
 * A tenant has been a string in a column since the first migration: every table is
 * narrowed by it and nothing describes it. This is the table that says what a
 * customer is called, what they bought, and whether they are still entitled to
 * anything — the last of which is a commercial lever the platform did not have.
 *
 * The primary key is called `tenant_id` rather than `id`, which reads oddly here and
 * is deliberate. The derived coverage check finds every table with a `tenant_id`
 * column and asserts it has an isolation policy; calling this one `id` would have
 * made it the single table protected by hand and watched by nothing, which is the
 * arrangement that check exists to prevent.
 */
export class Tenancy1757750000000 implements MigrationInterface {
  name = 'Tenancy1757750000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tenant" (
        "tenant_id" text PRIMARY KEY,
        "name" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "plan" text,
        "region" text,
        "suspended_at" timestamptz,
        "suspended_reason" text,
        "provisioned_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_tenant_status" ON "tenant" ("status")`);
    await q.query(`
      ALTER TABLE "tenant" ADD CONSTRAINT "ck_tenant_status"
        CHECK ("status" IN ('active', 'suspended'))`);
    // The shape of a tenant id, enforced where it cannot be argued with. It appears in
    // every row of every table and inside the isolation predicate itself, so it is the
    // one identifier here that can never be corrected after the fact.
    await q.query(`
      ALTER TABLE "tenant" ADD CONSTRAINT "ck_tenant_id_shape"
        CHECK ("tenant_id" ~ '^[a-z0-9][a-z0-9-]{1,62}$')`);

    await q.query(`ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY`);
    // A customer may read their own account row — the name on the screen comes from
    // it, and so does the reason they are locked out.
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "tenant"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    // No delete. An account with data in twenty other tables cannot be removed by
    // deleting one row, and offering the option would produce orphans rather than a
    // clean removal. Closing an account is a suspension plus a retention decision.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "tenant" TO "ta_app"`);

    // tenant_map was read-only to the application, because until now the only thing
    // that wrote it was a seed script. Provisioning writes it: an account without its
    // upstream client mapping exists and then watches every machine belonging to it
    // arrive as a projection rejection. Still no update or delete — repointing a
    // client at a different account silently moves a customer's data and is not
    // something a request should be able to do.
    await q.query(`GRANT INSERT ON "tenant_map" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE INSERT ON "tenant_map" FROM "ta_app"`);
    await q.query(`DROP TABLE IF EXISTS "tenant"`);
  }
}
