import { MigrationInterface, QueryRunner } from 'typeorm';

export class DtcPullWatermark1764700000000 implements MigrationInterface {
  name = 'DtcPullWatermark1764700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "dtc_pull_watermark" (
        "imei" text PRIMARY KEY,
        "last_packet_id" bigint,
        "last_packet_time" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "dtc_pull_watermark" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "dtc_pull_watermark"`);
  }
}
