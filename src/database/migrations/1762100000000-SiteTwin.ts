import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The site's digital twin: where each machine stands on the site, and the zones it is
 * divided into.
 *
 * Nothing upstream knows this. 1.0 has GPS on some devices and none on most, and a GPS
 * fix says where a machine is, not which bay it belongs to — so the layout is the
 * client's to draw, like the plant itself (P1-85), and 2.0 owns it.
 *
 * The site is a flat rectangle in metres, origin at its centre, x east and z south —
 * the same frame the class models are drawn in (metres, Y up), so a 12 m crane placed
 * here is 12 m long against a 200 m yard without anything being rescaled.
 *
 * Every rule that keeps the picture honest is here rather than in the service: a zone
 * or a machine outside the site, and a site shrunk until something falls off its edge.
 * The editor will not send those, but the next client of this table might not be the
 * editor.
 */
export class SiteTwin1762100000000 implements MigrationInterface {
  name = 'SiteTwin1762100000000';

  public async up(q: QueryRunner): Promise<void> {
    // `id` is already unique, so this cannot fail on existing rows. It exists so the twin
    // can reference (tenant_id, id): a single-column FK would let a row in one account
    // point at another account's site, and RLS would hide that rather than refuse it.
    await q.query(`ALTER TABLE "plant" ADD CONSTRAINT "uq_plant_tenant_id" UNIQUE ("tenant_id", "id")`);

    // --------------------------------------------------------------------- the site
    // One row per site that has ever been laid out. `version` is the layout's optimistic
    // lock: a save names the version it was drawn on, and loses if someone saved since.
    // 0 is "never saved", so the first save is checked the same way as every other.
    await q.query(`
      CREATE TABLE "site_twin" (
        "tenant_id" text NOT NULL,
        "plant_id" uuid NOT NULL,
        "width_m" double precision NOT NULL,
        "depth_m" double precision NOT NULL,
        "version" int NOT NULL DEFAULT 0,
        "updated_by" text,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_site_twin" PRIMARY KEY ("tenant_id", "plant_id"),
        CONSTRAINT "fk_site_twin_plant" FOREIGN KEY ("tenant_id", "plant_id")
          REFERENCES "plant" ("tenant_id", "id") ON DELETE CASCADE,
        -- 10 m is a compound, 5 km is a highway package. Outside that it is a typo in
        -- the units, and the camera would fit a speck or a void.
        CONSTRAINT "ck_site_twin_extent" CHECK ("width_m" BETWEEN 10 AND 5000 AND "depth_m" BETWEEN 10 AND 5000),
        CONSTRAINT "ck_site_twin_version" CHECK ("version" >= 0)
      )`);

    // ----------------------------------------------------------- zones and structures
    // A zone is a rectangle on the ground. Its kind is either a flat area (a work area,
    // a yard) or a structure drawn in 3-D inside that rectangle (an office, a batching
    // plant, a building going up). Both live here because both are "a named part of the
    // site", and a machine is engaged at either.
    //
    // `key` is the zone's stable name within the site. A save replaces every row, so the
    // uuid changes each time; routes and the API refer to the key instead.
    await q.query(`
      CREATE TABLE "site_twin_zone" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "plant_id" uuid NOT NULL,
        "key" text NOT NULL,
        "label" text NOT NULL,
        "kind" text NOT NULL,
        "x" double precision NOT NULL,
        "z" double precision NOT NULL,
        "width_m" double precision NOT NULL,
        "depth_m" double precision NOT NULL,
        "floors" int,
        "progress_pct" double precision,
        "progress_reported_at" timestamptz,
        "progress_reported_by" text,
        "sort_order" int NOT NULL DEFAULT 0,
        CONSTRAINT "fk_site_twin_zone_site" FOREIGN KEY ("tenant_id", "plant_id")
          REFERENCES "site_twin" ("tenant_id", "plant_id") ON DELETE CASCADE,
        CONSTRAINT "uq_site_twin_zone_key" UNIQUE ("tenant_id", "plant_id", "key"),
        CONSTRAINT "ck_site_twin_zone_key" CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
        CONSTRAINT "ck_site_twin_zone_label" CHECK (length(btrim("label")) BETWEEN 1 AND 60),
        -- The kind decides how it is drawn. A free-text kind would make every client's
        -- legend different and none of them readable by an inspector.
        CONSTRAINT "ck_site_twin_zone_kind" CHECK ("kind" IN (
          'work_area', 'material_yard', 'parking', 'restricted',
          'head_office', 'site_office', 'batching_plant', 'maintenance_workshop', 'gate', 'road',
          'building', 'substation', 'quay', 'container_yard', 'quay_crane_berth')),
        CONSTRAINT "ck_site_twin_zone_size" CHECK ("width_m" >= 1 AND "depth_m" >= 1),
        -- Progress is what the site reported, so it says when: a percentage with no date
        -- is a claim nobody can check. Only what is built in stages carries one.
        CONSTRAINT "ck_site_twin_zone_progress" CHECK (
          ("progress_pct" IS NULL AND "progress_reported_at" IS NULL)
          OR ("progress_pct" BETWEEN 0 AND 100 AND "progress_reported_at" IS NOT NULL
              AND "kind" IN ('building', 'road', 'substation', 'quay'))),
        CONSTRAINT "ck_site_twin_zone_floors" CHECK (
          "floors" IS NULL OR ("floors" BETWEEN 1 AND 80 AND "kind" = 'building'))
      )`);
    await q.query(`CREATE INDEX "ix_site_twin_zone_site" ON "site_twin_zone" ("tenant_id", "plant_id")`);

    // --------------------------------------------------------------- the placements
    // Keyed by site as well as machine: a machine moved to another site keeps its old
    // spot here, unused, and is unplaced at the new one until somebody puts it down.
    // That a placed machine is at this site today is the service's check, not a key —
    // a key would make moving a machine between sites fail on a picture.
    await q.query(`
      CREATE TABLE "site_twin_placement" (
        "tenant_id" text NOT NULL,
        "plant_id" uuid NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "x" double precision NOT NULL,
        "z" double precision NOT NULL,
        "heading_deg" double precision NOT NULL DEFAULT 0,
        -- The zones a vehicle shuttles between, by key, in order. Drawn as an illustrative
        -- path, travelled only while the machine's own data says it is working.
        "route" text[] NOT NULL DEFAULT '{}',
        CONSTRAINT "pk_site_twin_placement" PRIMARY KEY ("tenant_id", "plant_id", "source_system", "external_id"),
        CONSTRAINT "fk_site_twin_placement_site" FOREIGN KEY ("tenant_id", "plant_id")
          REFERENCES "site_twin" ("tenant_id", "plant_id") ON DELETE CASCADE,
        CONSTRAINT "fk_site_twin_placement_equipment" FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id") ON DELETE CASCADE,
        -- Half-open, so 360 is written as 0 and one heading has one spelling.
        CONSTRAINT "ck_site_twin_placement_heading" CHECK ("heading_deg" >= 0 AND "heading_deg" < 360),
        CONSTRAINT "ck_site_twin_placement_route" CHECK (cardinality("route") <= 8 AND array_position("route", NULL) IS NULL)
      )`);

    // ------------------------------------------------------- inside the site's edge
    // A check constraint cannot read another table, so the fit is a trigger on both
    // sides: the thing placed, and the site it is placed on.
    await q.query(`
      CREATE FUNCTION "site_twin_fits"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s record; hw double precision := 0; hd double precision := 0;
      BEGIN
        SELECT "width_m", "depth_m" INTO s FROM "site_twin"
         WHERE "tenant_id" = NEW."tenant_id" AND "plant_id" = NEW."plant_id";
        IF TG_TABLE_NAME = 'site_twin_zone' THEN
          hw := NEW."width_m" / 2; hd := NEW."depth_m" / 2;
        END IF;
        IF abs(NEW."x") + hw > s."width_m" / 2 + 1e-9 OR abs(NEW."z") + hd > s."depth_m" / 2 + 1e-9 THEN
          RAISE EXCEPTION 'ck_site_twin_fits: % at (%, %) does not fit inside the % x % m site.',
            TG_TABLE_NAME, NEW."x", NEW."z", s."width_m", s."depth_m"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_site_twin_fits';
        END IF;
        RETURN NEW;
      END $$`);
    for (const table of ['site_twin_zone', 'site_twin_placement']) {
      await q.query(`
        CREATE TRIGGER "trg_${table}_fits" BEFORE INSERT OR UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "site_twin_fits"()`);
    }
    // Shrinking the site is the other way to push something off it.
    await q.query(`
      CREATE FUNCTION "site_twin_extent_holds"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "site_twin_zone" z
           WHERE z."tenant_id" = NEW."tenant_id" AND z."plant_id" = NEW."plant_id"
             AND (abs(z."x") + z."width_m" / 2 > NEW."width_m" / 2 + 1e-9
               OR abs(z."z") + z."depth_m" / 2 > NEW."depth_m" / 2 + 1e-9)
        ) OR EXISTS (
          SELECT 1 FROM "site_twin_placement" p
           WHERE p."tenant_id" = NEW."tenant_id" AND p."plant_id" = NEW."plant_id"
             AND (abs(p."x") > NEW."width_m" / 2 + 1e-9 OR abs(p."z") > NEW."depth_m" / 2 + 1e-9)
        ) THEN
          RAISE EXCEPTION 'ck_site_twin_fits: a % x % m site would leave a zone or a machine outside it.',
            NEW."width_m", NEW."depth_m"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_site_twin_fits';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_site_twin_extent_holds" BEFORE UPDATE OF "width_m", "depth_m" ON "site_twin"
        FOR EACH ROW EXECUTE FUNCTION "site_twin_extent_holds"()`);

    // ------------------------------------------------------------ routes resolve
    // Every key a route names is a zone on the same site. Checked at commit rather than
    // per row, because a save deletes and re-inserts the zones a route already names —
    // mid-transaction the route dangles, and only the end state has to be true.
    await q.query(`
      CREATE FUNCTION "site_twin_routes_resolve"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t text := COALESCE(NEW."tenant_id", OLD."tenant_id"); pl uuid := COALESCE(NEW."plant_id", OLD."plant_id");
              missing text;
      BEGIN
        SELECT r.k INTO missing
          FROM "site_twin_placement" p, unnest(p."route") AS r(k)
         WHERE p."tenant_id" = t AND p."plant_id" = pl
           AND NOT EXISTS (SELECT 1 FROM "site_twin_zone" z WHERE z."tenant_id" = t AND z."plant_id" = pl AND z."key" = r.k)
         LIMIT 1;
        IF missing IS NOT NULL THEN
          RAISE EXCEPTION 'ck_site_twin_route: a route names zone "%", which is not on this site.', missing
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_site_twin_route';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER "trg_site_twin_placement_route" AFTER INSERT OR UPDATE ON "site_twin_placement"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "site_twin_routes_resolve"()`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER "trg_site_twin_zone_route" AFTER DELETE OR UPDATE OF "key" ON "site_twin_zone"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "site_twin_routes_resolve"()`);

    // --------------------------------------------------------------- tenant isolation
    for (const table of ['site_twin', 'site_twin_zone', 'site_twin_placement']) {
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
      await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "ta_app"`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "site_twin_placement"`);
    await q.query(`DROP TABLE IF EXISTS "site_twin_zone"`);
    await q.query(`DROP TABLE IF EXISTS "site_twin"`);
    await q.query(`DROP FUNCTION IF EXISTS "site_twin_extent_holds"()`);
    await q.query(`DROP FUNCTION IF EXISTS "site_twin_routes_resolve"()`);
    await q.query(`DROP FUNCTION IF EXISTS "site_twin_fits"()`);
    await q.query(`ALTER TABLE "plant" DROP CONSTRAINT IF EXISTS "uq_plant_tenant_id"`);
  }
}
