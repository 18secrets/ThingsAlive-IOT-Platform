import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Industry types, and tool mappings pointing at one (task QINDUSTRY).
 *
 * `tool_mapping.industry_type` was free text, so "Cement", "cement" and "Cemnt" were
 * three industries and the Admin → Industry Type list described none of them. This
 * makes the list a table and the mapping a reference to it.
 *
 * Global reference data like `tool_mapping`: no tenant column, protected by grants.
 * Every rule is a constraint — a blank name, a duplicate name in any case, a code that
 * is not 2–10 uppercase letters or digits — because the import, the API and a console
 * all write here eventually and only the database sees all three.
 *
 * Nothing is seeded (§7 Q1): whether the five names in the console mock are Things
 * Alive's real industries is a product fact, and a seeded guess would quietly match
 * existing mappings to it. So existing text matches nothing on day one, is kept as
 * `industry_type_legacy`, and is listed for Master Admin, who creates the real types and
 * re-matches. The match below still runs, for a database where types already exist.
 *
 * The free text is history from here: a trigger refuses any write that changes it,
 * so nothing new can land in it by any door.
 */
export class IndustryTypes1760100000000 implements MigrationInterface {
  name = 'IndustryTypes1760100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "industry_type" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "code" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "created_by" text,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_industry_type_name" CHECK (btrim("name") <> '' AND "name" = btrim("name")),
        -- Stored uppercase: "cbm" and "CBM" are one code, and only one spelling is kept.
        CONSTRAINT "ck_industry_type_code" CHECK ("code" ~ '^[A-Z0-9]{2,10}$'),
        CONSTRAINT "ck_industry_type_status" CHECK ("status" IN ('active', 'inactive'))
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_industry_type_name" ON "industry_type" (lower("name"))`);
    await q.query(`CREATE UNIQUE INDEX "uq_industry_type_code" ON "industry_type" ("code")`);
    // DELETE is granted: the foreign key below is what refuses deleting one in use.
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "industry_type" TO "ta_app"`);

    await q.query(`ALTER TABLE "tool_mapping" RENAME COLUMN "industry_type" TO "industry_type_legacy"`);
    await q.query(`
      ALTER TABLE "tool_mapping" ADD COLUMN "industry_type_id" uuid
        CONSTRAINT "fk_tool_mapping_industry_type" REFERENCES "industry_type" ("id")`);

    // Exactly one match, on name or code, ignoring case and surrounding space; anything
    // else stays unmatched rather than becoming a guess.
    const [{ matched, unmatched }] = await q.query(`
      WITH candidates AS (
        SELECT m."id" AS mapping_id, t."id" AS type_id,
               count(*) OVER (PARTITION BY m."id") AS n
          FROM "tool_mapping" m
          JOIN "industry_type" t
            ON lower(btrim(m."industry_type_legacy")) IN (lower(t."name"), lower(t."code"))
      ), applied AS (
        UPDATE "tool_mapping" m SET "industry_type_id" = c.type_id
          FROM candidates c WHERE c.mapping_id = m."id" AND c.n = 1
        RETURNING m."id"
      )
      SELECT (SELECT count(*) FROM applied)::int AS matched,
             (SELECT count(*) FROM "tool_mapping"
               WHERE coalesce(btrim("industry_type_legacy"), '') <> ''
                 AND "id" NOT IN (SELECT "id" FROM applied))::int AS unmatched`);
    // Printed so the deploy log answers "how many matched" without a query (§6).
    // eslint-disable-next-line no-console
    console.log(`IndustryTypes: ${matched} tool mapping(s) matched an industry type, ${unmatched} left unmatched.`);

    await q.query(`
      CREATE FUNCTION "tool_mapping_legacy_industry_frozen"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND coalesce(NEW."industry_type_legacy", '') <> '')
           OR (TG_OP = 'UPDATE' AND NEW."industry_type_legacy" IS DISTINCT FROM OLD."industry_type_legacy") THEN
          RAISE EXCEPTION 'tool_mapping.industry_type_legacy is history: choose an industry type instead (tool_mapping_legacy_industry_frozen)';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_tool_mapping_legacy_industry_frozen"
        BEFORE INSERT OR UPDATE ON "tool_mapping"
        FOR EACH ROW EXECUTE FUNCTION "tool_mapping_legacy_industry_frozen"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "tg_tool_mapping_legacy_industry_frozen" ON "tool_mapping"`);
    await q.query(`DROP FUNCTION IF EXISTS "tool_mapping_legacy_industry_frozen"()`);
    // A mapping given a type after the migration has no text to go back to; the type's
    // name is the closest free text there is.
    await q.query(`
      UPDATE "tool_mapping" m SET "industry_type_legacy" = t."name"
        FROM "industry_type" t
       WHERE m."industry_type_id" = t."id" AND coalesce(btrim(m."industry_type_legacy"), '') = ''`);
    await q.query(`ALTER TABLE "tool_mapping" DROP COLUMN "industry_type_id"`);
    await q.query(`ALTER TABLE "tool_mapping" RENAME COLUMN "industry_type_legacy" TO "industry_type"`);
    await q.query(`DROP TABLE "industry_type"`);
  }
}
