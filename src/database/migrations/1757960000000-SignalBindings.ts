import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The signal binding layer: what closes the gap between "a reading arrived" and
 * "this machine has this signal" (task Q08S).
 *
 * Until now equipment-to-signal was inferred at query time — the device claim in
 * `device_inventory`, plus a string match on `telemetry_reading.signal`. That holds
 * right up until a machine has two probes of the same kind, a sensor is replaced
 * mid-history, a unit differs per device, or a value is ECU-derived with no physical
 * sensor. It also makes absence unreadable: no reading for `coolant_temp_c` could mean
 * not fitted, not mapped, or fitted and silent, and readiness cannot honestly tell
 * those apart while they look identical in the data.
 *
 * `sensor_map_projection` is not altered. It is a read-only mirror of the upstream
 * sensor map, and a 2.0 column inside a mirror leaves the next full reconcile unable to
 * tell upstream drift from a local edit — the same reason `equipment_profile` sits
 * beside `equipment_projection` rather than inside it.
 *
 * Nothing here duplicates device-catalog. `sensor` is the sensor definition and
 * `sensor_instance` references it; `tool_mapping` stays the device profile's expected
 * channel list and is read, never copied.
 */
export class SignalBindings1757960000000 implements MigrationInterface {
  name = 'SignalBindings1757960000000';

