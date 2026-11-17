import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shift templates in the library (fuel test report, 3 Nov 2026: FU-3, TC-FP-08, Required
 * Design L-6): "Master: no shift templates or per-shift litres. Client Edit Equipment dialog
 * fields contain no shift/template/timezone."
 *
 * A machine's working day already lives in `equipment_shift`, one machine at a time, typed
 * in by hand on the machine page. A template is the library's named set of those shifts,
 * so a machine can be given its working day when it is created, in one choice, and a
 * prediction that needs shift hours has them from the first shift.
 *
 * Library content, like `equipment_class_profile`: global, no tenant, read by every account
 * and written only by the owner role (migrations, or a Master Admin route when one exists).
 * Applying a template copies its shifts onto the machine as ordinary `equipment_shift`
 * rows, which the account can then change. A later edit to the template changes no machine
 * (G13): the copy is the client's.
 *
 * One template is seeded, because its hours are not a guess: the existing platform's own
 * two shifts, 08:00–20:00 and 20:00–08:00 India time, every day — the boundaries D50's shift
 * totals and forecasts are keyed by (`SHIFT_1_IN`, `SHIFT_2_IN`).
 */
export class ShiftTemplates1763500000000 implements MigrationInterface {
  name = 'ShiftTemplates1763500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "shift_template" (
        "slug" text PRIMARY KEY,
        "name" text NOT NULL,
        "description" text,
        "shifts" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'published',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_shift_template_slug" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        CONSTRAINT "ck_shift_template_name" CHECK (btrim("name") <> ''),
        CONSTRAINT "ck_shift_template_status" CHECK ("status" IN ('published', 'retired')),
        -- At least one shift; each shift's hours are checked by the same rules a hand-typed
        -- shift is when the template is applied, so a malformed one cannot reach a machine.
        CONSTRAINT "ck_shift_template_shifts" CHECK (jsonb_typeof("shifts") = 'array' AND jsonb_array_length("shifts") >= 1)
      )`);
    await q.query(`GRANT SELECT ON "shift_template" TO "ta_app"`);

    await q.query(
      `INSERT INTO "shift_template" ("slug", "name", "description", "shifts") VALUES ($1, $2, $3, $4::jsonb)`,
      [
        'existing-platform-day-night',
        'Day and night, 12 hours each (India)',
        'The existing platform\'s two shifts: 08:00-20:00 and 20:00-08:00 Asia/Kolkata, every day. '
          + 'The same boundaries its shift fuel totals are kept by.',
        JSON.stringify([
          { name: 'Day', startMinute: 480, endMinute: 1200, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' },
          { name: 'Night', startMinute: 1200, endMinute: 480, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' },
        ]),
      ],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shift_template"`);
  }
}
