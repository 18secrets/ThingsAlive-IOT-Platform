import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `device_inventory.state` gets the constraint its vocabulary always implied
 * (task QFIX-DEVICES §3).
 *
 * The values are the ones `INVENTORY_TRANSITIONS` can produce — every state any
 * transition starts from or moves to — and the inventory service writes `state` only
 * through that table. Nothing in the database said so, though, and a fixture's
 * `'claimed'` went in unrefused during QPAGE1 and sat there until somebody corrected
 * it by hand. A column with a vocabulary and no constraint eventually holds a value
 * nothing can read; the database is the only place that refuses every writer.
 *
 * Now rather than later because the table is empty in Development today. A CHECK on
 * an empty table is free; after a customer's fleet is in it, it is a reconciliation.
 *
 * `device_inventory_event.from_state` / `to_state` carry the same vocabulary and are
 * left alone here: that table is append-only history, and constraining history is a
 * separate decision from constraining the current state.
 */
export class InventoryStateCheck1758600000000 implements MigrationInterface {
  name = 'InventoryStateCheck1758600000000';

  public async up(q: QueryRunner): Promise<void> {
    // Named rather than left to ADD CONSTRAINT's generic violation: if a row outside
    // the vocabulary did get in, whoever runs this needs the value, not the table name.
    const strays: { state: string; n: number }[] = await q.query(`
      SELECT "state", count(*)::int AS n FROM "device_inventory"
       WHERE "state" NOT IN ('in-stock', 'assigned', 'retired')
       GROUP BY "state"`);
    if (strays.length) {
      throw new Error(
        'device_inventory holds states outside the vocabulary — reconcile them before this migration: '
        + strays.map((s) => `"${s.state}" (${s.n})`).join(', '),
      );
    }
    await q.query(`
      ALTER TABLE "device_inventory" ADD CONSTRAINT "ck_device_inventory_state"
        CHECK ("state" IN ('in-stock', 'assigned', 'retired'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "device_inventory" DROP CONSTRAINT IF EXISTS "ck_device_inventory_state"`);
  }
}
