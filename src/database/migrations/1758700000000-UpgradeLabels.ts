import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two labels a class upgrade leaves behind (task QUPGRADE1).
 *
 * `orphaned_at`: the new class version no longer has this formula, failure mode or
 * recommendation. It is kept — a tenant's copy is theirs, and deleting what they may
 * rely on because Things Alive dropped it upstream is the side door D39 closes — and
 * labelled, so the screen can say it no longer comes from the library.
 *
 * `needs_recheck`: the schematic changed under an anchor the tenant placed by hand.
 * Its position is kept (D38: a marker somebody positioned is never moved silently),
 * but it may now point at the wrong part of a different picture.
 *
 * Whether a row is inherited, customised or tenant-added is not stored at all: it is
 * computed against the immutable template version the row came from, so it cannot
 * drift and needed no backfill guess for copies already in the field.
 */
export class UpgradeLabels1758700000000 implements MigrationInterface {
  name = 'UpgradeLabels1758700000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const table of ['client_formula', 'client_equipment_class_failure_mode', 'client_equipment_class_recommendation']) {
      await q.query(`ALTER TABLE "${table}" ADD COLUMN "orphaned_at" timestamptz`);
    }
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" ADD COLUMN "needs_recheck" boolean NOT NULL DEFAULT false`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" DROP COLUMN IF EXISTS "needs_recheck"`);
    for (const table of ['client_formula', 'client_equipment_class_failure_mode', 'client_equipment_class_recommendation']) {
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "orphaned_at"`);
    }
  }
}
