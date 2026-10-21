import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A site KPI declares how it combines its machines (task QPAGE1 §3).
 *
 * Required whenever `bound_to` is set and refused when it is not, with no default:
 * averaging a fuel total and summing a temperature are both silently plausible, and
 * an unstated aggregation is a wrong number nobody can see is wrong.
 *
 * A CHECK rather than a publish rule because site classes have no publish path —
 * QREC0b removed the authoring routes deliberately — and a rule with nowhere to run
 * is not a rule. The seeded default site class binds nothing, so it satisfies this
 * as it stands.
 */
export class SiteAggregate1758300000000 implements MigrationInterface {
  name = 'SiteAggregate1758300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "site_class_layout" ADD COLUMN "aggregate" text`);
    await q.query(`
      ALTER TABLE "site_class_layout" ADD CONSTRAINT "ck_site_layout_aggregate"
        CHECK ("aggregate" IS NULL OR "aggregate" IN ('sum', 'avg', 'min', 'max', 'count'))`);
    await q.query(`
      ALTER TABLE "site_class_layout" ADD CONSTRAINT "ck_site_layout_aggregate_declared"
        CHECK (("bound_to" IS NULL) = ("aggregate" IS NULL))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "site_class_layout" DROP CONSTRAINT IF EXISTS "ck_site_layout_aggregate_declared"`);
    await q.query(`ALTER TABLE "site_class_layout" DROP CONSTRAINT IF EXISTS "ck_site_layout_aggregate"`);
    await q.query(`ALTER TABLE "site_class_layout" DROP COLUMN IF EXISTS "aggregate"`);
  }
}
