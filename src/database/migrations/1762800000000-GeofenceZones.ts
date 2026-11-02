import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Geofence zones (task QGEO2, stage 1): places a machine should stay in, must not enter,
 * or should keep to on its way, each applying to an account, a site, a machine or a kind
 * of machine — the four targets alert rules already use.
 *
 * The shape is validated here, as QGEO1 validates a site boundary, and for the same
 * reason: the geometry trusts it completely, and a radius in kilometres or a corridor of
 * one point would not fail, it would quietly put machines on the wrong side. Polygons go
 * through `site_boundary_problem` itself, so a zone and a site boundary cannot disagree
 * about what a valid polygon is.
 *
 * The foreign keys carry `tenant_id`. A plain key on `plant_id` would be checked by the
 * database without row-level security, and would accept a site from another account; the
 * composite key cannot. `plant` gets the unique index that makes it possible.
 */
export class GeofenceZones1762800000000 implements MigrationInterface {
  name = 'GeofenceZones1762800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION "geofence_position_problem"(p jsonb) RETURNS text
      LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN
        IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN
          RETURN 'every position is [longitude, latitude], two numbers';
        END IF;
        IF jsonb_array_length(p) <> 2 OR jsonb_typeof(p->0) <> 'number' OR jsonb_typeof(p->1) <> 'number' THEN
          RETURN 'every position is [longitude, latitude], two numbers';
        END IF;
        IF (p->>0)::numeric NOT BETWEEN -180 AND 180 OR (p->>1)::numeric NOT BETWEEN -90 AND 90 THEN
          RETURN 'a position is [longitude, latitude]: longitude within ±180, latitude within ±90';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`
      CREATE FUNCTION "geofence_shape_problem"(s jsonb) RETURNS text
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE
        pos jsonb;
        problem text;
      BEGIN
        IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN
          RETURN 'a shape is an object with a "type": Polygon, Circle or Corridor';
        END IF;
        IF s->>'type' = 'Polygon' THEN
          RETURN "site_boundary_problem"(s);
        ELSIF s->>'type' = 'Circle' THEN
          problem := "geofence_position_problem"(s->'center');
          IF problem IS NOT NULL THEN RETURN 'a Circle''s "center": ' || problem; END IF;
          -- Typed first, then compared, in separate IFs: SQL does not promise to stop at
          -- the first false, and a cast of text to numeric would raise instead of refuse.
          IF jsonb_typeof(s->'radiusM') IS DISTINCT FROM 'number' THEN
            RETURN 'a Circle''s "radiusM" is metres, above 0 and at most 50000';
          END IF;
          IF (s->>'radiusM')::numeric <= 0 OR (s->>'radiusM')::numeric > 50000 THEN
            RETURN 'a Circle''s "radiusM" is metres, above 0 and at most 50000';
          END IF;
          RETURN NULL;
        ELSIF s->>'type' = 'Corridor' THEN
          IF jsonb_typeof(s->'path') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'path') < 2 THEN
            RETURN 'a Corridor''s "path" is at least two positions';
          END IF;
          FOR pos IN SELECT value FROM jsonb_array_elements(s->'path') LOOP
            problem := "geofence_position_problem"(pos);
            IF problem IS NOT NULL THEN RETURN 'a Corridor''s "path": ' || problem; END IF;
          END LOOP;
          IF jsonb_typeof(s->'widthM') IS DISTINCT FROM 'number' THEN
            RETURN 'a Corridor''s "widthM" is metres, above 0 and at most 5000';
          END IF;
          IF (s->>'widthM')::numeric <= 0 OR (s->>'widthM')::numeric > 5000 THEN
            RETURN 'a Corridor''s "widthM" is metres, above 0 and at most 5000';
          END IF;
          RETURN NULL;
        END IF;
        RETURN 'a shape''s "type" is Polygon, Circle or Corridor';
      END $$`);

    await q.query(`CREATE UNIQUE INDEX "uq_plant_tenant_id" ON "plant" ("tenant_id", "id")`);

    await q.query(`
      CREATE TABLE "geofence_zone" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "kind" text NOT NULL,
        "shape" jsonb NOT NULL,
        "applies_to" text NOT NULL,
        "plant_id" uuid,
        "source_system" text,
        "external_id" text,
        "equipment_class_slug" text,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_by" text NOT NULL,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_geofence_zone_code" CHECK ("code" ~ '^[A-Za-z0-9._-]+$'),
        CONSTRAINT "ck_geofence_zone_name" CHECK (btrim("name") <> ''),
        CONSTRAINT "ck_geofence_zone_kind" CHECK ("kind" IN ('allowed', 'restricted', 'corridor')),
        CONSTRAINT "ck_geofence_zone_shape" CHECK ("geofence_shape_problem"("shape") IS NULL),
        -- A corridor is a path with a width; any other kind is an area. Mixed, the
        -- geometry would answer a question nobody asked.
        CONSTRAINT "ck_geofence_zone_corridor" CHECK (("kind" = 'corridor') = ("shape"->>'type' = 'Corridor')),
        CONSTRAINT "ck_geofence_zone_scope" CHECK (
          ("applies_to" = 'account' AND "plant_id" IS NULL AND "source_system" IS NULL
             AND "external_id" IS NULL AND "equipment_class_slug" IS NULL)
          OR ("applies_to" = 'plant' AND "plant_id" IS NOT NULL AND "source_system" IS NULL
             AND "external_id" IS NULL AND "equipment_class_slug" IS NULL)
          OR ("applies_to" = 'equipment' AND "plant_id" IS NULL AND "source_system" IS NOT NULL
             AND "external_id" IS NOT NULL AND "equipment_class_slug" IS NULL)
          OR ("applies_to" = 'equipment-class' AND "plant_id" IS NULL AND "source_system" IS NULL
             AND "external_id" IS NULL AND "equipment_class_slug" IS NOT NULL)),
        -- A zone applies to its target and nothing else, so it goes with it.
        CONSTRAINT "fk_geofence_zone_plant" FOREIGN KEY ("tenant_id", "plant_id")
          REFERENCES "plant" ("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "fk_geofence_zone_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE,
        CONSTRAINT "fk_geofence_zone_class" FOREIGN KEY ("tenant_id", "equipment_class_slug")
          REFERENCES "client_equipment_class" ("tenant_id", "slug") ON DELETE CASCADE
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_geofence_zone_code" ON "geofence_zone" ("tenant_id", "code")`);
    await q.query(`CREATE INDEX "ix_geofence_zone_tenant" ON "geofence_zone" ("tenant_id", "enabled")`);

    // Code and target are fixed: stage 2 records visits against a zone, and a zone moved
    // to another machine would leave those visits describing a fence that never held it.
    await q.query(`
      CREATE FUNCTION "geofence_zone_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."code" IS DISTINCT FROM OLD."code"
           OR NEW."applies_to" IS DISTINCT FROM OLD."applies_to" OR NEW."plant_id" IS DISTINCT FROM OLD."plant_id"
           OR NEW."source_system" IS DISTINCT FROM OLD."source_system" OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
           OR NEW."equipment_class_slug" IS DISTINCT FROM OLD."equipment_class_slug" THEN
          RAISE EXCEPTION 'geofence zone %: its code and what it applies to cannot change; make a new zone', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_geofence_zone_guard" BEFORE UPDATE ON "geofence_zone"
        FOR EACH ROW EXECUTE FUNCTION "geofence_zone_guard"()`);

    await q.query(`ALTER TABLE "geofence_zone" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "geofence_zone" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "geofence_zone"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "geofence_zone" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "geofence_zone"`);
    await q.query(`DROP FUNCTION IF EXISTS "geofence_zone_guard"()`);
    await q.query(`DROP INDEX IF EXISTS "uq_plant_tenant_id"`);
    await q.query(`DROP FUNCTION IF EXISTS "geofence_shape_problem"(jsonb)`);
    await q.query(`DROP FUNCTION IF EXISTS "geofence_position_problem"(jsonb)`);
  }
}
