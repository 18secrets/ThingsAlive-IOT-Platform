import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An account always keeps at least one ceo-manager.
 *
 * `ProvisioningService.superAdminsFor` finds "the" Super Admin for Master Admin's
 * Clients list by convention, not a flag: whoever holds the `ceo-manager` role slug.
 * Nothing stopped that role being reassigned away from somebody with no one else
 * holding it — which is exactly what happened to cemindia and tata-motors, each left
 * with a single user reassigned to `operator` / `site-manager`. The account then has
 * nobody with `user.manage`/`role.manage`, so it cannot fix itself, and Master Admin
 * has no route into another tenant's identities to fix it either (see
 * ClientUsersPage's own comment on that boundary) — the only way back was a direct
 * database correction.
 *
 * A service check in `UserService.setRole` loses to a concurrent write: two requests
 * each demoting a different one of a tenant's last two ceo-managers would each read
 * the other as still holding the role and both commit, leaving zero. The trigger's
 * `FOR SHARE` read of the tenant's other ceo-manager rows forces the second commit to
 * wait for the first, then see its write and refuse — same pairing as
 * SensorRetirement's category/sensor guard.
 */
export class SuperAdminRetention1758610000000 implements MigrationInterface {
  name = 'SuperAdminRetention1758610000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION "ck_app_user_ceo_manager_retained"() RETURNS trigger AS $$
      DECLARE
        remaining int;
      BEGIN
        IF NEW."role_slug" = 'ceo-manager' OR OLD."role_slug" != 'ceo-manager' THEN
          RETURN NEW;
        END IF;

        -- Postgres refuses FOR SHARE combined with an aggregate, so the lock and the
        -- count are two statements: the PERFORM blocks on another concurrent demotion
        -- in this tenant until it commits or rolls back, then the count re-reads
        -- under a fresh snapshot and sees its outcome.
        PERFORM 1 FROM "app_user"
          WHERE "tenant_id" = OLD."tenant_id" AND "role_slug" = 'ceo-manager' AND "id" != OLD."id"
          FOR SHARE;

        SELECT count(*) INTO remaining FROM "app_user"
          WHERE "tenant_id" = OLD."tenant_id" AND "role_slug" = 'ceo-manager' AND "id" != OLD."id";

        IF remaining = 0 THEN
          RAISE EXCEPTION
            'account "%" would be left with no ceo-manager: "%" is its last one (ck_app_user_ceo_manager_retained)',
            OLD."tenant_id", OLD."full_name";
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_app_user_ceo_manager_retained"
        BEFORE UPDATE OF "role_slug" ON "app_user"
        FOR EACH ROW EXECUTE FUNCTION "ck_app_user_ceo_manager_retained"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_app_user_ceo_manager_retained" ON "app_user"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_app_user_ceo_manager_retained"()`);
  }
}
