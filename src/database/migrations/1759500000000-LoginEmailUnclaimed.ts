import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One email, one login — across client users and Things Alive staff.
 *
 * `app_user.email` and `platform_user.email` were each unique on their own, and
 * nothing stopped the same address landing in both. Sign-in then had to pick one:
 * `AuthController.signIn` asks for a staff credential first, so whichever person
 * held the client login could never get in again, with nothing on screen saying why.
 * Dashboard testing found it from both directions — client first, then staff, and
 * the reverse.
 *
 * A unique index cannot span two tables, so a trigger on each refuses an email the
 * other table already holds. Two things make it hold rather than merely look right:
 *
 *  - Same-address writers are serialised on an advisory lock keyed by the email. Two
 *    transactions inserting the same address into different tables would otherwise
 *    each check, each find nothing uncommitted, and both commit. The lock makes the
 *    second wait for the first, then see its row.
 *  - The check runs as the function owner with `ta.bypass` on. `app_user` is
 *    row-level-security protected and a staff invitation carries no tenant, so a
 *    check run as `ta_app` would read zero client users and pass every time.
 *
 * Rows that already clash are left alone. Only a new address, or a changed one, is
 * checked, so this migration applies to a database that already has duplicates
 * (Development has at least one) and the existing pair can still be edited and
 * suspended. Cleaning them up is a data decision, not a schema one.
 *
 * The refusal is raised as a unique violation naming `uq_login_email`, so the
 * services map it the same way they would map a real unique index.
 */
export class LoginEmailUnclaimed1759500000000 implements MigrationInterface {
  name = 'LoginEmailUnclaimed1759500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION ck_login_email_unclaimed() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE clash boolean;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email THEN
          RETURN NEW;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('login-email:' || NEW.email, 0));
        IF TG_TABLE_NAME = 'app_user' THEN
          SELECT EXISTS (SELECT 1 FROM platform_user WHERE email = NEW.email) INTO clash;
        ELSE
          SELECT EXISTS (SELECT 1 FROM app_user WHERE email = NEW.email) INTO clash;
        END IF;
        IF clash THEN
          RAISE EXCEPTION '% already has a login.', NEW.email
            USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_login_email';
        END IF;
        RETURN NEW;
      END $$`);
    for (const table of ['app_user', 'platform_user']) {
      await q.query(`CREATE TRIGGER trg_login_email_unclaimed BEFORE INSERT OR UPDATE OF email
        ON "${table}" FOR EACH ROW EXECUTE FUNCTION ck_login_email_unclaimed()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['app_user', 'platform_user']) {
      await q.query(`DROP TRIGGER trg_login_email_unclaimed ON "${table}"`);
    }
    await q.query(`DROP FUNCTION ck_login_email_unclaimed()`);
  }
}
