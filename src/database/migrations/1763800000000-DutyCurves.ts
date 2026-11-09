import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A pump model's duty curve, as printed in its catalogue (D58): at rated speed, head →
 * flow → input power, one row per printed point.
 *
 * The sensorless design rests on it. Flow is estimated by reading it backwards from
 * measured power; the expected power at an installation by reading it forwards at the
 * install head; duty-point deviation compares the two. `curve_at` reads it.
 *
 * Shape, enforced here: points in order of rising flow have strictly falling head, which
 * is what a duty curve is. Reading the curve by head or by flow then has one answer at
 * every value. Input power is not held to an order — on a self-priming regenerative pump
 * it falls as flow rises, on a centrifugal one it rises — so reading by power checks the
 * order when it is read, and says so when there is none.
 *
 * A row-level CHECK cannot see neighbouring rows, so the shape is a constraint trigger,
 * deferred to commit: a replace deletes and re-inserts the whole curve in one
 * transaction, and the curve is only whole at the end of it.
 */
export class DutyCurves1763800000000 implements MigrationInterface {
  name = 'DutyCurves1763800000000';

  public async up(q: QueryRunner): Promise<void> {
    const pointColumns = `
        "curve" text NOT NULL DEFAULT 'duty',
        "point" int NOT NULL,
        "head_m" double precision NOT NULL,
        "flow_lpm" double precision NOT NULL,
        "input_kw" double precision NOT NULL,
        "source" text NOT NULL,
        "updated_by" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()`;
    const pointChecks = (t: string) => `
        -- One kind for now. A second machine type that needs a curve adds a kind and its
        -- columns, not a general table language (D58).
        CONSTRAINT "ck_${t}_curve" CHECK ("curve" = 'duty'),
        CONSTRAINT "ck_${t}_point" CHECK ("point" >= 0),
        CONSTRAINT "ck_${t}_values" CHECK (
          "head_m" >= 0 AND "flow_lpm" >= 0 AND "input_kw" > 0
          AND "head_m" < 'Infinity'::float8 AND "flow_lpm" < 'Infinity'::float8 AND "input_kw" < 'Infinity'::float8
          AND "head_m" <> 'NaN'::float8 AND "flow_lpm" <> 'NaN'::float8 AND "input_kw" <> 'NaN'::float8),
        CONSTRAINT "ck_${t}_source" CHECK (length(btrim("source")) > 0)`;

    await q.query(`
      CREATE TABLE "equipment_template_curve_point" (
        "template_id" uuid NOT NULL REFERENCES "equipment_template" ("id") ON DELETE CASCADE,
        ${pointColumns},
        PRIMARY KEY ("template_id", "curve", "point"),
        ${pointChecks('equipment_template_curve_point')}
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_template_curve_point" TO "ta_app"`);

    await q.query(`
      CREATE TABLE "client_equipment_template_curve_point" (
        "tenant_id" text NOT NULL,
        "template_id" uuid NOT NULL,
        ${pointColumns},
        PRIMARY KEY ("tenant_id", "template_id", "curve", "point"),
        CONSTRAINT "fk_client_equipment_template_curve_point_template"
          FOREIGN KEY ("tenant_id", "template_id")
          REFERENCES "client_equipment_template" ("tenant_id", "id") ON DELETE CASCADE,
        ${pointChecks('client_equipment_template_curve_point')}
      )`);
    await q.query(`ALTER TABLE "client_equipment_template_curve_point" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_equipment_template_curve_point" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_equipment_template_curve_point"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_equipment_template_curve_point" TO "ta_app"`);
    // The KPI evaluator reads it for any formula calling `curve_at`; an evaluation session
    // evaluates as `ta_eval`, read-only (ModelRatings1763700000000 granted the ratings).
    await q.query(`GRANT SELECT ON "client_equipment_template_curve_point" TO "ta_eval"`);

    // One function for both tables: the shape rule is the same, only the table differs.
    // Fewer than two points cannot be read between; an empty curve is simply absent.
    await q.query(`
      CREATE FUNCTION "check_duty_curve_shape"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tid uuid := COALESCE(NEW."template_id", OLD."template_id");
        n int;
        bad int;
      BEGIN
        EXECUTE format(
          'SELECT count(*), count(*) FILTER (WHERE prev_head IS NOT NULL
                                             AND NOT (flow_lpm > prev_flow AND head_m < prev_head))
             FROM (SELECT flow_lpm, head_m,
                          lag(flow_lpm) OVER (ORDER BY point) AS prev_flow,
                          lag(head_m)   OVER (ORDER BY point) AS prev_head
                     FROM %I WHERE template_id = $1 AND curve = ''duty'') s', TG_TABLE_NAME)
          INTO n, bad USING tid;
        IF n = 1 THEN
          RAISE EXCEPTION 'a duty curve needs at least two points, model % has one (duty_curve_shape)', tid
            USING ERRCODE = 'check_violation';
        END IF;
        IF bad > 0 THEN
          RAISE EXCEPTION 'duty curve points, in order, must have rising flow and falling head; model % has % out of order (duty_curve_shape)', tid, bad
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    for (const t of ['equipment_template_curve_point', 'client_equipment_template_curve_point']) {
      await q.query(`
        CREATE CONSTRAINT TRIGGER "tr_${t}_shape"
          AFTER INSERT OR UPDATE OR DELETE ON "${t}"
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION "check_duty_curve_shape"()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "client_equipment_template_curve_point"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_template_curve_point"`);
    await q.query(`DROP FUNCTION IF EXISTS "check_duty_curve_shape"()`);
  }
}
