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
    'equipment_class_profile', 'scenario_definition',
    'signal_alias', 'client_catalog_entitlement', 'equipment_profile',
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
    // Every migration, not just the last one. Undoing one of two and finding the
    // first migration's tables still present would pass a weaker assertion while
    // proving nothing about the down path of anything but the newest file.
    await undoAll();
    const names = await tableNames();
    for (const t of TABLES) expect(names).not.toContain(t);
  });

  it('leaves no row-level-security policy behind either', async () => {
    // A dropped table takes its policies with it, so this only says something once
    // the tables are back: the check belongs after the second up, below.
    const policies = await ds.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies).toHaveLength(0);
  });

  it('runs up again cleanly after a down', async () => {
    // Catches a down path that drops tables but leaves an index, type or extension
    // behind — the failure that only shows up on the second deploy.
    await ds.runMigrations({ transaction: 'all' });
    const names = await tableNames();
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('re-applies row-level security on the second up', async () => {
    // The isolation policy is part of the schema, not a one-off setup step someone
    // runs by hand. If a rebuilt database came back without it, every tenant filter
    // would rest on application code alone and nothing would say so.
    const policies = await ds.query(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`,
    );
    // What this test owns is that a rebuilt database comes back guarded — whether the
    // guard list is *complete* is derived from the entity metadata in
    // rls-coverage.spec.ts, so a new tenant-owned table cannot pass by being absent
    // from a hand-maintained array in two places.
    const guarded = policies.map((p: any) => p.tablename).sort();
    for (const table of ['device_projection', 'equipment_projection',
      'sensor_map_projection', 'telemetry_reading']) {
      expect(guarded).toContain(table);
    }
    // FORCE, or the owner — which is who the service connects as — is exempt.
    const forced = await ds.query(
      `SELECT relname FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity AND relnamespace = 'public'::regnamespace`,
    );
    expect(forced).toHaveLength(0);
  });

  async function undoAll(): Promise<void> {
    while ((await ds.query(`SELECT to_regclass('public.migrations') IS NOT NULL AS present`))[0].present) {
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM migrations`);
      if (!count) break;
      await ds.undoLastMigration({ transaction: 'all' });
    }
  }
});
