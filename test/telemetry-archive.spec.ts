import { ParquetReader } from '@dsnp/parquetjs';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DataSource } from 'typeorm';
import { withTenantId } from '../src/scope/tenant-session';
import { ArchiveStorage, UnconfiguredArchiveStorage } from '../src/telemetry/archive/archive-storage';
import { TelemetryArchiveService } from '../src/telemetry/archive/telemetry-archive.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'TelemetryArchive1760300000000';
const NOW = new Date('2026-10-14T00:00:00.000Z');

/** A bucket on local disk — and one that can be told to lose the end of what it is given. */
class DiskStorage implements ArchiveStorage {
  readonly configured = true;
  readonly root = mkdtempSync(join(tmpdir(), 'ta-bucket-'));
  truncate = false;
  async put(key: string, local: string) {
    const target = join(this.root, key);
    mkdirSync(dirname(target), { recursive: true });
    if (this.truncate) writeFileSync(target, readFileSync(local).subarray(0, 200));
    else copyFileSync(local, target);
  }
  async get(key: string, local: string) { copyFileSync(join(this.root, key), local); }
  has(key: string) { return existsSync(join(this.root, key)); }
}

/**
 * Telemetry past 90 days goes to Parquet and its partition is dropped — only once the
 * archive is proved, and every refusal here is attempted, not asserted to exist
 * (task QARCH1, D14).
 */
