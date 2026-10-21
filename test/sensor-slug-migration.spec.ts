import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * `sensor.slug` and the approval audit trail (task QIMP5, migration
 * `SensorSlugAndApprovals1758060000000`).
 *
 * The backfill runs one row at a time so two sensors whose names slugify to the same
 * base do not collide — the second gets `-2`, not a unique-index violation. Seeded
 * before the migration runs, against a table that already holds rows, because a
 * backfill that only works on an empty table is not a backfill.
 */
describeDb('sensor.slug backfill and approval audit trail', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); });

  it('backfills a collision safely, refuses a bad shape, and refuses a duplicate', async () => {
    await undoMigrationNamed(ds, 'SensorSlugAndApprovals1758060000000');

    // Two names that slugify to the same base, inserted in a known order — the
    // migration's own ORDER BY created_at, id decides which one keeps the plain slug.
    await ds.query(`INSERT INTO "sensor" (sensor_name) VALUES ('Coolant Temp!!')`);
    await new Promise((r) => setTimeout(r, 5));
    await ds.query(`INSERT INTO "sensor" (sensor_name) VALUES ('Coolant Temp??')`);
    await ds.query(`INSERT INTO "sensor" (sensor_name) VALUES ('Ordinary Probe')`);
    // Slugifies to '' before the fallback — every character is stripped.
    await ds.query(`INSERT INTO "sensor" (sensor_name) VALUES ('###')`);

    await ds.runMigrations({ transaction: 'all' });

    const rows: { sensor_name: string; slug: string }[] = await ds.query(
      `SELECT sensor_name, slug FROM "sensor" ORDER BY created_at`,
    );
    expect(rows.map((r) => r.slug)).toEqual([
      'coolant-temp', 'coolant-temp-2', 'ordinary-probe', 'sensor',
    ]);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);

    const [{ remaining }] = await ds.query(`SELECT count(*)::int AS remaining FROM "sensor" WHERE slug IS NULL`);
    expect(remaining).toBe(0);

    await expect(
      ds.query(`UPDATE "sensor" SET slug = 'Not Ok Slug!' WHERE sensor_name = 'Ordinary Probe'`),
    ).rejects.toThrow(/ck_sensor_slug_shape/);

    await expect(
      ds.query(`UPDATE "sensor" SET slug = 'coolant-temp' WHERE sensor_name = 'Ordinary Probe'`),
    ).rejects.toThrow(/uq_sensor_slug/);

    await expect(
      ds.query(`UPDATE "sensor" SET slug = NULL WHERE sensor_name = 'Ordinary Probe'`),
    ).rejects.toThrow(/null value in column "slug"/);
  });

  it('gives catalog_import_batch a sensor_decisions column, defaulted empty', async () => {
    const [{ id }] = await ds.query(
      `INSERT INTO catalog_import_batch (filename, checksum_sha256, template_version, uploaded_by)
       VALUES ('wb.xlsx', 'abc', 'v3', 'deepak') RETURNING id`,
    );
    const [{ sensor_decisions: decisions }] = await ds.query(
      `SELECT sensor_decisions FROM catalog_import_batch WHERE id = $1`, [id],
    );
    expect(decisions).toEqual([]);
  });

  it('has a down path that leaves none of its own additions behind', async () => {
    await undoMigrationNamed(ds, 'SensorSlugAndApprovals1758060000000');

    const [{ count: slugColumns }] = await ds.query(
      `SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'sensor' AND column_name = 'slug'`,
    );
    expect(slugColumns).toBe(0);

    const [{ count: decisionColumns }] = await ds.query(
      `SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'catalog_import_batch' AND column_name = 'sensor_decisions'`,
    );
    expect(decisionColumns).toBe(0);

    const [{ count: indexes }] = await ds.query(
      `SELECT count(*)::int FROM pg_indexes WHERE indexname = 'uq_sensor_slug'`,
    );
    expect(indexes).toBe(0);

    await ds.runMigrations({ transaction: 'all' });
  });
});
