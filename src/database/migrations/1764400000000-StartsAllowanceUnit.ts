import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A maker's starts allowance is a number of starts (Crompton POC T8).
 *
 * ModelRatings gave `max_starts_per_hour` no unit, as a pure number. A start count is
 * measured in starts, so the alert that reads `starts_last_hour` against it, and any
 * formula comparing the two, was refused for comparing different units — correctly, by
 * the rules, and uselessly. The allowance is "starts in an hour", the hour being in the
 * name, so its unit is `starts`, the same as the count it is compared with.
 *
 * Reference data, changed here rather than in ModelRatings, which is committed.
 */
export class StartsAllowanceUnit1764400000000 implements MigrationInterface {
  name = 'StartsAllowanceUnit1764400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "rating_parameter" SET "unit" = 'starts' WHERE "name" = 'max_starts_per_hour'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "rating_parameter" SET "unit" = NULL WHERE "name" = 'max_starts_per_hour'`);
  }
}
