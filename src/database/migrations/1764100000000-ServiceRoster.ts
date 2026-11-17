import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who goes when a machine needs somebody: the account's service roster (Crompton U5,
 * "right engineer, right region").
 *
 * A region is the account's own grouping of its sites — a district, a dealer's patch, a
 * service centre's radius. Nothing upstream knows it, so 2.0 owns it, like the plant.
 * Each site sits in at most one region; each region lists its engineers in order, the
 * first being who a job goes to and the rest who covers.
 *
 * Engineers are the account's own users, so the person a job is routed to is the person
 * who can open it, start it and close it. A roster of names and phone numbers that are
 * not users would route work to somebody the platform cannot hand it to.
 *
 * Everything that keeps the roster honest is a key here, not a service check: a site or
 * an engineer from another account (composite keys through `uq_plant_tenant_id` and
 * `uq_app_user_tenant_id`), a site in two regions, two engineers at the same rank. The
 * Excel upload and the screen both write these tables; neither should be able to leave
 * them in a state the router has to guess about.
 */
export class ServiceRoster1764100000000 implements MigrationInterface {
  name = 'ServiceRoster1764100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "service_region" (
        "tenant_id" text NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "updated_by" text,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_service_region" PRIMARY KEY ("tenant_id", "code"),
        -- The code is what the Excel sheet and the API name a region by, so it is kept to
        -- something nobody mistypes twice in two different ways.
        CONSTRAINT "ck_service_region_code" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
        CONSTRAINT "ck_service_region_name" CHECK (length(btrim("name")) BETWEEN 1 AND 80)
      )`);

    // Keyed by site alone: a site in two regions would have two first engineers, and the
    // router would be choosing between them by accident.
    await q.query(`
      CREATE TABLE "service_region_plant" (
        "tenant_id" text NOT NULL,
        "plant_id" uuid NOT NULL,
        "region_code" text NOT NULL,
        CONSTRAINT "pk_service_region_plant" PRIMARY KEY ("tenant_id", "plant_id"),
        CONSTRAINT "fk_service_region_plant_region" FOREIGN KEY ("tenant_id", "region_code")
          REFERENCES "service_region" ("tenant_id", "code") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_service_region_plant_plant" FOREIGN KEY ("tenant_id", "plant_id")
          REFERENCES "plant" ("tenant_id", "id") ON DELETE CASCADE
      )`);
    await q.query(`CREATE INDEX "ix_service_region_plant_region" ON "service_region_plant" ("tenant_id", "region_code")`);

    // Rank 1 is who the job goes to. Unique per region, so "first" is never a tie; an
    // engineer can serve several regions, at a different rank in each.
    await q.query(`
      CREATE TABLE "service_region_engineer" (
        "tenant_id" text NOT NULL,
        "region_code" text NOT NULL,
        "user_id" uuid NOT NULL,
        "rank" int NOT NULL,
        CONSTRAINT "pk_service_region_engineer" PRIMARY KEY ("tenant_id", "region_code", "user_id"),
        CONSTRAINT "uq_service_region_engineer_rank" UNIQUE ("tenant_id", "region_code", "rank"),
        CONSTRAINT "ck_service_region_engineer_rank" CHECK ("rank" BETWEEN 1 AND 20),
        CONSTRAINT "fk_service_region_engineer_region" FOREIGN KEY ("tenant_id", "region_code")
          REFERENCES "service_region" ("tenant_id", "code") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_service_region_engineer_user" FOREIGN KEY ("tenant_id", "user_id")
          REFERENCES "app_user" ("tenant_id", "id") ON DELETE CASCADE
      )`);

    for (const table of ['service_region', 'service_region_plant', 'service_region_engineer']) {
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
    await q.query(`DROP TABLE IF EXISTS "service_region_engineer"`);
    await q.query(`DROP TABLE IF EXISTS "service_region_plant"`);
    await q.query(`DROP TABLE IF EXISTS "service_region"`);
  }
}
