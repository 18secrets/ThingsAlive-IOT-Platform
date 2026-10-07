import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A class that exists only for the demo seeder, marked in the schema (task QSEED1 §3).
 *
 * The published library holds no sensor requirements, layouts, alert rule templates or
 * baseline formulas, so a demo seeded against it is six identical `not_configured`
 * machines. The seeder therefore authors one complete class of its own. That is only
 * safe if the class cannot be mistaken for library content and cannot reach a real
 * tenant — so both are enforced here, not by a naming convention a later import could
 * happen to match:
 *
 *  - `seed_only` on the class. Library content is never `seed_only`; the default says so.
 *  - Granting a `seed_only` class is refused by the database unless the granting
 *    session has set `ta.seed_demo = on` — which `EntitlementService` does only when
 *    `SEED_DEMO_ENABLED=true`, the same guard that protects the seeder. A service check
 *    alone would be one forgotten code path away from a real tenant holding it.
 *  - `seed:demo:reset` must be able to remove the class after it was published, and
 *    published content refuses DELETE (`ck_class_content_draft_only`). The exemption is
 *    DELETE only, only for `seed_only`, and only from a session carrying `ta.seed_demo`
 *    — the same condition as the grant guard, so published content stays undeletable by
 *    everything except the seeder's reset. An edit is still refused for every class,
 *    this one included, because a tenant's copy was made from it.
 *
 * `ck_seed_only_grant` is SECURITY DEFINER with a pinned search_path. Measured at the
 * time of writing: neither `equipment_class_profile` nor `client_catalog_entitlement`
 * has row-level security (`relrowsecurity = false`, no policies) and `ta_app` can read
 * the class table, so its EXISTS sees the row from any session today. It is definer
 * anyway because a guard that reads under the caller's role fails *open* the day the
 * class table gains a policy: the row becomes invisible, EXISTS is false, and the grant
 * goes through. A guard described as "the database refuses this" has to refuse it
 * whatever policies arrive later.
 */
export class SeedOnlyClass1758900000000 implements MigrationInterface {
  name = 'SeedOnlyClass1758900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "equipment_class_profile" ADD COLUMN "seed_only" boolean NOT NULL DEFAULT false`);

    await q.query(`
      CREATE OR REPLACE FUNCTION "ck_class_content_draft_only"() RETURNS trigger AS $$
      DECLARE
        version_status text;
        is_seed_only boolean;
      BEGIN
        SELECT ecp."status", ecp."seed_only" INTO version_status, is_seed_only
          FROM "equipment_class_profile" ecp
          WHERE ecp."slug" = OLD."class_slug" AND ecp."version" = OLD."class_version";
        IF TG_OP = 'DELETE' AND is_seed_only
           AND coalesce(current_setting('ta.seed_demo', true), '') = 'on' THEN
          RETURN OLD;
        END IF;
        IF version_status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION
            '% on %/% refused: that class version is "%", and only a draft may change (ck_class_content_draft_only)',
            TG_OP, OLD."class_slug", OLD."class_version", version_status;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql`);

    await q.query(`
      CREATE FUNCTION "ck_seed_only_grant"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        -- On slug alone, not slug + version, deliberately: if any version of a slug is
        -- seed-only, every grant of that slug is refused. It over-blocks rather than
        -- under-blocks — a library class that later reused this slug would be refused
        -- here, by name, rather than one seed-only version slipping through.
        IF NEW."revoked_at" IS NULL
          AND EXISTS (SELECT 1 FROM "equipment_class_profile"
                       WHERE "slug" = NEW."equipment_class_slug" AND "seed_only")
          AND coalesce(current_setting('ta.seed_demo', true), '') <> 'on' THEN
          RAISE EXCEPTION
            'Granting "%" to % refused: it is a seed-only class, grantable only by the demo seeder (ck_seed_only_grant)',
            NEW."equipment_class_slug", NEW."tenant_id";
        END IF;
        RETURN NEW;
      END;
      $$`);
    await q.query(`
      CREATE TRIGGER "trg_seed_only_grant"
        BEFORE INSERT OR UPDATE ON "client_catalog_entitlement"
        FOR EACH ROW EXECUTE FUNCTION "ck_seed_only_grant"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_seed_only_grant" ON "client_catalog_entitlement"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_seed_only_grant"()`);
    // Back to LibraryContent1758100000000's body exactly: no exemption for anybody.
    // That is the right body to restore because it is the only other definition there
    // has ever been — checked when this was written: `CREATE [OR REPLACE] FUNCTION
    // ck_class_content_draft_only` appears in 1758100000000 and here, nowhere else on
    // main or on any open branch (PageLayout and ClassVisuals only attach triggers to
    // it). A later migration that redefines it must move this down path with it.
    await q.query(`
      CREATE OR REPLACE FUNCTION "ck_class_content_draft_only"() RETURNS trigger AS $$
      DECLARE
        version_status text;
      BEGIN
        SELECT ecp."status" INTO version_status
          FROM "equipment_class_profile" ecp
          WHERE ecp."slug" = OLD."class_slug" AND ecp."version" = OLD."class_version";
        IF version_status IS DISTINCT FROM 'draft' THEN
          RAISE EXCEPTION
            '% on %/% refused: that class version is "%", and only a draft may change (ck_class_content_draft_only)',
            TG_OP, OLD."class_slug", OLD."class_version", version_status;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`ALTER TABLE "equipment_class_profile" DROP COLUMN IF EXISTS "seed_only"`);
  }
}
