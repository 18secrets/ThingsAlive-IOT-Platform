import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The physical intelligence layer's definitions (task P4-01).
 *
 * Things Alive asked for intelligence per prediction scenario, built on physics rather
 * than on weeks of raw data: load raises oil temperature, oil temperature raises
 * coolant, and somewhere along there maintenance falls due. A chain is that statement,
 * written down so it can be versioned, reviewed and argued with.
 *
 * Platform-owned like the rest of the catalog. The coefficients are a claim about how
 * a kind of machine behaves, clients' alerts run against a version of that claim, and
 * a published chain is therefore immutable — a change publishes a new version rather
 * than moving the ground under alerts already configured.
 */
export class CausalChains1757870000000 implements MigrationInterface {
  name = 'CausalChains1757870000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "causal_chain" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "equipment_class_slug" text NOT NULL,
        "scenario_slug" text,
        "name" text NOT NULL,
        "description" text,
        "outcome" text,
        "nodes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "alignment_seconds" int,
        "provenance" text,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE UNIQUE INDEX "uq_causal_chain_version"
        ON "causal_chain" ("slug", "version")`);
    await q.query(`
      CREATE INDEX "ix_causal_chain_class" ON "causal_chain" ("equipment_class_slug")`);
    await q.query(`CREATE INDEX "ix_causal_chain_status" ON "causal_chain" ("status")`);

    await q.query(`
      ALTER TABLE "causal_chain" ADD CONSTRAINT "ck_causal_chain_status"
        CHECK ("status" IN ('draft', 'published', 'retired'))`);
    // A chain with no stages is not a chain, and it would evaluate to "nothing is
    // wrong" on every machine it was bound to.
    await q.query(`
      ALTER TABLE "causal_chain" ADD CONSTRAINT "ck_causal_chain_nodes"
        CHECK (jsonb_typeof("nodes") = 'array' AND jsonb_array_length("nodes") > 0)`);
    // Published means somebody stood behind the numbers, and the date says when.
    await q.query(`
      ALTER TABLE "causal_chain" ADD CONSTRAINT "ck_causal_chain_published"
        CHECK (("status" = 'published') = ("published_at" IS NOT NULL))`);

    // Platform-owned, like scenario_definition: no tenant column and no row-level
    // policy, because a chain belongs to no customer.
    //
    // Writable by the app role, and the boundary that keeps customers out is the
    // `catalog.write` capability rather than this grant — the same arrangement the
    // class and scenario tables arrived at. No DELETE: a published chain is immutable
    // and a retired one is still the thing somebody's alert was configured against.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "causal_chain" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "causal_chain"`);
  }
}
