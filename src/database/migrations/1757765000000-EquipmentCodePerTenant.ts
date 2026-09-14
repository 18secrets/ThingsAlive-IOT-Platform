import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A machine's code is unique inside an account, not across the platform.
 *
 * The index this replaces was written when `equipment_profile` only ever annotated
 * mirrored assets: every row's `external_id` came from an upstream system that had
 * already made it unique, so spanning accounts cost nothing and nobody noticed.
 *
 * The equipment register changed that. Clients now create machines under the shared
 * source system `ta-2.0` with a code they choose, and "DG-1" is what a great many of
 * them will choose. Under the old index the first customer to use it would succeed
 * and every customer after would be refused — on their own data, in their own
 * account, for a reason that is invisible to them and to support.
 *
 * Narrowing a unique index cannot fail on existing rows: every set that was unique
 * globally is still unique per tenant.
 */
export class EquipmentCodePerTenant1757765000000 implements MigrationInterface {
  name = 'EquipmentCodePerTenant1757765000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_equipment_profile_external"`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_profile_external"
        ON "equipment_profile" ("tenant_id", "source_system", "external_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Widening can fail, and should: if two accounts have both used a code by then,
    // there is no correct way back and the migration must say so rather than pick one.
    await q.query(`DROP INDEX IF EXISTS "uq_equipment_profile_external"`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_equipment_profile_external"
        ON "equipment_profile" ("source_system", "external_id")`);
  }
}
