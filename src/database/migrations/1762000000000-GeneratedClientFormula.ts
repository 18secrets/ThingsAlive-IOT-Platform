import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provenance for generated client formulas (task QGEN2, D25-D33).
 *
 * Adds `source` and `proposal_id` to `client_formula`:
 * - Existing rows backfill to 'copied' (QGRANT0's copy-on-grant was the sole writer).
 * - Enforces that source is one of ('copied', 'manual', 'generated').
 * - Enforces that source = 'generated' iff proposal_id IS NOT NULL.
 */
export class GeneratedClientFormula1762000000000 implements MigrationInterface {
  name = 'GeneratedClientFormula1762000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "client_formula"
        ADD COLUMN "source" text NOT NULL DEFAULT 'copied',
        ADD COLUMN "proposal_id" uuid REFERENCES "artifact_proposal"("id");
    `);

    await q.query(`
      ALTER TABLE "client_formula"
        ADD CONSTRAINT "chk_client_formula_source"
          CHECK ("source" IN ('copied', 'manual', 'generated')),
        ADD CONSTRAINT "chk_client_formula_proposal_source"
          CHECK (("source" = 'generated' AND "proposal_id" IS NOT NULL) OR ("source" <> 'generated' AND "proposal_id" IS NULL));
    `);

    await q.query(`
      CREATE INDEX "ix_client_formula_proposal" ON "client_formula"("proposal_id") WHERE "proposal_id" IS NOT NULL;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "ix_client_formula_proposal"`);
    await q.query(`ALTER TABLE "client_formula" DROP CONSTRAINT IF EXISTS "chk_client_formula_proposal_source"`);
    await q.query(`ALTER TABLE "client_formula" DROP CONSTRAINT IF EXISTS "chk_client_formula_source"`);
    await q.query(`ALTER TABLE "client_formula" DROP COLUMN IF EXISTS "proposal_id"`);
    await q.query(`ALTER TABLE "client_formula" DROP COLUMN IF EXISTS "source"`);
  }
}
