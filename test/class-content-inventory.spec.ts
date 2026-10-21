import { DataSource } from 'typeorm';
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, entriesMissingReason, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { createTestDataSource, describeDb } from './db';

/**
 * The declared inventory and the audit that keeps it honest (task QGRANT0 §2-3).
 *
 * `copy-on-grant.service.ts` was a hand-maintained list, and `equipment_class_formula`
 * had carried class content since QCE1 without ever being copied to a tenant —
 * found by reading the file, not by a failing test. This is the test that would
 * have caught it: it reads the live schema for any table scoped to one equipment
 * class and fails naming anything the inventory has no entry for.
 */
describeDb('class content inventory', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  it('names every class-referencing table currently in the schema — the §3 audit', async () => {
    const live = await findClassReferencingTables(ds.manager);
    // Reported in full, not just asserted empty — this is the list task QGRANT0
    // §3 asked for, independent of whether the inventory happens to cover it.
    // eslint-disable-next-line no-console
    console.log('§3 audit — class-referencing tables found in the live schema:', live);
    expect(live.length).toBeGreaterThan(0); // the mechanism itself is exercised, not vacuous

    const unlisted = auditClassContentTables(live, CLASS_CONTENT_INVENTORY);
    expect(unlisted).toEqual([]);
  });

  it('every exclude carries a reason — silence is not a disposition', () => {
    expect(entriesMissingReason(CLASS_CONTENT_INVENTORY)).toEqual([]);
  });

  it('a table with a class reference and no inventory entry fails, naming the table', () => {
    // Simulated rather than a real table: the mechanism under test is the
    // comparison itself, not schema introspection (already proven above).
    const withAnExtraTable = ['equipment_class_profile', 'a_newly_added_class_table'];
    const inventoryMissingIt = CLASS_CONTENT_INVENTORY.filter((e) => e.table !== 'a_newly_added_class_table');
    expect(auditClassContentTables(withAnExtraTable, inventoryMissingIt)).toEqual(['a_newly_added_class_table']);
  });
});
