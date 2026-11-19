import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One tenant per Vani account (the gap `1763600000000-VaniVoice.ts` left open, closed
 * 19 Nov 2026).
 *
 * Vani knows an account, not a tenant: its outcome callbacks, inbound questions and
 * snapshots carry `account_id` alone, and 2.0 finds the tenant through this link. Two
 * tenants linked to one Vani account would have one tenant's alerts read out to the
 * other's customer, and an inbound caller answered from whichever row the lookup met
 * first. Until now only the habit of linking by hand stood in the way.
 *
 * The index is global, not per tenant: the whole point is that a second tenant cannot
 * claim an account another already holds. `rls-coverage.spec.ts` lists it in
 * `GLOBAL_UNIQUE` with that reason. A disabled link still holds its account — switching
 * calls off for a customer is not handing their account to someone else.
 *
 * Matched exactly, as Vani matches it: `usa-test-01` and `USA-TEST-01` are two
 * registrations on Vani's side, so they are two here.
 *
 * It replaces the plain lookup index, which a unique one serves just as well.
 */
export class VaniAccountOneTenant1765700000000 implements MigrationInterface {
  name = 'VaniAccountOneTenant1765700000000';

  public async up(q: QueryRunner): Promise<void> {
    // Postgres would refuse the index anyway, but with a message naming an index
    // rather than the accounts someone has to untangle by hand before this can run.
    const shared: { vani_account_id: string; tenants: string }[] = await q.query(`
      SELECT "vani_account_id", string_agg("tenant_id", ', ' ORDER BY "tenant_id") AS tenants
        FROM "vani_account_link"
       GROUP BY "vani_account_id"
      HAVING count(*) > 1`);
    if (shared.length > 0) {
      const list = shared.map((r) => `${r.vani_account_id} (${r.tenants})`).join('; ');
      throw new Error(
        `Vani accounts linked to more than one tenant: ${list}. Decide which tenant each ` +
          `account belongs to and remove the other links before running this migration.`,
      );
    }
    await q.query(`DROP INDEX "ix_vani_account_link_account"`);
    await q.query(`CREATE UNIQUE INDEX "uq_vani_account_link_account" ON "vani_account_link" ("vani_account_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "uq_vani_account_link_account"`);
    await q.query(`CREATE INDEX "ix_vani_account_link_account" ON "vani_account_link" ("vani_account_id")`);
  }
}
