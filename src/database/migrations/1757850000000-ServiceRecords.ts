import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Service history, so "hours since the last service" is answerable (task P4-07).
 *
 * The alternative was the absolute meter reading, which is correct until the first
 * machine is serviced off-schedule and wrong forever afterwards — silently, and only
 * for that machine, which is the worst shape a maintenance bug can have.
 *
 * Two columns carry a service interval default onto the class profile at the same
 * time. Things Alive owns the numbers; the column is what lets them be set without
 * another migration, and every machine can still override its class.
 */
export class ServiceRecords1757850000000 implements MigrationInterface {
  name = 'ServiceRecords1757850000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_service_record" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "performed_at" timestamptz NOT NULL,
        "kind" text NOT NULL DEFAULT 'scheduled',
        "meter_reading" double precision,
        "meter_unit" text,
        "work_order_id" uuid,
        "notes" text,
        "recorded_by" text,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // "What has been done to this machine, most recent first" is the only question
    // this table is ever asked.
    await q.query(`
      CREATE INDEX "ix_service_record_asset"
        ON "equipment_service_record" ("tenant_id", "source_system", "external_id", "performed_at")`);

    await q.query(`
      ALTER TABLE "equipment_service_record" ADD CONSTRAINT "ck_service_record_kind"
        CHECK ("kind" IN ('scheduled', 'unscheduled', 'overhaul', 'meter-replaced'))`);
    // A meter cannot read below zero, and a negative one would flow straight into an
    // hours-since figure as time credited back.
    await q.query(`
      ALTER TABLE "equipment_service_record" ADD CONSTRAINT "ck_service_record_meter"
        CHECK ("meter_reading" IS NULL OR "meter_reading" >= 0)`);
    // A reading with no unit cannot be converted, and a unit with no reading describes
    // nothing. Either both or neither.
    await q.query(`
      ALTER TABLE "equipment_service_record" ADD CONSTRAINT "ck_service_record_meter_unit"
        CHECK (("meter_reading" IS NULL) = ("meter_unit" IS NULL))`);

    await q.query(`ALTER TABLE "equipment_service_record" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "equipment_service_record" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "equipment_service_record"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);

    // No DELETE. A service either happened or it did not, and a maintenance history
    // that can be quietly edited is not evidence of anything.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_service_record" TO "ta_app"`);

    // The class-level default. Nullable and unset: Things Alive owns the numbers, and
    // a default invented here would be a confident wrong interval on every machine of
    // that class at once.
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        ADD COLUMN "service_interval_hours" int`);
    await q.query(`
      ALTER TABLE "equipment_class_profile" ADD CONSTRAINT "ck_class_service_interval"
        CHECK ("service_interval_hours" IS NULL OR "service_interval_hours" > 0)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "equipment_class_profile"
        DROP CONSTRAINT IF EXISTS "ck_class_service_interval"`);
    await q.query(`
      ALTER TABLE "equipment_class_profile" DROP COLUMN IF EXISTS "service_interval_hours"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_service_record"`);
  }
}
