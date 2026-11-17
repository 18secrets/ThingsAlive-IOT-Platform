import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One active episode per code per machine, held by the database.
 *
 * DtcDiagnostics gave `device_dtc_episode` lookup indexes but no rule, so "this code is
 * already open on this machine" was a SELECT followed by an INSERT — and two sync passes,
 * or a pass and a retry, could each find nothing and each open the same fault. A cleared
 * episode is history and may repeat; only the active one is unique. The service writes
 * through ON CONFLICT on exactly these columns, so the second writer becomes a sighting.
 *
 * Duplicates already present (a pass raced before this landed) are closed first: the
 * newest of each group stays active and the rest are cleared at their own last sighting.
 */
export class DtcActiveUnique1764800000000 implements MigrationInterface {
  name = 'DtcActiveUnique1764800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "device_dtc_episode" e
         SET "status" = 'cleared', "cleared_at" = e."last_seen_at", "updated_at" = now()
        FROM (
          SELECT "id", row_number() OVER (
                   PARTITION BY "tenant_id", "source_system", "external_id", "protocol", "code"
                   ORDER BY "last_seen_at" DESC, "id") AS rn
            FROM "device_dtc_episode" WHERE "status" = 'active'
        ) d
       WHERE e."id" = d."id" AND d.rn > 1`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_device_dtc_episode_one_active"
        ON "device_dtc_episode" ("tenant_id", "source_system", "external_id", "protocol", "code")
        WHERE "status" = 'active'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "uq_device_dtc_episode_one_active"`);
  }
}
