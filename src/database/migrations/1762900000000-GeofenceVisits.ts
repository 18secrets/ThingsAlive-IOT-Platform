import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Geofence visits (task QGEO2, stage 2): each stretch of time a machine spent inside a
 * zone — its site boundary included — from the reading that put it in to the reading
 * that took it out.
 *
 * Visits are derived, on shift boundaries (D12), from readings already persisted, and a
 * late reading rewinds the shift and derives them again. So the natural key is what the
 * derivation produces — machine, zone, entered at — and the database holds the one rule
 * a recomputation must never break: a machine is in a zone at most once at a time. Two
 * open visits for one machine and zone would be two answers to "is it there now".
 *
 * `zone_key` names the zone even when it is a site boundary, which has no zone row.
 * `zone_id` is kept loose (SET NULL): deleting a zone must not delete the record of where
 * machines went, and the snapshot columns say what the zone was when they went there.
 */
export class GeofenceVisits1762900000000 implements MigrationInterface {
  name = 'GeofenceVisits1762900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "geofence_visit" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "zone_key" text NOT NULL,
        "zone_id" uuid,
        "zone_source" text NOT NULL,
        "zone_code" text NOT NULL,
        "zone_name" text NOT NULL,
        "zone_kind" text NOT NULL,
        "entered_at" timestamptz NOT NULL,
        "entry_lng" double precision NOT NULL,
        "entry_lat" double precision NOT NULL,
        "left_at" timestamptz,
        "exit_lng" double precision,
        "exit_lat" double precision,
        "left_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_geofence_visit_key" CHECK ("zone_key" ~ '^(zone|site):[0-9a-f-]{36}$'),
        CONSTRAINT "ck_geofence_visit_source" CHECK ("zone_source" IN ('zone', 'site-boundary')),
        CONSTRAINT "ck_geofence_visit_kind" CHECK ("zone_kind" IN ('allowed', 'restricted', 'corridor')),
        CONSTRAINT "ck_geofence_visit_order" CHECK ("left_at" IS NULL OR "left_at" >= "entered_at"),
        -- Left for a reason, or not left. "Exited" carries where; a zone that stopped
        -- applying has no position to give. IS NOT DISTINCT FROM, not =: a null reason
        -- makes = unknown, and a CHECK lets unknown through — the test that tried an exit
        -- with no reason found it accepted.
        CONSTRAINT "ck_geofence_visit_left" CHECK (
          ("left_at" IS NULL AND "left_reason" IS NULL AND "exit_lng" IS NULL AND "exit_lat" IS NULL)
          OR ("left_at" IS NOT NULL AND "left_reason" IS NOT DISTINCT FROM 'exited'
              AND "exit_lng" IS NOT NULL AND "exit_lat" IS NOT NULL)
          OR ("left_at" IS NOT NULL AND "left_reason" IS NOT DISTINCT FROM 'zone_removed'
              AND "exit_lng" IS NULL AND "exit_lat" IS NULL)),
        CONSTRAINT "fk_geofence_visit_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE,
        CONSTRAINT "fk_geofence_visit_zone" FOREIGN KEY ("zone_id")
          REFERENCES "geofence_zone" ("id") ON DELETE SET NULL
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_geofence_visit_entry"
        ON "geofence_visit" ("tenant_id", "source_system", "external_id", "zone_key", "entered_at")`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_geofence_visit_open"
        ON "geofence_visit" ("tenant_id", "source_system", "external_id", "zone_key") WHERE "left_at" IS NULL`);
    await q.query(`CREATE INDEX "ix_geofence_visit_zone" ON "geofence_visit" ("tenant_id", "zone_id", "entered_at")`);

    await q.query(`ALTER TABLE "geofence_visit" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "geofence_visit" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "geofence_visit"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    // DELETE because a late reading can prove a visit never happened; the outbox
    // carries the withdrawal, so nothing downstream is left believing it.
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "geofence_visit" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "geofence_visit"`);
  }
}
