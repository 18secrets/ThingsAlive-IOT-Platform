import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * The named formula catalogue's own migration (task QCE3,
 * `NamedFormulaCatalogue1758070000000`) — the table, the three new columns on
 * `equipment_class_formula`, and the seven seeded formulas.
 *
 * Seeded before migrating, against a table that already holds a row from an
 * earlier migration — the new columns are additive and nullable, but "additive"
 * is a claim worth proving against real prior content rather than trusting.
 */
describeDb('named formula catalogue migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  it('backfills nullable bind columns onto a row that predates them, and seeds seven published formulas', async () => {
    await undoMigrationNamed(ds, 'NamedFormulaCatalogue1758070000000');

    await ds.query(
      `INSERT INTO equipment_class_profile (slug, version, name, expected_signals)
       VALUES ('pre-existing-class', 1, 'Pre-existing Class', '[]'::jsonb)`,
    );
    await ds.query(
      `INSERT INTO equipment_class_formula (class_slug, class_version, formula_key, kind, expression)
       VALUES ('pre-existing-class', 1, 'old_formula', 'empirical', 'x + 1')`,
    );

    await ds.runMigrations({ transaction: 'all' });

    const [row] = await ds.query(
      `SELECT named_formula_slug, named_formula_version, bindings
         FROM equipment_class_formula WHERE formula_key = 'old_formula'`,
    );
    expect(row.named_formula_slug).toBeNull();
    expect(row.named_formula_version).toBeNull();
    expect(row.bindings).toEqual([]);

    const seeded = await ds.query(`SELECT slug, status, compiled_plan FROM named_formula ORDER BY slug`);
    expect(seeded).toHaveLength(7);
    for (const s of seeded) {
      expect(s.status).toBe('published');
      expect(s.compiled_plan).not.toBeNull();
    }
  });

  it('has a down path that leaves none of its own additions behind', async () => {
    await undoMigrationNamed(ds, 'NamedFormulaCatalogue1758070000000');

    const [{ count: tableCount }] = await ds.query(
      `SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'named_formula'`,
    );
    expect(tableCount).toBe(0);

    const columns = await ds.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'equipment_class_formula'
          AND column_name IN ('named_formula_slug', 'named_formula_version', 'bindings')`,
    );
    expect(columns).toHaveLength(0);

    await ds.runMigrations({ transaction: 'all' });
  });
});
