import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb } from './db';

/**
 * Task P0-10's sibling for schema: a migration with an untested down path is a
 * one-way door. This runs up, then down, then up again — the third step catches the
 * down path that drops less than it created, which the second step alone does not.
 */
describeDb('migrations', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  });

  afterAll(async () => { await ds?.destroy(); });

  const TABLES = [
    'tenant_map', 'equipment_projection', 'device_projection',
    'sensor_map_projection', 'projection_rejection', 'telemetry_reading',
    'platform_access_log',
  ];

  async function tableNames(): Promise<string[]> {
    const rows = await ds.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    return rows.map((r: any) => r.tablename);
  }

  it('creates every table on the way up', async () => {
    await ds.runMigrations({ transaction: 'all' });
    const names = await tableNames();
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('enforces the telemetry dedupe key at the database level', async () => {
    const idx = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_telemetry_reading_dedupe'`,
    );
    expect(idx).toHaveLength(1);
    // The exact columns matter: this is what stops a replay double-counting.
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/imei/);
    expect(idx[0].indexdef).toMatch(/signal/);
    expect(idx[0].indexdef).toMatch(/source_timestamp/);
  });

  it('leaves nothing behind on the way down', async () => {
    await ds.undoLastMigration({ transaction: 'all' });
    const names = await tableNames();
    for (const t of TABLES) expect(names).not.toContain(t);
  });

  it('runs up again cleanly after a down', async () => {
    // Catches a down path that drops tables but leaves an index, type or extension
    // behind — the failure that only shows up on the second deploy.
    await ds.runMigrations({ transaction: 'all' });
    const names = await tableNames();
    for (const t of TABLES) expect(names).toContain(t);
  });
});
