import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle fault codes are 2.0's own (17 Nov 2026). 1.0 will not be the source of vehicle
 * codes after all (Tapas, 17 Nov): the library is made here, from the engine makers'
 * sheets (the TMTL TREM4 DSM sheet, the P-code diagnosis guide), and the daily copy from
 * 1.0 stops.
 *
 * - The owner guard keeps its two lasting rules — no vehicle row is deleted (fault
 *   history points at it) and no row changes hands — and drops the two that made 1.0's
 *   rows writable only by the copy. The rows already copied stay, marked 1.0, and are
 *   edited here like any other; `source_system` now says where a code came from, not who
 *   may write it.
 * - Eight columns from those sheets, which a technician needs at the machine: the sensor,
 *   where it sits, its pins, its voltage and signal range, the checks before starting,
 *   the numbered troubleshooting steps, and what the ECU does to the vehicle meanwhile.
 *
 * No CHECK on the OBD-II code's shape: a code with its fault type (P0425-85) and one
 * without (P0119) are both real, and the service already says which shapes it takes.
 */
export class VehicleCodesOwned1765600000000 implements MigrationInterface {
  name = 'VehicleCodesOwned1765600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "dtc_master_catalog"
        ADD COLUMN "sensor" text,
        ADD COLUMN "location" text,
        ADD COLUMN "pin_details" text,
        ADD COLUMN "voltage_range" text,
        ADD COLUMN "signal_range" text,
        ADD COLUMN "diagnostic_aids" text,
        ADD COLUMN "troubleshooting" text,
        ADD COLUMN "vehicle_reaction" text`);
    await q.query(`
      CREATE OR REPLACE FUNCTION dtc_master_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'vehicle fault code % is retired, not deleted: fault history still points at it', OLD.code
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.source_system IS DISTINCT FROM OLD.source_system THEN
          RAISE EXCEPTION 'vehicle fault code % cannot change hands (% to %)', OLD.code, OLD.source_system, NEW.source_system
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_dtc_master_owner';
        END IF;
        RETURN NEW;
      END $$`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // FaultCodeEditing1765400000000's guard, as it was.
    await q.query(`
      CREATE OR REPLACE FUNCTION dtc_master_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      ALTER TABLE "dtc_master_catalog"
        DROP COLUMN "vehicle_reaction", DROP COLUMN "troubleshooting", DROP COLUMN "diagnostic_aids",
        DROP COLUMN "signal_range", DROP COLUMN "voltage_range", DROP COLUMN "pin_details",
        DROP COLUMN "location", DROP COLUMN "sensor"`);
  }
}
