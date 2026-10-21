import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One phone number, one person (dashboard testing, issue 1).
 *
 * Testing found two people could be given the same mobile number. A phone identifies
 * a person the way an email does, and `app_user.email` is already unique across the
 * platform, so the phone follows it. The same shape as `LoginEmailUnclaimed`, for
 * the same reasons:
 *
 *  - only a new or changed number is checked, so the migration applies over numbers
 *    that already repeat, and those rows can still be edited;
 *  - writers of one number are serialised on an advisory lock, so two at once cannot
 *    both pass the check;
 *  - the check runs with `ta.bypass` on, because the other holder is usually in
 *    another account and row-level security would hide them.
 *
 * Numbers written before the services normalised them may still carry spaces or
 * dashes, so both sides are compared with those stripped.
 */
export class PhoneUnclaimed1759700000000 implements MigrationInterface {
  name = 'PhoneUnclaimed1759700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION ck_app_user_phone_unclaimed() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE wanted text;
      BEGIN
        IF NEW.phone IS NULL OR (TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone) THEN
          RETURN NEW;
        END IF;
        wanted := regexp_replace(NEW.phone, '[[:space:]().-]', '', 'g');
        PERFORM pg_advisory_xact_lock(hashtextextended('login-phone:' || wanted, 0));
        IF EXISTS (
          SELECT 1 FROM app_user
           WHERE id <> NEW.id AND phone IS NOT NULL
             AND regexp_replace(phone, '[[:space:]().-]', '', 'g') = wanted
        ) THEN
          RAISE EXCEPTION '% already belongs to somebody else.', NEW.phone
            USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_app_user_phone';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_app_user_phone_unclaimed BEFORE INSERT OR UPDATE OF phone
      ON app_user FOR EACH ROW EXECUTE FUNCTION ck_app_user_phone_unclaimed()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER trg_app_user_phone_unclaimed ON app_user`);
    await q.query(`DROP FUNCTION ck_app_user_phone_unclaimed()`);
  }
}
