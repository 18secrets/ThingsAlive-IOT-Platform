import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { ProjectionModule } from '../src/projection/projection.module';
import { ProjectionService } from '../src/projection/services/projection.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { ProjectionRejection } from '../src/projection/entities/projection-rejection.entity';
import { TenantMap } from '../src/projection/entities/tenant-map.entity';
import {
  EQUIPMENT_SNAPSHOT_V1, EquipmentSnapshotEnvelope, TELEMETRY_READING_V1, TelemetryBatchEnvelope,
} from '../src/projection/contracts/contracts';
import { TEST_DB, createTestDataSource, describeDb } from './db';
import { withTenantId } from '../src/scope/tenant-session';

const SOURCE = 'iot-platform-1';
const IMEI = '862211074240870';

function snapshot(mode: 'full' | 'delta', equipment: any[], extras: Partial<EquipmentSnapshotEnvelope> = {}): EquipmentSnapshotEnvelope {
  return {
    contract: EQUIPMENT_SNAPSHOT_V1,
    sourceSystem: SOURCE,
    mode,
    generatedAt: new Date().toISOString(),
    equipment,
    ...extras,
  } as EquipmentSnapshotEnvelope;
}

describeDb('projection + telemetry (P1-41 … P1-50)', () => {
  /** The services, on the constrained connection the running service uses. */
  let ds: DataSource;
  /** Schema and fixtures. ta_app can create nothing and may only read the tenant map. */
  let owner: DataSource;
  let projections: ProjectionService;
  let telemetry: TelemetryService;

  beforeAll(async () => {
    // Migrations first: they create the ta_app role, and the application pool asks
    // for it in its startup parameters — so a pool opened before this would not
    // connect at all.
    owner = await createTestDataSource();
    await resetSchema();

    const moduleRef = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dataSourceOptions(TEST_DB as any)), ProjectionModule],
    }).compile();
    ds = moduleRef.get(DataSource);
    projections = moduleRef.get(ProjectionService);
    telemetry = moduleRef.get(TelemetryService);
  });

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await resetSchema();
  });

  /**
   * Reads the way a request would: inside that tenant's session, so row-level
   * security applies. Querying the table directly returns nothing now, which would
   * make an assertion like `expect(thrice).toEqual(once)` pass on two empty results
   * — a test that proves the opposite of what it claims.
   */
  const asTenant = (sql: string, tenantId = 'tenant-7'): Promise<any[]> =>
    withTenantId(ds, tenantId, (m) => m.query(sql));

  async function resetSchema(): Promise<void> {
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.getRepository(TenantMap).save({
      sourceSystem: SOURCE, externalClientId: 'client-7', tenantId: 'tenant-7', displayName: 'Cemdindia',
    });
  }

  it('inserts on first apply and changes nothing on the second', async () => {
    const env = snapshot('delta', [
      { externalId: 'eq-1', externalClientId: 'client-7', name: 'DG Set 320 KVA', classId: 'diesel-generator' },
    ]);

    const first = await projections.apply(env);
    expect(first.equipment).toMatchObject({ inserted: 1, updated: 0, unchanged: 0, rejected: 0 });

    // Idempotence is the property that makes a sync safe to re-run after a failure.
    const second = await projections.apply(env);
    expect(second.equipment).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('updates only when the content actually changed', async () => {
    await projections.apply(snapshot('delta', [
      { externalId: 'eq-1', externalClientId: 'client-7', name: 'DG Set 320 KVA' },
    ]));
    const changed = await projections.apply(snapshot('delta', [
      { externalId: 'eq-1', externalClientId: 'client-7', name: 'DG Set 500 KVA' },
    ]));
    expect(changed.equipment).toMatchObject({ updated: 1, unchanged: 0 });
  });

  it('refuses a row whose client maps to no tenant, and keeps it visible', async () => {
    const res = await projections.apply(snapshot('delta', [
      { externalId: 'eq-1', externalClientId: 'client-7', name: 'Known' },
      { externalId: 'eq-2', externalClientId: 'client-unknown', name: 'Orphan' },
    ]));

    expect(res.equipment).toMatchObject({ inserted: 1, rejected: 1 });

    // Refused, not defaulted — an untenanted row is a row every tenant can read.
    const rejected = await ds.getRepository(ProjectionRejection).find();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].externalId).toBe('eq-2');
    expect(rejected[0].reason).toMatch(/client-unknown/);
  });

  it('marks rows missing when a full snapshot no longer reports them', async () => {
    await projections.apply(snapshot('full', [
      { externalId: 'eq-1', externalClientId: 'client-7' },
      { externalId: 'eq-2', externalClientId: 'client-7' },
    ]));

    // eq-2 disappears upstream. Marked, not deleted: 2.0 rows may reference it, and a
    // disappearance is itself worth seeing.
    const res = await projections.apply(snapshot('full', [
      { externalId: 'eq-1', externalClientId: 'client-7' },
    ]));
    expect(res.equipment.markedMissing).toBe(1);

    const rows = await asTenant(
      `SELECT external_id, status FROM equipment_projection ORDER BY external_id`,
    );
    expect(rows).toEqual([
      { external_id: 'eq-1', status: 'live' },
      { external_id: 'eq-2', status: 'missing' },
    ]);
  });

  it('does not mark anything missing on a delta snapshot', async () => {
    await projections.apply(snapshot('full', [
      { externalId: 'eq-1', externalClientId: 'client-7' },
      { externalId: 'eq-2', externalClientId: 'client-7' },
    ]));
    // A delta says "here is what changed", not "here is everything". Treating it as
    // the population would mark the whole fleet missing on the first partial sync.
    const res = await projections.apply(snapshot('delta', [
      { externalId: 'eq-1', externalClientId: 'client-7' },
    ]));
    expect(res.equipment.markedMissing).toBe(0);
  });

  describe('telemetry', () => {
    const readings = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        imei: IMEI,
        signal: 'fuel_consumption_lph',
        value: 20 + i,
        unit: 'L/h',
        sourceTimestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      }));

    const batch = (count: number, source: 'live' | 'replayed' = 'live'): TelemetryBatchEnvelope => ({
      contract: TELEMETRY_READING_V1,
      sourceSystem: SOURCE,
      source,
      readings: readings(count),
    });

    beforeEach(async () => {
      await projections.apply(snapshot('delta', [], {
        sensorMap: [{
          externalId: 'sm-1', externalClientId: 'client-7', imei: IMEI,
          signal: 'fuel_consumption_lph', unit: 'L/h',
        }],
      }));
    });

    it('ignores duplicates so a replay cannot double-count', async () => {
      // The test that protects every score downstream: a corrupted baseline is
      // invisible until someone asks why a healthy machine is flagged.
      const first = await telemetry.ingest(batch(100));
      expect(first).toMatchObject({ accepted: 100, duplicates: 0, rejected: 0 });

      const replayA = await telemetry.ingest(batch(100, 'replayed'));
      const replayB = await telemetry.ingest(batch(100, 'replayed'));
      expect(replayA).toMatchObject({ accepted: 0, duplicates: 100 });
      expect(replayB).toMatchObject({ accepted: 0, duplicates: 100 });

      const [{ count }] = await asTenant(`SELECT count(*)::int FROM telemetry_reading`);
      expect(count).toBe(100);
    });

    it('produces identical aggregates across one pass and three', async () => {
      await telemetry.ingest(batch(50));
      const once = await asTenant(
        `SELECT count(*)::int AS n, sum(value) AS total, avg(value) AS mean FROM telemetry_reading`,
      );
      await telemetry.ingest(batch(50));
      await telemetry.ingest(batch(50));
      const thrice = await asTenant(
        `SELECT count(*)::int AS n, sum(value) AS total, avg(value) AS mean FROM telemetry_reading`,
      );
      // Aggregates, not row counts: this is the shape a baseline actually reads.
      expect(thrice).toEqual(once);
    });

    it('keeps both clocks', async () => {
      const receivedAt = new Date('2026-09-02T10:00:00.000Z');
      await telemetry.ingest(batch(1), receivedAt);
      const [row] = await asTenant(
        `SELECT source_timestamp, received_at FROM telemetry_reading LIMIT 1`,
      );
      // Loggers drift and reconnect with backlogs, so these routinely differ.
      expect(new Date(row.source_timestamp).toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(new Date(row.received_at).toISOString()).toBe(receivedAt.toISOString());
    });

    it('refuses a reading for an unmapped device', async () => {
      const res = await telemetry.ingest({
        contract: TELEMETRY_READING_V1,
        sourceSystem: SOURCE,
        source: 'live',
        readings: [{
          imei: '999999999999999', signal: 'fuel_consumption_lph', value: 1,
          sourceTimestamp: new Date().toISOString(),
        }],
      });
      expect(res).toMatchObject({ accepted: 0, rejected: 1 });
    });
  });
});