describeDb('telemetry archive: export, verify, then drop', () => {
  let owner: DataSource;
  let ds: DataSource;
  let bucket: DiskStorage;
  let archive: TelemetryArchiveService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const partitionExists = async (name: string) =>
    (await owner.query(`SELECT to_regclass($1) AS t`, [name]))[0].t !== null;
  const reading = (tenant: string, imei: string, signal: string, at: string, value: number) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ($1, $2, $3, $4, 'degC', $5, $5, 'live')`, [tenant, imei, signal, value, at],
  );

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "telemetry_archive", "telemetry_partition_drop", "signal_binding_version", "equipment_profile" CASCADE`);
    for (const month of ['2026-06-01', '2026-07-01']) await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    await owner.query(`TRUNCATE TABLE "telemetry_reading"`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
         VALUES ('acme', 'src', 'DG-1', 'standard', '{}'::jsonb, 'u')`,
    );
    // Bound from 10 June: readings before it have nothing to interpret them, and are still archived.
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', 'src', 'DG-1', 'coolant', 'coolant_temp', '', 'physical', 'imei-a', 'ch1', 'degC', '2026-06-10', true, 'active', 'manual', 'u', '2026-06-10')`,
    );
    await reading('acme', 'imei-a', 'coolant', '2026-06-05T10:00:00Z', 70);
    await reading('acme', 'imei-a', 'coolant', '2026-06-20T10:00:00Z', 80.25);
    await reading('acme', 'imei-a', 'coolant', '2026-06-21T10:00:00Z', 81);
    await reading('globex', 'imei-g', 'flow', '2026-06-15T10:00:00Z', 12);
    await reading('acme', 'imei-a', 'coolant', '2026-07-20T10:00:00Z', 90);
    bucket = new DiskStorage();
    archive = new TelemetryArchiveService(ds, bucket);
  });

  it('only months that ended more than 90 days ago are eligible (D14.4)', async () => {
    const months = (await archive.eligibleMonths(NOW)).map((d) => d.toISOString().slice(0, 7));
    expect(months).toContain('2026-06');
    expect(months).not.toContain('2026-07');
  });

  it('exports each account to its own prefix, verifies by reading back, then drops the partition', async () => {
    const result = await archive.run(NOW);
    const june = result.months.find((m) => m.month === '2026-06')!;
    expect(june).toMatchObject({ dropped: 4, archived: expect.arrayContaining([
      { tenantId: 'acme', rows: 3, part: 1 }, { tenantId: 'globex', rows: 1, part: 1 },
    ]) });
    expect(bucket.has('tenants/acme/telemetry/2026-06/part-1.parquet')).toBe(true);
    expect(bucket.has('tenants/globex/telemetry/2026-06/part-1.parquet')).toBe(true);
    expect(await partitionExists('telemetry_reading_2026_06')).toBe(false);
    expect(await partitionExists('telemetry_reading_2026_07')).toBe(true);
    const [drop] = await owner.query(`SELECT rows_dropped, proved_by FROM telemetry_partition_drop`);
    expect(Number(drop.rows_dropped)).toBe(4);
    expect(drop.proved_by.map((p: { tenantId: string }) => p.tenantId).sort()).toEqual(['acme', 'globex']);
  });

  it('archived rows are self-describing: the binding that interpreted each, or nothing where none did (D14.1)', async () => {
    await archive.run(NOW);
    const reader = await ParquetReader.openFile(join(bucket.root, 'tenants/acme/telemetry/2026-06/part-1.parquet'));
    const cursor = reader.getCursor();
    const rows: Record<string, unknown>[] = [];
    for (let r = await cursor.next(); r; r = await cursor.next()) rows.push(r as Record<string, unknown>);
    await reader.close();
    expect(rows.map((r) => [r.value, r.measurement_role ?? null, r.equipment_external_id ?? null, r.canonical_unit ?? null]))
      .toEqual([[70, null, null, null], [80.25, 'coolant_temp', 'DG-1', 'degC'], [81, 'coolant_temp', 'DG-1', 'degC']]);
    expect(rows.every((r) => r.tenant_id === 'acme')).toBe(true);
  });

  it('a truncated object fails verification, and the partition stays', async () => {
    bucket.truncate = true;
    const result = await archive.run(NOW);
    expect(result.months.find((m) => m.month === '2026-06')!.error).toMatch(/could not be read back|row\(s\)|checksum/);
    expect(await partitionExists('telemetry_reading_2026_06')).toBe(true);
    expect(await owner.query(`SELECT count(*)::int AS n FROM telemetry_reading_2026_06`)).toEqual([{ n: 4 }]);
    const archives = await owner.query(`SELECT verified_at, verify_error FROM telemetry_archive`);
    expect(archives.every((a: { verified_at: Date | null; verify_error: string | null }) => a.verified_at === null && a.verify_error)).toBe(true);
  });

  it('the database refuses to drop a month with no verified archive, whoever asks', async () => {
    await expect(ds.query(`SELECT drop_archived_telemetry_partition('2026-06-01')`)).rejects.toThrow(/no verified archive/);
    expect(await partitionExists('telemetry_reading_2026_06')).toBe(true);
  });

  it('a late arrival after archiving: the drop is refused until the month is exported again as the next part', async () => {
    await archive.archiveMonth(new Date('2026-06-01T00:00:00Z'), NOW);
    await reading('acme', 'imei-a', 'coolant', '2026-06-25T10:00:00Z', 79);
    await expect(archive.dropMonth(new Date('2026-06-01T00:00:00Z'))).rejects.toThrow(/4 row\(s\) for account acme/);
    const result = await archive.run(NOW);
    expect(result.months.find((m) => m.month === '2026-06')).toMatchObject({
      archived: [{ tenantId: 'acme', rows: 4, part: 2 }], dropped: 5,
    });
  });

  it('a second run does nothing new', async () => {
    await archive.run(NOW);
    const again = await archive.run(NOW);
    expect(again.months.map((m) => m.month)).not.toContain('2026-06');
    expect(await owner.query(`SELECT count(*)::int AS n FROM telemetry_archive`)).toEqual([{ n: 2 }]);
  });

  it('without a bucket it reports not_configured and touches nothing', async () => {
    const idle = new TelemetryArchiveService(ds, new UnconfiguredArchiveStorage());
    expect(await idle.run(NOW)).toEqual({ status: 'not_configured', months: [] });
    expect(await partitionExists('telemetry_reading_2026_06')).toBe(true);
  });

  it('an archive record can only point under its own account\'s prefix, and each account sees only its own', async () => {
    await archive.run(NOW);
    await expect(owner.query(
      `INSERT INTO telemetry_archive (tenant_id, month, part, object_key, row_count, checksum, byte_size, exported_at)
         VALUES ('acme', '2026-05-01', 1, 'tenants/globex/telemetry/2026-05/part-1.parquet', 1, 'x', 1, now())`,
    )).rejects.toThrow(/ck_telemetry_archive_prefix/);
    const seen = await withTenantId(ds, 'globex', (m) => m.query(`SELECT tenant_id FROM telemetry_archive`));
    expect(seen).toEqual([{ tenant_id: 'globex' }]);
  });

  it(`down path (${MIGRATION}): the tables and the drop function are gone`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      expect(await owner.query(`SELECT to_regclass('telemetry_archive') AS a, to_regclass('telemetry_partition_drop') AS d`))
        .toEqual([{ a: null, d: null }]);
      expect(await owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'drop_archived_telemetry_partition'`))
        .toEqual([{ n: 0 }]);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
