import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a machine is worked (task P1-109).
 *
 * This table is what replaces the broker on the critical path. Scoring was going to be
 * a consequence of telemetry arriving, which needed a message bus reachable across two
 * networks; it is instead a consequence of a shift ending, which needs a schedule the
 * customer already knows and a clock. The dependency on P0-16 goes with it.
 *
 * Hours are minutes-from-local-midnight plus an IANA zone, never an offset. A stored
 * offset is wrong for half the year anywhere that observes daylight saving, and it is
 * wrong quietly: windows drift by an hour and predictions get made against the wrong
 * readings, with nothing failing anywhere.
 */
export class EquipmentShifts1757790000000 implements MigrationInterface {
  name = 'EquipmentShifts1757790000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_shift" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "name" text NOT NULL,
        "start_minute" int NOT NULL,
        "end_minute" int NOT NULL,
        "days" int[] NOT NULL,
        "time_zone" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "scored_through" timestamptz,
        "created_by" text,
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE INDEX "ix_equipment_shift_asset"
        ON "equipment_shift" ("tenant_id", "source_system", "external_id")`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_shift_name"
        ON "equipment_shift" ("tenant_id", "source_system", "external_id", "name")`);
    // The runner's query: every active shift, oldest watermark first. Nulls first,
    // because a shift that has never run is the one most likely to be waiting.
    await q.query(`
      CREATE INDEX "ix_equipment_shift_due" ON "equipment_shift" ("scored_through")
        WHERE "status" = 'active'`);

    await q.query(`
      ALTER TABLE "equipment_shift" ADD CONSTRAINT "ck_equipment_shift_status"
        CHECK ("status" IN ('active', 'retired'))`);
    // 0..1439 for the start and 1..1440 for the end. 1440 is the far end of the day
    // and is a different thing from 0, which would be a shift of no length running
    // overnight.
    await q.query(`
      ALTER TABLE "equipment_shift" ADD CONSTRAINT "ck_equipment_shift_minutes"
        CHECK ("start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 1 AND 1440)`);
    // A CHECK cannot contain a subquery, and "no repeated day" needs one. An immutable
    // function is the way to keep the rule in the schema rather than only in a service:
    // the same day listed twice would double the windows owed for it.
    await q.query(`
      CREATE FUNCTION "ta_days_distinct"(int[]) RETURNS boolean
        LANGUAGE sql IMMUTABLE STRICT AS $$
          SELECT cardinality($1) = (SELECT count(DISTINCT d) FROM unnest($1) d)
        $$`);
    await q.query(`
      ALTER TABLE "equipment_shift" ADD CONSTRAINT "ck_equipment_shift_days"
        CHECK (cardinality("days") BETWEEN 1 AND 7
               AND "days" <@ ARRAY[0,1,2,3,4,5,6]
               AND "ta_days_distinct"("days"))`);

    await q.query(`ALTER TABLE "equipment_shift" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "equipment_shift" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "equipment_shift"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    // Retired rather than deleted, so a prediction can still name the shift that
    // explained its window.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_shift" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "equipment_shift"`);
    await q.query(`DROP FUNCTION IF EXISTS "ta_days_distinct"(int[])`);
  }
}
