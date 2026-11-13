import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces partial unique constraint: at most one active DTC episode
 * per code on any machine within a tenant.
 */
export class DtcActiveUniqueIndex1764800000000 implements MigrationInterface {
  name = 'DtcActiveUniqueIndex1764800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_dtc_episode_active"
        ON "device_dtc_episode" ("tenant_id", "source_system", "external_id", "code")
        WHERE "status" = 'active'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_device_dtc_episode_active"`);
  }
}
