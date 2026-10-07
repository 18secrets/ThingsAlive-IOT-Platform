import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A site class that exists only for the demo seeder (D-004, phase 1 manual testing).
 *
 * The demo's site page used the platform `default` site class, which binds no KPI, so
 * site aggregation — `machinesIncluded` / `machinesExcluded`, `no_ready_machines` —
 * could not be seen anywhere a tester could look. Adding KPIs to `default` would put
 * them on every customer's site page; the seeder authors its own site class instead,
 * the same way it authors its own equipment class (`1758900000000-SeedOnlyClass.ts`),
 * and with the same protection:
 *
 *  - `seed_only` on the site class. Library content is never `seed_only`; the default says so.
 *  - A plant pointing at a `seed_only` site class is refused by the database unless the
 *    session has set `ta.seed_demo = on`, which only the seeder does. No route assigns a
 *    site class to a plant today; the guard is for the day one does, and for every path
 *    that writes a plant without going through a route.
 *
 * `ck_seed_only_site` is SECURITY DEFINER with a pinned search_path for the reason
 * `ck_seed_only_grant` is: a guard that reads under the caller's role fails open the
 * day `site_class` gains a row-level policy that hides the row.
 */
export class SeedOnlySiteClass1759100000000 implements MigrationInterface {
  name = 'SeedOnlySiteClass1759100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "site_class" ADD COLUMN "seed_only" boolean NOT NULL DEFAULT false`);

    await q.query(`
      CREATE FUNCTION "ck_seed_only_site"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        -- On slug alone, like ck_seed_only_grant: over-blocks rather than under-blocks.
        IF NEW."site_class_slug" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "site_class" WHERE "slug" = NEW."site_class_slug" AND "seed_only")
          AND coalesce(current_setting('ta.seed_demo', true), '') <> 'on' THEN
          RAISE EXCEPTION
            'Plant "%" of % refused: site class "%" is seed-only, usable only by the demo seeder (ck_seed_only_site)',
            NEW."code", NEW."tenant_id", NEW."site_class_slug";
        END IF;
        RETURN NEW;
      END;
      $$`);
    await q.query(`
      CREATE TRIGGER "trg_seed_only_site"
        BEFORE INSERT OR UPDATE OF "site_class_slug", "site_class_version" ON "plant"
        FOR EACH ROW EXECUTE FUNCTION "ck_seed_only_site"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_seed_only_site" ON "plant"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_seed_only_site"()`);
    await q.query(`ALTER TABLE "site_class" DROP COLUMN IF EXISTS "seed_only"`);
  }
}
