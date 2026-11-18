import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What we last told Vani about an account's machines (integration guide §6.4).
 *
 * Vani answers a customer who phones in from the newest snapshot we pushed, and says
 * how old it is. The guide asks for a push whenever the picture materially changes,
 * not on a timer — so the link remembers a hash of what was last accepted, and a push
 * happens only when the picture now hashes differently.
 *
 * `snapshot_attempted_at` and `snapshot_error` are there so a refused or failed push
 * is visible on the row rather than only in a log, and so a Vani outage is retried at
 * a measured pace rather than on every pass. `snapshot_refused_hash` is the picture
 * Vani refused with a 422: the guide says never resend a refused body unchanged, so
 * that exact picture is not sent again — a changed one is.
 */
export class VaniSnapshot1763700000000 implements MigrationInterface {
  name = 'VaniSnapshot1763700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "vani_account_link"
        ADD COLUMN "snapshot_hash" text,
        ADD COLUMN "snapshot_pushed_at" timestamptz,
        ADD COLUMN "snapshot_attempted_at" timestamptz,
        ADD COLUMN "snapshot_error" text,
        ADD COLUMN "snapshot_refused_hash" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "vani_account_link"
        DROP COLUMN IF EXISTS "snapshot_refused_hash",
        DROP COLUMN IF EXISTS "snapshot_error",
        DROP COLUMN IF EXISTS "snapshot_attempted_at",
        DROP COLUMN IF EXISTS "snapshot_pushed_at",
        DROP COLUMN IF EXISTS "snapshot_hash"`);
  }
}
