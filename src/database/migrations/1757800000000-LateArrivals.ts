import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A second watermark, for readings that arrive after the shift they belong to.
 *
 * The loggers hold up to two days of telemetry while they are off the network and push
 * it when they come back. Those readings carry the logger's own timestamps, so they
 * land inside windows that have already been scored and moved past — and a watermark
 * on event time alone will never look at them again. The prediction made from whatever
 * happened to be online at the time stands for ever as the answer for the whole shift,
 * and nothing anywhere says so.
 *
 * `arrivals_through` is the newest arrival time a shift has accounted for. Anything
 * newer that belongs to an already-scored window rewinds `scored_through`, and the
 * ordinary machinery takes those windows again.
 *
 * Re-scoring appends rather than replacing, and that is worth knowing rather than
 * assuming. A prediction is keyed by the moment of the newest reading behind it, so a
 * window scored twice carries two rows: the thin answer made while the logger was
 * offline, and the fuller one once its buffer arrived. Both are true — the first was
 * the best available answer at the time — and the newest is the one that counts.
 * Tying a prediction to a shift window instead would make one shift carry one answer,
 * and is a change to a key that twelve slices of consumers depend on.
 */
export class LateArrivals1757800000000 implements MigrationInterface {
  name = 'LateArrivals1757800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "equipment_shift" ADD COLUMN "arrivals_through" timestamptz`);
    // Every shift that already exists starts from where its scoring got to, so the
    // first sweep after this deploys does not treat the entire backlog as late.
    await q.query(`UPDATE "equipment_shift" SET "arrivals_through" = "scored_through"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "equipment_shift" DROP COLUMN IF EXISTS "arrivals_through"`);
  }
}
