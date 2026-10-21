import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `seed:demo:reset` can remove the demo tenant's parameters (D-005, phase 1 manual
 * testing).
 *
 * `tenant_parameter` is append-only, and rightly: a cost that was in force last month
 * is evidence, and a change is a new row. But the trigger refused DELETE without
 * exception, so once a tester set one parameter in the demo (test B12 does) the reset
 * could not remove the tenant at all — it rolled back whole, and the demo could never
 * be re-seeded.
 *
 * The exemption is the one `ck_class_content_draft_only` already makes for seed-only
 * class content, and as narrow: DELETE only — UPDATE is still refused for everybody —
 * only from a session carrying `ta.seed_demo = on`, which only the seeder sets, and
 * only for a tenant the seeder provisioned (`tenant.provisioned_by = 'seed-demo'`). A
 * real tenant's parameters stay undeletable by every session, the seeder's included.
 *
 * SECURITY DEFINER with a pinned search_path, for the reason `ck_seed_only_grant` is:
 * the `tenant` lookup must see the row whatever policies arrive on that table later. A
 * guard that reads under the caller's role fails open the day the row is hidden from it.
 */
export class SeedDemoParameterReset1759200000000 implements MigrationInterface {
  name = 'SeedDemoParameterReset1759200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION "tenant_parameter_append_only"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          AND coalesce(current_setting('ta.seed_demo', true), '') = 'on'
          AND EXISTS (SELECT 1 FROM "tenant" WHERE "tenant_id" = OLD."tenant_id" AND "provisioned_by" = 'seed-demo') THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'tenant_parameter is append-only: record a change as a new row with a later effective_from (tenant_parameter_append_only)';
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Back to TenantParameters1758400000000's body exactly: no exemption, invoker
    // rights. Checked when this was written: that migration and this one are the only
    // definitions of this function on main.
    await q.query(`
      CREATE OR REPLACE FUNCTION "tenant_parameter_append_only"() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER AS $$
      BEGIN
        RAISE EXCEPTION 'tenant_parameter is append-only: record a change as a new row with a later effective_from (tenant_parameter_append_only)';
      END $$`);
    await q.query(`ALTER FUNCTION "tenant_parameter_append_only"() RESET search_path`);
  }
}
