import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A site's boundary (task QGEO1): a GeoJSON Polygon on `plant`, nullable.
 *
 * Validated here rather than only in the service: the inside/outside operators trust
 * the shape completely, and a ring left open or a latitude in the longitude slot would
 * not fail — it would quietly put every machine on the wrong side of the fence. The
 * function returns the problem in words so the service can say it; the CHECK is what
 * holds for every other path. No PostGIS: Railway's Postgres image has none, and a
 * site-scale point-in-polygon needs nothing it provides.
 */
export class SiteBoundary1758600000000 implements MigrationInterface {
  name = 'SiteBoundary1758600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION "site_boundary_problem"(b jsonb) RETURNS text
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE
        ring jsonb;
        pos jsonb;
        n int;
      BEGIN
        IF jsonb_typeof(b) <> 'object' OR b->>'type' IS DISTINCT FROM 'Polygon' THEN
          RETURN 'a boundary is a GeoJSON object with "type": "Polygon"';
        END IF;
        IF jsonb_typeof(b->'coordinates') <> 'array' OR jsonb_array_length(b->'coordinates') = 0 THEN
          RETURN 'a Polygon needs "coordinates": an outer ring, then any holes';
        END IF;
        FOR ring IN SELECT value FROM jsonb_array_elements(b->'coordinates') LOOP
          IF jsonb_typeof(ring) <> 'array' OR jsonb_array_length(ring) < 4 THEN
            RETURN 'every ring needs at least four positions, the last repeating the first';
          END IF;
          n := jsonb_array_length(ring);
          FOR pos IN SELECT value FROM jsonb_array_elements(ring) LOOP
            IF jsonb_typeof(pos) <> 'array' OR jsonb_array_length(pos) <> 2
               OR jsonb_typeof(pos->0) <> 'number' OR jsonb_typeof(pos->1) <> 'number' THEN
              RETURN 'every position is [longitude, latitude], two numbers';
            END IF;
            IF (pos->>0)::numeric NOT BETWEEN -180 AND 180 OR (pos->>1)::numeric NOT BETWEEN -90 AND 90 THEN
              RETURN 'a position is [longitude, latitude]: longitude within ±180, latitude within ±90';
            END IF;
          END LOOP;
          IF ring->0 <> ring->(n - 1) THEN
            RETURN 'every ring is closed: its last position repeats its first';
          END IF;
        END LOOP;
        RETURN NULL;
      END $$`);
    await q.query(`ALTER TABLE "plant" ADD COLUMN "boundary" jsonb`);
    await q.query(`
      ALTER TABLE "plant" ADD CONSTRAINT "ck_plant_boundary"
        CHECK ("boundary" IS NULL OR "site_boundary_problem"("boundary") IS NULL)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "plant" DROP CONSTRAINT IF EXISTS "ck_plant_boundary"`);
    await q.query(`ALTER TABLE "plant" DROP COLUMN IF EXISTS "boundary"`);
    await q.query(`DROP FUNCTION IF EXISTS "site_boundary_problem"(jsonb)`);
  }
}
