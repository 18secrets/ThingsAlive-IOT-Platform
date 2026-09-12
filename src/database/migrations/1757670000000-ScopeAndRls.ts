import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Row-level security on the tenant-owned tables, and the platform access log
 * (tasks P1-53 and P1-59).
 *
 * The application already filters by tenant through ScopedRepository. This is the
 * second layer, and the reason for a second layer is that the first one is code:
 * it gets refactored, copied from, and occasionally written in a hurry. A policy in
 * the database does not care how the query was assembled.
 *
 * FORCE is deliberate: without it the table owner is exempt, and the owner is
 * whoever the service connects as.
 *
 * That is still not enough. A superuser bypasses row-level security unconditionally,
 * FORCE included — and the default user on a managed Postgres (Railway's included)
 * is a superuser. A policy written and never exercised under a constrained role is
 * decorative: it passes review, it passes a test run by the same superuser, and it
 * protects nothing. So this migration also creates `ta_app`, an unprivileged role
 * with no bypass, and scoped sessions `SET LOCAL ROLE` to it. The login user can
 * stay whatever the platform hands out.
 */
export class ScopeAndRls1757670000000 implements MigrationInterface {
  name = 'ScopeAndRls1757670000000';

  /** Every table whose rows belong to one tenant. New tenant-owned tables join this list. */
  private readonly tables = [
    'equipment_projection',
    'device_projection',
    'sensor_map_projection',
    'telemetry_reading',
  ];

  public async up(q: QueryRunner): Promise<void> {
    // NOLOGIN: nothing connects as ta_app. Sessions switch into it, which means the
    // role needs no password and no credential to leak.
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ta_app') THEN
          CREATE ROLE "ta_app" NOLOGIN NOBYPASSRLS;
        END IF;
        -- The connecting user must be a member to SET ROLE into it. A superuser may
        -- anyway; an ordinary owner needs this and would otherwise fail at runtime
        -- rather than here, on the first request instead of the deploy.
        BEGIN
          EXECUTE format('GRANT "ta_app" TO %I', current_user);
        EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
          NULL;
        END;
      END
      $$`);

    await q.query(`
      CREATE TABLE "platform_access_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "at" timestamptz NOT NULL DEFAULT now(),
        "actor_user_id" text NOT NULL,
        "actor_roles" text[] NOT NULL DEFAULT '{}'::text[],
        "tenant_id" text,
        "tenant_ids" text[],
        "resource" text NOT NULL,
        "action" text NOT NULL,
        "reason" text,
        "method" text,
        "path" text
      )`);
    await q.query(`CREATE INDEX "ix_platform_access_tenant_at" ON "platform_access_log" ("tenant_id", "at")`);
    await q.query(`CREATE INDEX "ix_platform_access_actor_at" ON "platform_access_log" ("actor_user_id", "at")`);

    for (const table of this.tables) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      // `current_setting(..., true)` returns NULL rather than raising when the setting
      // is absent, and `tenant_id = NULL` is not true — so a connection that never set
      // a tenant reads nothing. That is the intended behaviour for code that bypassed
      // the repository: empty, not everything.
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

    // Read-only on the reference tables a scoped transaction may join against. No
    // write grant: a request-scoped session has no business editing the tenant map.
    await q.query(`GRANT USAGE ON SCHEMA public TO "ta_app"`);
    await q.query(`GRANT SELECT ON "tenant_map" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "projection_rejection" TO "ta_app"`);
    // Append-only by grant, not by convention: the application can write an access
    // record and read one back, and has no privilege that would let it edit or delete
    // the evidence of its own reads.
    await q.query(`GRANT SELECT, INSERT ON "platform_access_log" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [...this.tables].reverse()) {
      await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
      await q.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
    }
    await q.query(`DROP TABLE IF EXISTS "platform_access_log"`);

    // Privileges must go before the role does; Postgres refuses to drop a role that
    // still owns or is granted anything.
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ta_app') THEN
          EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "ta_app"';
          EXECUTE 'REVOKE ALL ON SCHEMA public FROM "ta_app"';
          DROP ROLE "ta_app";
        END IF;
      END
      $$`);
  }
}
