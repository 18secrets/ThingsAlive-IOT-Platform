import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The fault code library, step 2 (17 Nov 2026): Master Admin edits the codes 2.0 owns,
 * and every edit is written down.
 *
 * - `fault_code_revision` holds one row per changed field: which code, the old value,
 *   the new, who and when. The application may add rows and never change or remove one
 *   (it is granted INSERT and SELECT only), so the history cannot be tidied after the fact.
 * - `dtc_master_catalog` gains `retired_at`, for a vehicle code 2.0 added and later stops
 *   using; motor codes had it already.
 * - Who may write a vehicle row is held by the database, not by which routes exist. A
 *   1.0 row is written only by the daily copy from 1.0, which says so for its own
 *   transaction (`ta.fault_code_sync`); a 2.0 row only by anything else. A row cannot
 *   change hands, and no vehicle row is deleted — a code is retired, because fault
 *   history still points at it. A service check alone loses to the next writer that
 *   forgets it; this one does not.
 */
export class FaultCodeEditing1765400000000 implements MigrationInterface {
  name = 'FaultCodeEditing1765400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "fault_code_revision" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "library" text NOT NULL,
        "code_id" uuid NOT NULL,
        "code" text NOT NULL,
        "field" text NOT NULL,
        "old_value" text,
        "new_value" text,
        "changed_by" text NOT NULL,
        "changed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_fault_code_revision_library" CHECK ("library" IN ('vehicle', 'motor'))
      )`);
    await q.query(`CREATE INDEX "ix_fault_code_revision_code" ON "fault_code_revision" ("library", "code_id", "changed_at" DESC)`);
    await q.query(`GRANT SELECT, INSERT ON "fault_code_revision" TO "ta_app"`);

    await q.query(`GRANT INSERT, UPDATE ON "fault_code_motor" TO "ta_app"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD COLUMN "retired_at" timestamptz`);

    await q.query(`
      CREATE FUNCTION dtc_master_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        syncing boolean := coalesce(current_setting('ta.fault_code_sync', true), '') = 'on';
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'vehicle fault code % is retired, not deleted: fault history still points at it', OLD.code
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.source_system IS DISTINCT FROM OLD.source_system THEN
          RAISE EXCEPTION 'vehicle fault code % cannot change hands (% to %)', OLD.code, OLD.source_system, NEW.source_system
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        IF NEW.source_system = '1.0' AND NOT syncing THEN
          RAISE EXCEPTION 'vehicle fault code % is 1.0''s: only the daily copy from 1.0 writes it', NEW.code
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        IF NEW.source_system = '2.0' AND syncing THEN
          RAISE EXCEPTION 'vehicle fault code % is 2.0''s: the copy from 1.0 may not write it', NEW.code
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "dtc_master_owner_guard" BEFORE INSERT OR UPDATE OR DELETE ON "dtc_master_catalog"
        FOR EACH ROW EXECUTE FUNCTION dtc_master_owner_guard()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "dtc_master_owner_guard" ON "dtc_master_catalog"`);
    await q.query(`DROP FUNCTION IF EXISTS dtc_master_owner_guard()`);
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP COLUMN IF EXISTS "retired_at"`);
    await q.query(`REVOKE INSERT, UPDATE ON "fault_code_motor" FROM "ta_app"`);
    await q.query(`DROP TABLE IF EXISTS "fault_code_revision"`);
  }
}
