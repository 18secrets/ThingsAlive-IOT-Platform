import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The account's own time zone (test report MIN-12).
 *
 * Dates already read day-first; what they could not do was read in the customer's
 * clock. Every timestamp is stored in UTC and the UI had nothing to convert it with
 * except the browser's zone, so a manager travelling, or a Things Alive engineer in
 * another city, saw a different "today" from the plant's.
 *
 * On `tenant` rather than a table beside it. `delete_unused_tenant` refuses to delete
 * an account that holds a row in any tenant-owned table it does not name, so a side
 * table would have made every account with a time zone undeletable — the one place
 * where "a table beside it" (D06) costs more than it saves.
 *
 * Asia/Kolkata by default, because every account on the platform today runs plants in
 * India (the seed's shifts use it too). An account elsewhere sets its own.
 *
 * Checked in the database against the zone names Postgres itself knows, so a value the
 * UI could not convert with is refused by the row, not only by the service: a typo
 * stored here would quietly shift every date on every screen of that account.
 */
export class AccountTimeZone1764000000000 implements MigrationInterface {
  name = 'AccountTimeZone1764000000000';

  public async up(q: QueryRunner): Promise<void> {
    // IMMUTABLE so a CHECK may call it. Strictly the zone list can change with a tzdata
    // upgrade, but only by adding names; one that disappears is a renamed zone, and the
    // row keeps working as an alias in Postgres and in the browser alike.
    await q.query(`
      CREATE FUNCTION ta_is_time_zone(name text) RETURNS boolean
        LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
          SELECT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = $1)
        $$`);
    await q.query(`ALTER TABLE "tenant" ADD COLUMN "time_zone" text NOT NULL DEFAULT 'Asia/Kolkata'`);
    await q.query(`
      ALTER TABLE "tenant" ADD CONSTRAINT "ck_tenant_time_zone"
        CHECK (ta_is_time_zone("time_zone"))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "tenant" DROP CONSTRAINT IF EXISTS "ck_tenant_time_zone"`);
    await q.query(`ALTER TABLE "tenant" DROP COLUMN IF EXISTS "time_zone"`);
    await q.query(`DROP FUNCTION IF EXISTS ta_is_time_zone(text)`);
  }
}
