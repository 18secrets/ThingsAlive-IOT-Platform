import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Diagnostic Trouble Code (DTC) master catalog and stateful device episodes.
 *
 * Grants on 1.0 allow read-only access to device_telemetry_packets and dtc_master.
 * 2.0 tracks active diagnostic episodes per machine with debounced clearing rules:
 * - A code absent from later packets is only cleared after consecutive packet confirmation
 *   or active time-window threshold (prevents flapping/chattering on frame drops).
 * - Key-off / engine-off pauses preserve active episodes rather than falsely clearing them.
 * - Cleared episodes remain in history for 90 days (matching telemetry partition retention)
 *   before cold archival.
 *
 * Automatic alerts: Red Stop Lamp / Protect Lamp (or critical severity) raise platform
 * incidents automatically. Amber Warning Lamp and advisory codes populate device health
 * and trigger alerts only when matching configured alert rules.
 */
export class DtcDiagnostics1764600000000 implements MigrationInterface {
  name = 'DtcDiagnostics1764600000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Global DTC Master Catalog (mirrored reference from 1.0 dtc_master / dtcc_error_code)
    await q.query(`
      CREATE TABLE IF NOT EXISTS "dtc_master_catalog" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "protocol" text NOT NULL,
        "code" text NOT NULL,
        "spn" integer,
        "fmi" integer,
        "description" text NOT NULL,
        "lamp" text DEFAULT 'none',
        "severity" text NOT NULL DEFAULT 'medium',
        "causes" text,
        "remedies" text,
        "source_system" text NOT NULL DEFAULT '1.0',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_dtc_master_protocol" CHECK ("protocol" IN ('j1939', 'obd2')),
        CONSTRAINT "ck_dtc_master_severity" CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
        CONSTRAINT "uq_dtc_master_protocol_code" UNIQUE ("protocol", "code")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_dtc_master_spn_fmi" ON "dtc_master_catalog" ("spn", "fmi") WHERE "spn" IS NOT NULL`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "dtc_master_catalog" TO "ta_app"`);

    // 2. Tenant-scoped Device DTC Episodes (active and cleared fault history)
    await q.query(`
      CREATE TABLE IF NOT EXISTS "device_dtc_episode" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL DEFAULT 'ta-2.0',
        "external_id" text NOT NULL,
        "imei" text NOT NULL,
        "protocol" text NOT NULL,
        "code" text NOT NULL,
        "spn" integer,
        "fmi" integer,
        "lamp_status" text NOT NULL DEFAULT 'none',
        "severity" text NOT NULL DEFAULT 'medium',
        "status" text NOT NULL DEFAULT 'active',
        "first_seen_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "cleared_at" timestamptz,
        "occurrences" integer NOT NULL DEFAULT 1,
        "consecutive_missing_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_device_dtc_episode_protocol" CHECK ("protocol" IN ('j1939', 'obd2')),
        CONSTRAINT "ck_device_dtc_episode_status" CHECK ("status" IN ('active', 'cleared')),
        CONSTRAINT "ck_device_dtc_episode_severity" CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
        CONSTRAINT "ck_device_dtc_episode_lamp" CHECK ("lamp_status" IN ('red_stop', 'amber_warning', 'protect', 'mil', 'none'))
      )`);

    await q.query(`CREATE INDEX IF NOT EXISTS "ix_device_dtc_episode_tenant_active" ON "device_dtc_episode" ("tenant_id", "external_id", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_device_dtc_episode_lookup" ON "device_dtc_episode" ("tenant_id", "external_id", "code", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_device_dtc_episode_history" ON "device_dtc_episode" ("tenant_id", "external_id", "first_seen_at" DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_device_dtc_episode_prune" ON "device_dtc_episode" ("cleared_at") WHERE "status" = 'cleared'`);

    await q.query(`ALTER TABLE "device_dtc_episode" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "device_dtc_episode" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "device_dtc_episode"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "device_dtc_episode" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "device_dtc_episode"`);
    await q.query(`DROP TABLE IF EXISTS "dtc_master_catalog"`);
  }
}
