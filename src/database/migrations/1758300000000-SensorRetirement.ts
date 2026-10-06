import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire, not delete, for sensors and sensor categories (task QCAT2).
 *
 * The library team asked for a way to remove a sensor. What they need is to stop a
 * mistake spreading — QIMP5's approval loop minted roughly forty sensors, some of
 * them typos and duplicates — without breaking what already points at it. A tool
 * mapping, a sensor instance and a capability row all hold a sensor's id, and a
 * published class version cannot be edited to drop one. So a retired sensor stays,
 * still resolves everywhere it is already used, and stops being offered for new work.
 *
 * A timestamp, not a status enum: one nullable column answers "is it retired" and
 * "since when", and null on every existing row means nothing changes for anybody the
 * moment this runs.
 *
 * "A category cannot be retired while a live sensor is in it" is a trigger pair
 * rather than a service check, because the service check loses to a concurrent write:
 * one request retiring the category while another un-retires a sensor in it would
 * each read the other's row as it was and both commit, leaving a live sensor filed
 * under a category nobody can see. The sensor side takes `FOR SHARE` on its category
 * row, and the category side's BEFORE UPDATE already holds that row exclusively, so
 * whichever commits second re-reads the first's write and is refused.
 */
export class SensorRetirement1758300000000 implements MigrationInterface {
  name = 'SensorRetirement1758300000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const table of ['sensor', 'sensor_category']) {
      await q.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "retired_at" timestamptz NULL,
          ADD COLUMN "retired_by" text NULL`);
    }

    // A live sensor never sits in a retired category — on create, on a move between
    // categories, and on un-retire.
    await q.query(`
      CREATE OR REPLACE FUNCTION "ck_sensor_category_live"() RETURNS trigger AS $$
      DECLARE
        category_name text;
        category_retired timestamptz;
      BEGIN
        IF NEW."retired_at" IS NOT NULL OR NEW."category_id" IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT "name", "retired_at" INTO category_name, category_retired
          FROM "sensor_category" WHERE "id" = NEW."category_id"
          FOR SHARE;

        IF category_retired IS NOT NULL THEN
          RAISE EXCEPTION
            'sensor "%" cannot be live in category "%", which was retired on % (ck_sensor_category_live)',
            NEW."sensor_name", category_name, to_char(category_retired AT TIME ZONE 'UTC', 'YYYY-MM-DD');
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_sensor_category_live"
        BEFORE INSERT OR UPDATE OF "category_id", "retired_at" ON "sensor"
        FOR EACH ROW EXECUTE FUNCTION "ck_sensor_category_live"()`);

    // And a category is not retired out from under a live sensor. Names them, so the
    // refusal says what to retire or move first.
    await q.query(`
      CREATE OR REPLACE FUNCTION "ck_sensor_category_retire_empty"() RETURNS trigger AS $$
      DECLARE
        live_count int;
        live_names text;
      BEGIN
        IF NEW."retired_at" IS NULL OR OLD."retired_at" IS NOT NULL THEN
          RETURN NEW;
        END IF;

        SELECT count(*), string_agg("sensor_name", ', ' ORDER BY "sensor_name")
          INTO live_count, live_names
          FROM "sensor" WHERE "category_id" = NEW."id" AND "retired_at" IS NULL;

        IF live_count > 0 THEN
          RAISE EXCEPTION
            'category "%" still holds % live sensor(s): % (ck_sensor_category_retire_empty)',
            NEW."name", live_count, live_names;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_sensor_category_retire_empty"
        BEFORE UPDATE OF "retired_at" ON "sensor_category"
        FOR EACH ROW EXECUTE FUNCTION "ck_sensor_category_retire_empty"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_sensor_category_retire_empty" ON "sensor_category"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_sensor_category_retire_empty"()`);
    await q.query(`DROP TRIGGER IF EXISTS "trg_sensor_category_live" ON "sensor"`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_sensor_category_live"()`);
    for (const table of ['sensor_category', 'sensor']) {
      await q.query(`
        ALTER TABLE "${table}"
          DROP COLUMN "retired_by",
          DROP COLUMN "retired_at"`);
    }
  }
}
