import { DataSource } from 'typeorm';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * `client_formula`'s own migration (task QGRANT0 §1, `ClientFormula1758080000000`).
 *
 * Seeded before migrating, against a tenant that already holds other client-owned
 * rows — row-level security and the down path are Postgres behaviour, not
 * something to trust from an empty table.
 */
describeDb('client_formula migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  it('enforces tenant isolation the same way client_scenario already does', async () => {
    await withTenantId(ds, 'acme', (m) => m.query(`
      INSERT INTO client_formula (tenant_id, client_equipment_class_slug, formula_key, kind, expression)
        VALUES ('acme', 'some-class', 'margin', 'empirical', '105 - x')`));

    const seenFromGlobex = await withTenantId(ds, 'globex', (m) => m.query(
      `SELECT count(*)::int FROM client_formula WHERE client_equipment_class_slug = 'some-class'`,
    ));
    expect(seenFromGlobex[0].count).toBe(0);

    const seenFromAcme = await withTenantId(ds, 'acme', (m) => m.query(
      `SELECT count(*)::int FROM client_formula WHERE client_equipment_class_slug = 'some-class'`,
    ));
    expect(seenFromAcme[0].count).toBe(1);
  });

  it('has a down path that leaves none of its own additions behind', async () => {
    await undoMigrationNamed(ds, 'ClientFormula1758080000000');

    const [{ count: tableCount }] = await ds.query(
      `SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'client_formula'`,
    );
    expect(tableCount).toBe(0);

    await ds.runMigrations({ transaction: 'all' });
  });
});
