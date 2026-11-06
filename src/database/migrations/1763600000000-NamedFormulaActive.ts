import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A named formula can be made inactive (testing sheet TC_144/TC_151, 5 Nov 2026: "Need to
 * have a delete option").
 *
 * Not a delete. The catalogue migration already said why: `ta_app` has no DELETE on
 * `named_formula`, because a class or an account's KPI binds a formula by slug and version
 * with no foreign key, and a row removed from under them would leave a formula that no
 * longer says what it computes. Inactive is the soft delete: it leaves the library's picker
 * and refuses new bindings, while everything already bound keeps reading the same row.
 * It can be made active again.
 *
 * Active is a property of the formula, not of one version, so it is held on every version
 * and the database keeps them in step: at commit, a slug's versions are all active or all
 * inactive. Without that, a new version forked from an inactive formula would arrive
 * active and quietly bring it back into the picker. Checked at commit, not per row,
 * because switching a formula is one UPDATE across its versions and the rows pass through
 * a mixed state inside it.
 */
export class NamedFormulaActive1763600000000 implements MigrationInterface {
  name = 'NamedFormulaActive1763600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "named_formula"
        ADD COLUMN "active" boolean NOT NULL DEFAULT true,
        ADD COLUMN "deactivated_at" timestamptz,
        ADD COLUMN "deactivated_by" text,
        ADD CONSTRAINT "ck_named_formula_deactivated" CHECK ("active" OR "deactivated_at" IS NOT NULL)`);

    await q.query(`
      CREATE FUNCTION "named_formula_one_state"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(DISTINCT "active") FROM "named_formula" WHERE "slug" = NEW."slug") > 1 THEN
          RAISE EXCEPTION 'ck_named_formula_one_state: the versions of "%" are not all active or all inactive.', NEW."slug"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_named_formula_one_state';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER "tr_named_formula_one_state"
        AFTER INSERT OR UPDATE OF "active", "slug" ON "named_formula"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION "named_formula_one_state"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER "tr_named_formula_one_state" ON "named_formula"`);
    await q.query(`DROP FUNCTION "named_formula_one_state"()`);
    await q.query(`
      ALTER TABLE "named_formula"
        DROP CONSTRAINT "ck_named_formula_deactivated",
        DROP COLUMN "deactivated_by",
        DROP COLUMN "deactivated_at",
        DROP COLUMN "active"`);
  }
}
