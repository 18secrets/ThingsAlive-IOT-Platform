import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tool mappings: a device profile naming which reference sensors, and which of each
 * one's channels, a device registered against this tool is expected to report (task:
 * master-data pipeline for device onboarding).
 *
 * `mapped_sensors` stores only sensor ids, never names — resolved live by
 * DeviceCatalogService on every read, so a sensor rename or a narrowed parameter list
 * is reflected everywhere it is mapped rather than drifting from a stale copy. That is
 * also why it is jsonb rather than a join table: a real join table would need its own
 * migration to add a column every time the shape changes, for what is, per row, a
 * small fixed structure — the same tradeoff `equipment_class_profile.expected_signals`
 * already makes.
 */
export class ToolMapping1757920000000 implements MigrationInterface {
  name = 'ToolMapping1757920000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tool_mapping" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tool_name" text NOT NULL,
        "industry_type" text,
        "protocol" text,
        "mapped_sensors" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "tool_mapping" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "tool_mapping"`);
  }
}