  public async up(q: QueryRunner): Promise<void> {
    // Needed to mix equality columns with a range in one exclusion constraint.
    await q.query(`CREATE EXTENSION IF NOT EXISTS "btree_gist"`);

    // ------------------------------------------------------------------ calibration
    await q.query(`
      CREATE TABLE "calibration_version" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "method" text NOT NULL,
        "points" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "raw_unit" text,
        "reference_unit" text,
        "basis" text,
        "performed_at" timestamptz,
        "effective_from" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz,
        "certificate_ref" text,
        "uncertainty" double precision,
        "approved_by" text,
        "approved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      ALTER TABLE "calibration_version" ADD CONSTRAINT "ck_calibration_method"
        CHECK ("method" IN ('identity', 'two_point', 'multipoint'))`);
    // Identity is the dangerous one: it silently means "raw equals canonical". It is
    // acceptable only where somebody recorded WHY — an approved factory or ECU basis —
    // and never as the default that happens when nobody filled the form in.
    await q.query(`
      ALTER TABLE "calibration_version" ADD CONSTRAINT "ck_calibration_identity_basis"
        CHECK ("method" <> 'identity' OR ("basis" IS NOT NULL AND length(btrim("basis")) > 0))`);
    await q.query(`CREATE INDEX "ix_calibration_version_tenant" ON "calibration_version" ("tenant_id")`);

    // -------------------------------------------------------------- sensor instance
    // A definition from device-catalog, fitted at a position on one machine.
    await q.query(`
      CREATE TABLE "sensor_instance" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "sensor_id" uuid NOT NULL REFERENCES "sensor" ("id"),
        "component_id" text NOT NULL DEFAULT '',
        "position" text,
        "serial" text,
        "installed_at" timestamptz,
        "calibration_requirement" text,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sensor_instance_equipment"
          FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id")
          ON DELETE CASCADE
      )`);
    await q.query(`
      CREATE INDEX "ix_sensor_instance_equipment"
        ON "sensor_instance" ("tenant_id", "source_system", "external_id")`);

    // -------------------------------------------------------------- signal bindings
    await q.query(`
      CREATE TABLE "signal_binding_version" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "signal_key" text NOT NULL,
        "measurement_role" text NOT NULL,
        -- '' is the machine itself. NOT NULL on purpose: a NULL here would never
        -- compare equal in the exclusion constraint below, so two whole-machine
        -- primaries for the same signal would both be allowed.
        "component_id" text NOT NULL DEFAULT '',
        "origin" text NOT NULL,
        "imei" text,
        "channel" text,
        "sensor_instance_id" uuid REFERENCES "sensor_instance" ("id"),
        "canonical_unit" text NOT NULL,
        "source_unit" text,
        "unit_transform_version" text,
        "calibration_version_id" uuid,
        "valid_from" timestamptz NOT NULL,
        "valid_to" timestamptz,
        "validity" tstzrange GENERATED ALWAYS AS
          (tstzrange("valid_from", "valid_to", '[)')) STORED,
        "expected_period_seconds" int,
        "freshness_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "quality_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "is_primary" boolean NOT NULL DEFAULT false,
        "status" text NOT NULL DEFAULT 'proposed',
        "discovered_from" uuid,
        "discovered_by" text NOT NULL DEFAULT 'manual',
        "approved_by" text,
        "approved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_signal_binding_equipment"
          FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_signal_binding_calibration"
          FOREIGN KEY ("calibration_version_id") REFERENCES "calibration_version" ("id")
      )`);

    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ck_signal_binding_origin"
        CHECK ("origin" IN ('physical', 'ecu_derived', 'virtual'))`);
    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ck_signal_binding_status"
        CHECK ("status" IN ('proposed', 'discovered_unreviewed', 'active', 'superseded', 'rejected'))`);
    // Provenance, because auto-approval keys off it rather than off what kind of thing
    // this is. A binding matched deterministically — the device profile says the channel
    // exists, the class declares the role, the units agree — may be activated by policy.
    // The same binding suggested by a model may not, ever.
    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ck_signal_binding_discovered_by"
        CHECK ("discovered_by" IN ('tool-mapping', 'sensor-map', 'both', 'manual', 'model'))`);
    // A virtual measure has no physical source; a physical one must say where it comes from.
    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ck_signal_binding_source"
        CHECK ("origin" = 'virtual' OR "imei" IS NOT NULL)`);
    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ck_signal_binding_validity"
        CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")`);

    // THE constraint this table exists for. Two candidate sensors for one role on one
    // machine must be resolved by somebody choosing, never by averaging them quietly or
    // by whichever row a query happened to return first. Enforced in the database rather
    // than in a service, because a service check loses to a concurrent insert.
    await q.query(`
      ALTER TABLE "signal_binding_version" ADD CONSTRAINT "ex_signal_binding_primary"
        EXCLUDE USING gist (
          "tenant_id" WITH =, "source_system" WITH =, "external_id" WITH =,
          "signal_key" WITH =, "component_id" WITH =, "validity" WITH &&
        ) WHERE ("is_primary" AND "status" = 'active')`);

    await q.query(`
      CREATE INDEX "ix_signal_binding_equipment"
        ON "signal_binding_version" ("tenant_id", "source_system", "external_id", "signal_key")`);
    // The read path: resolve a reading's IMEI and signal to the binding in force at the
    // moment the reading was taken.
    await q.query(`
      CREATE INDEX "ix_signal_binding_resolve"
        ON "signal_binding_version" ("tenant_id", "imei", "signal_key")`);

    // --------------------------------------------------------- approved scalar params
    // A formula's inputs are signals AND approved parameters. Usable-fuel runtime needs
    // a tank capacity; the service forecast needs an interval. Neither arrives as
    // telemetry, and an equipment_template's value is a proposal until somebody approves
    // it — a template revision must never silently rewrite a machine's approved capacity.
    await q.query(`
      CREATE TABLE "equipment_parameter" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "parameter_key" text NOT NULL,
        "value" double precision,
        "unit" text NOT NULL,
        "source" text NOT NULL,
        "source_ref" text,
        "status" text NOT NULL DEFAULT 'proposed',
        "approved_by" text,
        "approved_at" timestamptz,
        "version" int NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_equipment_parameter_equipment"
          FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id")
          ON DELETE CASCADE
      )`);
    await q.query(`
      ALTER TABLE "equipment_parameter" ADD CONSTRAINT "ck_equipment_parameter_status"
        CHECK ("status" IN ('proposed', 'approved', 'superseded', 'rejected'))`);
    await q.query(`
      ALTER TABLE "equipment_parameter" ADD CONSTRAINT "ck_equipment_parameter_source"
        CHECK ("source" IN ('equipment-template', 'class-default', 'manual', 'model'))`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_parameter_version"
        ON "equipment_parameter"
           ("tenant_id", "source_system", "external_id", "parameter_key", "version")`);
    // Exactly one approved value per parameter per machine. Two would mean a formula's
    // answer depends on which row it read.
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_parameter_approved"
        ON "equipment_parameter"
           ("tenant_id", "source_system", "external_id", "parameter_key")
        WHERE "status" = 'approved'`);

    // ---------------------------------------------------------------------------- RLS
    for (const table of [
      'calibration_version', 'sensor_instance', 'signal_binding_version', 'equipment_parameter',
    ]) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
      await q.query(`GRANT SELECT, INSERT, UPDATE ON "${table}" TO "ta_app"`);
    }

    // ----------------------------------------------------------------------- backfill
    // Every mapping the upstream mirror already knows about becomes a binding — and
    // every one of them lands as discovered_unreviewed, never active. Nothing existing
    // breaks, because nothing reads bindings yet, and nothing claims to have been
    // reviewed by somebody who has not looked at it.
    //
    // DISTINCT ON rather than ON CONFLICT: an exclusion constraint cannot be an
    // ON CONFLICT target, so duplicates are resolved before the insert rather than after.
    await q.query(`
      INSERT INTO "signal_binding_version" (
        "tenant_id", "source_system", "external_id", "signal_key", "measurement_role",
        "origin", "imei", "canonical_unit", "source_unit", "valid_from",
        "status", "is_primary", "discovered_from", "discovered_by"
      )
      SELECT DISTINCT ON (ep."tenant_id", ep."source_system", ep."external_id", smp."signal")
        ep."tenant_id", ep."source_system", ep."external_id",
        smp."signal", smp."signal",
        'physical', smp."imei",
        COALESCE(smp."unit", 'unknown'), smp."unit",
        COALESCE(
          (SELECT MIN(tr."source_timestamp") FROM "telemetry_reading" tr
            WHERE tr."imei" = smp."imei" AND tr."signal" = smp."signal"
              AND tr."tenant_id" = smp."tenant_id"),
          now()
        ),
        'discovered_unreviewed', false, smp."id", 'sensor-map'
      FROM "sensor_map_projection" smp
      JOIN "device_inventory" di
        ON di."imei" = smp."imei"
       AND di."tenant_id" = smp."tenant_id"
       AND di."equipment_external_id" IS NOT NULL
      JOIN "equipment_profile" ep
        ON ep."tenant_id" = smp."tenant_id"
       AND ep."external_id" = di."equipment_external_id"
      ORDER BY ep."tenant_id", ep."source_system", ep."external_id", smp."signal", smp."id"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "equipment_parameter"`);
    await q.query(`DROP TABLE IF EXISTS "signal_binding_version"`);
    await q.query(`DROP TABLE IF EXISTS "sensor_instance"`);
    await q.query(`DROP TABLE IF EXISTS "calibration_version"`);
    // btree_gist is left installed: another migration may come to depend on it, and
    // dropping an extension somebody else is using is not this migration's business.
  }
}
