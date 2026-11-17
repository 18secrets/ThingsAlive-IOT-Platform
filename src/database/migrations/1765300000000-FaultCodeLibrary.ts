import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The fault code library, step 1 (17 Nov 2026): vehicle codes and motor codes in tables of
 * their own, and which kinds of code each account is given.
 *
 * The two kinds are shaped differently. A vehicle code is 1.0's, copied daily: an SPN and
 * FMI, or an OBD-II code, and a dashboard lamp. A pump's P-code is 2.0's own: what the
 * technician sees (symptom), how it is found (the logger's rule, or a technician's test).
 * They shared one table only because the P-codes were the first 2.0 codes to arrive.
 *
 * - `dtc_master_catalog` stays the vehicle table, under its name: an existing spec reads
 *   it by that name. Its `source_system` says whose a row is, and from here may only be
 *   1.0 or 2.0 — the 1.0 copy and, later, codes 2.0 adds for its own vehicles.
 * - `fault_code_motor` is new (not `motor_…`: that prefix is the logger receiver's own
 *   tables), and the six P-codes move into it with the symptom and
 *   detection rule from the hardware team's P-code reference (30 Oct 2026).
 * - `fault_code_type_grant` says which kinds an account is given. Platform-owned like
 *   class entitlements: an account reads its own grants and can write none — the policy's
 *   WITH CHECK admits only the tenant-spanning session, so that is held by the database,
 *   not by a route that happens not to exist.
 *
 * Day-one grants keep every account seeing what it sees today: the vehicle kinds for an
 * account with a 1.0 device, the pump kind for an account with a pump logger or a motor
 * class. Nothing is taken away by deploying this.
 */
const MOTOR_DETAILS: readonly [code: string, symptom: string, detection: string][] = [
  ['P101', 'Slow start, humming, overheating, trips', 'Supply present but below 190 V, three readings in a row'],
  ['P102', 'Overheating, winding stress, capacitor failure', 'Supply above 250 V, three readings in a row'],
  ['P207', 'Thermal trips, short life', 'Estimated motor temperature above 70 °C, three readings in a row'],
  ['P401', 'Runs, but no water; overheating', 'Running current below 80% of rated, not in the 5 s after a start'],
  ['P702', 'Current well above rated while the pump still delivers water', 'Running current above 120% of rated, not in the 5 s after a start'],
  ['P708', 'Motor hums; very high current and little or no water', 'Current still 3 × rated or more after the 5 s start'],
];

