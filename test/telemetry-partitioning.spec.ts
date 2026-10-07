import { DataSource } from 'typeorm';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { SensorMapProjection } from '../src/projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../src/projection/entities/projection-rejection.entity';
import { TELEMETRY_READING_V1, TelemetryBatchEnvelope } from '../src/projection/contracts/contracts';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/** Tests 9 and 10 unwind every migration back to TelemetryPartitioning and re-apply them,
 * so their cost grows with each migration added after it. Under a full test:db run the
 * merged main of 2026-10-06 (62 migrations) crossed jest's 5 s default. The same reason,
 * and the same figure, as migration.spec.ts's chain test. */
const UNWIND_TIMEOUT_MS = 30_000;

/**
 * Monthly partitioning of `telemetry_reading` against a real Postgres (task QPART1).
 *
 * Partition routing, a dedupe constraint that has to stay global rather than becoming
 * per-partition, a row-level-security policy that has to reach partitions the parent
 * never sees a query against, and a migration whose down path has to name its own
 * rows back — none of this is demonstrable anywhere but here.
 */
describeDb('telemetry_reading partitioning', () => {
  let owner: DataSource;

  const ACME = 'acme';
  const GLOBEX = 'globex';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
  }, 30_000);

  afterAll(async () => { await owner?.destroy(); });

  const partitionOf = (at: Date): string => {
    const y = at.getUTCFullYear();
    const m = String(at.getUTCMonth() + 1).padStart(2, '0');
    return `telemetry_reading_${y}_${m}`;
  };

  const insert = (row: {
    tenantId: string; imei: string; signal: string; value: number; sourceTimestamp: Date;
  }) => {
    const readings = owner.getRepository(TelemetryReading);
    return readings.save(readings.create({
      tenantId: row.tenantId, imei: row.imei, signal: row.signal, value: row.value,
      unit: null, sourceTimestamp: row.sourceTimestamp, receivedAt: row.sourceTimestamp,
      source: 'live',
    }));
  };

  describe('correctness', () => {
    beforeAll(async () => {
      // Explicit rather than relying on the migration's forward-only buffer, which
      // is built from whenever the suite actually runs — these fixed 2026 months
      // must exist regardless of the wall-clock date on the day this executes.
      for (const month of ['2026-01-01', '2026-02-01', '2026-03-01']) {
        await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
      }
    });
    beforeEach(async () => { await owner.query(`TRUNCATE TABLE "telemetry_reading"`); });

    it('1. lands a reading in the partition for its own month', async () => {
      const at = new Date('2026-03-15T10:00:00.000Z');
      const saved = await insert({
        tenantId: ACME, imei: 'imei-1', signal: 'coolant_temp_c', value: 80, sourceTimestamp: at,
      });

      const [row] = await owner.query(
        `SELECT tableoid::regclass::text AS part FROM "telemetry_reading" WHERE id = $1`, [saved.id],
      );
      expect(row.part).toBe(partitionOf(at));
    });

    it('2. still refuses a duplicate (imei, signal, source_timestamp), with other months already in play', async () => {
      const months = ['2026-01-10T00:00:00.000Z', '2026-02-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z'];
      for (const at of months) {
        await insert({
          tenantId: ACME, imei: 'imei-1', signal: 'coolant_temp_c', value: 80, sourceTimestamp: new Date(at),
        });
      }

      // Same key as the February row above — necessarily the same partition, since
      // the value that decides which partition and the value the constraint compares
      // are the same column. What this proves is that seeding three other months
      // first did not somehow give the index a blind spot.
      await expect(insert({
        tenantId: ACME, imei: 'imei-1', signal: 'coolant_temp_c', value: 999, sourceTimestamp: new Date(months[1]),
      })).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it('3. ensure_telemetry_partition called twice for the same month is a no-op the second time', async () => {
      const [a] = await owner.query(`SELECT ensure_telemetry_partition('2027-05-01'::date) AS name`);
      const [b] = await owner.query(`SELECT ensure_telemetry_partition('2027-05-19'::date) AS name`);
      expect(a.name).toBe('telemetry_reading_2027_05');
      expect(b.name).toBe('telemetry_reading_2027_05');

      const [{ n }] = await owner.query(
        `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'telemetry_reading_2027_05'`,
      );
      expect(n).toBe(1);
    });

    it('4. an insert for a month with no partition fails, loudly and recognisably', async () => {
      const farFuture = new Date('2045-01-01T00:00:00.000Z');
      await expect(insert({
        tenantId: ACME, imei: 'imei-1', signal: 'coolant_temp_c', value: 1, sourceTimestamp: farFuture,
      })).rejects.toThrow(/no partition of relation "telemetry_reading" found for row/);
    });
  });

  describe('isolation', () => {
    const at = new Date('2026-04-05T00:00:00.000Z');

    beforeAll(async () => { await owner.query(`SELECT ensure_telemetry_partition('2026-04-01'::date)`); });

    beforeEach(async () => {
      await owner.query(`TRUNCATE TABLE "telemetry_reading"`);
      await insert({
        tenantId: ACME, imei: 'imei-acme', signal: 'coolant_temp_c', value: 80, sourceTimestamp: at,
      });
      await insert({
        tenantId: GLOBEX, imei: 'imei-globex', signal: 'coolant_temp_c', value: 90, sourceTimestamp: at,
      });
    });

    it("5. a select through the parent, as ta_app under one tenant, never returns another tenant's rows", async () => {
      const rows: { tenant_id: string }[] = await withTenantId(
        owner, ACME, (m) => m.query(`SELECT tenant_id FROM "telemetry_reading"`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === ACME)).toBe(true);
    });

    it("6. a select against the partition directly, as ta_app under one tenant, also never returns another "
      + "tenant's rows — the failure mode this whole task exists to close", async () => {
      const partition = partitionOf(at);
      const rows: { tenant_id: string }[] = await withTenantId(
        owner, ACME, (m) => m.query(`SELECT tenant_id FROM "${partition}"`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === ACME)).toBe(true);
    });

    it('7. a partition created by ensure_telemetry_partition has RLS enabled, forced and policed — '
      + 'proven from the catalog, not by trusting the function', async () => {
      const [{ name }] = await owner.query(`SELECT ensure_telemetry_partition('2029-11-01'::date) AS name`);

      const [row] = await owner.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [name],
      );
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);

      const policies = await owner.query(
        `SELECT policyname FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`, [name],
      );
      expect(policies).toHaveLength(1);
    });
  });

  describe('pruning', () => {
    it('8. a bounded source_timestamp range names fewer partitions than the table has', async () => {
      await owner.query(`SELECT ensure_telemetry_partition('2026-03-01'::date)`);

      const [{ n: total }] = await owner.query(
        `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'telemetry_reading'::regclass`,
      );
      expect(total).toBeGreaterThan(3);

      const [plan] = await owner.query(
        `EXPLAIN (FORMAT JSON) SELECT * FROM "telemetry_reading"
           WHERE source_timestamp >= '2026-03-01' AND source_timestamp < '2026-04-01'`,
      );
      const planText = JSON.stringify(plan['QUERY PLAN']);
      const named = new Set([...planText.matchAll(/telemetry_reading_\d{4}_\d{2}/g)].map((m) => m[0]));
      // Assert on the plan's own account of which relations it touches, not on how
      // long the query happened to take.
      expect(named.size).toBeGreaterThan(0);
      expect(named.size).toBeLessThan(total);
    });
  });

  describe('the ingest path', () => {
    // Forward is already covered by the migration's own buffer and the daily
    // maintenance task; this is the path that has to work for an older month on
    // its own — a reconnecting logger's backlog, the legacy backfill (LEGACY_DB_*)
    // pulling months or years of real history. Bounded, because the same gap that
    // lets a legitimate backfill through also lets a device with a broken clock
    // reporting the year 2000 create a few hundred empty partitions.
    const RECEIVED_AT = new Date('2026-09-30T00:00:00.000Z');
    const IMEI = 'imei-ingest-bounds';

    beforeAll(async () => {
      await owner.query(`TRUNCATE TABLE "telemetry_reading"`);
      const sensors = owner.getRepository(SensorMapProjection);
      await sensors.save(sensors.create({
        sourceSystem: 'iot-platform-1', externalId: `sm-${IMEI}`, tenantId: ACME,
        payload: {}, checksum: 'c', imei: IMEI, signal: 'coolant_temp_c', sensorName: null, unit: null,
      }));
    });

    const batch = (sourceTimestamp: Date): TelemetryBatchEnvelope => ({
      contract: TELEMETRY_READING_V1,
      sourceSystem: 'iot-platform-1',
      source: 'live',
      readings: [{
        imei: IMEI, signal: 'coolant_temp_c', value: 80, sourceTimestamp: sourceTimestamp.toISOString(),
      }],
    });

    it('a reading 400 days old is accepted, and lands in the partition for its own month', async () => {
      const at = new Date(RECEIVED_AT.getTime() - 400 * 86_400_000);
      const telemetry = new TelemetryService(owner);

      const result = await telemetry.ingest(batch(at), RECEIVED_AT);
      expect(result).toMatchObject({ accepted: 1, rejected: 0 });

      const [row] = await owner.query(
        `SELECT tableoid::regclass::text AS part FROM "telemetry_reading" WHERE imei = $1`, [IMEI],
      );
      expect(row.part).toBe(partitionOf(at));
    });

    it('a reading 10 years old is refused, with a reason recorded, and no partition is built for it', async () => {
      const at = new Date(RECEIVED_AT.getTime() - 365 * 10 * 86_400_000);
      const telemetry = new TelemetryService(owner);

      const result = await telemetry.ingest(batch(at), RECEIVED_AT);
      expect(result).toMatchObject({ accepted: 0, rejected: 1 });

      // Refused before ensure_telemetry_partition was ever called for its month —
      // not merely refused to insert after building one it did not need.
      const [{ exists }] = await owner.query(
        `SELECT to_regclass('public.' || $1) IS NOT NULL AS exists`, [partitionOf(at)],
      );
      expect(exists).toBe(false);

      const rejection = await owner.getRepository(ProjectionRejection).findOneOrFail({
        where: { kind: 'telemetry', externalId: IMEI },
      });
      expect(rejection.reason).toMatch(/more than 24 months before it arrived/);
    });
  });

  describe('the migration', () => {
    const MIGRATION = 'TelemetryPartitioning1758030000000';

    it("9. preserves the row count across the up path, seeded before migrating with three months' "
      + 'worth of data spanning partition boundaries', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      // The down path carries over whatever the earlier describe blocks in this
      // file left behind — a clean base is what makes "3 before, 3 after" a
      // statement about this seed rather than about test order.
      await owner.query(`TRUNCATE TABLE "telemetry_reading"`);

      // The plain, unpartitioned shape the migration inherits — seeded directly by
      // SQL rather than through the entity, since the entity now describes the
      // *partitioned* shape and this table, for the moment, is not that.
      const months = ['2026-01-20T00:00:00.000Z', '2026-02-20T00:00:00.000Z', '2026-03-20T00:00:00.000Z'];
      for (const [i, at] of months.entries()) {
        await owner.query(
          `INSERT INTO "telemetry_reading" (tenant_id, imei, signal, value, source_timestamp, received_at)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [ACME, `imei-seed-${i}`, 'coolant_temp_c', 80 + i, new Date(at)],
        );
      }

      const [{ count: before }] = await owner.query(`SELECT count(*)::int AS count FROM "telemetry_reading"`);
      expect(before).toBe(3);

      // If this throws, the test fails with the real error, exactly the shape of
      // regression DeclaredKindIsOptional1758020000000 taught: a migration test that
      // starts from an empty table only proves the SQL parses.
      await owner.runMigrations({ transaction: 'all' });

      const [{ count: after }] = await owner.query(`SELECT count(*)::int AS count FROM "telemetry_reading"`);
      expect(after).toBe(3);

      const parts: { relname: string }[] = await owner.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'telemetry_reading'::regclass`,
      );
      // 12 months ahead of whenever this actually runs, plus the seeded January —
      // a floor rather than an exact count, since "ahead" moves with the wall clock.
      expect(parts.length).toBeGreaterThanOrEqual(13);
    }, UNWIND_TIMEOUT_MS);

    it('10. the down path restores a plain table with the original primary key and the same rows', async () => {
      const [{ count: before }] = await owner.query(`SELECT count(*)::int AS count FROM "telemetry_reading"`);
      expect(before).toBe(3); // carried over from the previous test, deliberately.

      await undoMigrationNamed(owner, MIGRATION);

      const [{ relkind }] = await owner.query(`SELECT relkind FROM pg_class WHERE relname = 'telemetry_reading'`);
      expect(relkind).toBe('r'); // an ordinary table again, not 'p' partitioned.

      const pkCols: { attname: string }[] = await owner.query(`
        SELECT a.attname FROM pg_index x
          JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY(x.indkey)
         WHERE x.indrelid = 'telemetry_reading'::regclass AND x.indisprimary`);
      expect(pkCols.map((r) => r.attname)).toEqual(['id']);

      const [{ count: after }] = await owner.query(`SELECT count(*)::int AS count FROM "telemetry_reading"`);
      expect(after).toBe(before);

      // Leaves the chain forward, matching the convention `migration.spec.ts` closes
      // its own down-path assertions with.
      await owner.runMigrations({ transaction: 'all' });
    }, UNWIND_TIMEOUT_MS);
  });
});