export class FaultCodeLibrary1765300000000 implements MigrationInterface {
  name = 'FaultCodeLibrary1765300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "fault_code_motor" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" text NOT NULL,
        "description" text NOT NULL,
        "symptom" text,
        "causes" text,
        "remedies" text,
        "detection" text,
        "found_by" text,
        "severity" text NOT NULL DEFAULT 'medium',
        "lamp" text NOT NULL DEFAULT 'none',
        "retired_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" text,
        CONSTRAINT "uq_motor_fault_code" UNIQUE ("code"),
        -- The pump guide's own shape: P, then three digits, the first naming the area.
        CONSTRAINT "ck_motor_fault_code_code" CHECK ("code" ~ '^P[0-9]{3}$'),
        CONSTRAINT "ck_motor_fault_code_description" CHECK (length(btrim("description")) > 0),
        CONSTRAINT "ck_motor_fault_code_found_by" CHECK ("found_by" IS NULL OR "found_by" IN ('logger', 'technician')),
        CONSTRAINT "ck_motor_fault_code_severity" CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
        CONSTRAINT "ck_motor_fault_code_lamp" CHECK ("lamp" IN ('red_stop', 'amber_warning', 'protect', 'mil', 'none'))
      )`);
    await q.query(`GRANT SELECT ON "fault_code_motor" TO "ta_app"`);

    // The P-codes move, carrying the text they had and gaining what the table adds.
    await q.query(`
      INSERT INTO "fault_code_motor" ("code", "description", "causes", "remedies", "severity", "lamp", "found_by", "updated_by")
      SELECT "code", "description", "causes", "remedies", "severity", "lamp", 'logger', 'migration'
        FROM "dtc_master_catalog" WHERE "protocol" = 'pcode'`);
    for (const [code, symptom, detection] of MOTOR_DETAILS) {
      await q.query(`UPDATE "fault_code_motor" SET "symptom" = $2, "detection" = $3 WHERE "code" = $1`, [code, symptom, detection]);
    }
    await q.query(`DELETE FROM "dtc_master_catalog" WHERE "protocol" = 'pcode'`);

    // The vehicle table holds vehicle codes, each 1.0's or 2.0's.
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP CONSTRAINT "ck_dtc_master_protocol"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD CONSTRAINT "ck_dtc_master_protocol" CHECK ("protocol" IN ('j1939', 'obd2'))`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD CONSTRAINT "ck_dtc_master_source" CHECK ("source_system" IN ('1.0', '2.0'))`);

    await q.query(`
      CREATE TABLE "fault_code_type_grant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "code_type" text NOT NULL,
        "granted_by" text NOT NULL,
        "granted_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revoked_by" text,
        "note" text,
        -- One row per account and kind: a revoked grant comes back by reusing it, so an
        -- account keeps one history per kind, as class entitlements do.
        CONSTRAINT "uq_fault_code_type_grant" UNIQUE ("tenant_id", "code_type"),
        CONSTRAINT "ck_fault_code_type_grant_type" CHECK ("code_type" IN ('vehicle-j1939', 'vehicle-obd2', 'motor-pump')),
        CONSTRAINT "ck_fault_code_type_grant_revoked" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
      )`);
    await q.query(`ALTER TABLE "fault_code_type_grant" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "fault_code_type_grant" FORCE ROW LEVEL SECURITY`);
    // Read: the account's own rows. Write: the tenant-spanning session only — what an
    // account has been given is not the account's to change.
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "fault_code_type_grant"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on')`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "fault_code_type_grant" TO "ta_app"`);

    // Day one: what each account sees today, it still sees.
    await q.query(`
      INSERT INTO "fault_code_type_grant" ("tenant_id", "code_type", "granted_by", "note")
      SELECT DISTINCT d."tenant_id", t."code_type", 'migration', 'Day one: the account had a 1.0 device'
        FROM "device_projection" d
        CROSS JOIN (VALUES ('vehicle-j1939'), ('vehicle-obd2')) AS t("code_type")
       WHERE d."tenant_id" IS NOT NULL AND d."imei" IS NOT NULL AND d."imei" <> ''
      ON CONFLICT DO NOTHING`);
    await q.query(`
      INSERT INTO "fault_code_type_grant" ("tenant_id", "code_type", "granted_by", "note")
      SELECT DISTINCT a."tenant_id", 'motor-pump', 'migration', 'Day one: the account had a pump logger or a motor class'
        FROM (
          SELECT i."tenant_id" FROM "device_inventory" i
           WHERE i."tenant_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "motor_upload_log" u WHERE u."device_id" = i."imei")
          UNION
          SELECT e."tenant_id" FROM "client_catalog_entitlement" e
           WHERE e."revoked_at" IS NULL AND e."equipment_class_slug" IN ('monoblock-pump-1ph', 'induction-motor-1ph')
        ) a
      ON CONFLICT DO NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "fault_code_type_grant"`);
    // Codes 2.0 added for its own vehicles have no home before this migration.
    await q.query(`DELETE FROM "dtc_master_catalog" WHERE "source_system" = '2.0'`);
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP CONSTRAINT "ck_dtc_master_source"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP CONSTRAINT "ck_dtc_master_protocol"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD CONSTRAINT "ck_dtc_master_protocol" CHECK ("protocol" IN ('j1939', 'obd2', 'pcode'))`);
    // The P-codes go back where MotorPCodes put them; what only this table could hold
    // (symptom, detection, found by) goes with the table.
    await q.query(`
      INSERT INTO "dtc_master_catalog" ("protocol", "code", "description", "lamp", "severity", "causes", "remedies", "source_system")
      SELECT 'pcode', "code", "description", "lamp", "severity", "causes", "remedies", 'pump-logger'
        FROM "fault_code_motor"
      ON CONFLICT ("protocol", "code") DO NOTHING`);
    await q.query(`DROP TABLE IF EXISTS "fault_code_motor"`);
  }
}
