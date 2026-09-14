import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SIGNALS } from '../src/common/signals';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { LinkState, assessLink } from '../src/device-health/services/link-health';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Storing and reading link verdicts (task P4-08).
 *
 * The part that needs a database is the run length. "Dark" for one window is a machine
 * parked in a shed over a weekend; "dark" for nine is a site visit, and without the
 * count every Monday produces a list of alarms that resolve themselves by lunchtime.
 */
describeDb('device link health', () => {
  let ds: DataSource;
  let owner: DataSource;
  let health: DeviceHealthService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const NOW = new Date('2026-09-14T00:00:00Z');
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['device.read', 'equipment.write'],
  };
  const operator: RequestScope = {
    tenantId: 'acme', userId: 'u-op', roles: ['operator'], isPlatformRole: false,
    capabilities: ['device.read'], equipmentIds: ['DG-1'],
  };
  const stranger: RequestScope = {
    tenantId: 'globex', userId: 'u-x', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['device.read'],
  };

  const IMEI_A = '860123456789001';
  const IMEI_B = '860123456789002';
  let north: string;

  /** Record one window `daysAgo` back, with readings shaped to force `state`. */
  const record = async (
    imei: string, externalId: string, daysAgo: number, state: LinkState,
  ) => {
    const start = new Date(NOW.getTime() - daysAgo * 86400_000);
    const endAt = new Date(start.getTime() + 8 * 3600_000);

    const steady = (minutes: number, signal: string, value: number, from = 0) =>
      Array.from({ length: minutes }, (_, i) => ({
        signal, value, unit: null,
        sourceTimestamp: new Date(start.getTime() + (from + i) * 60_000).toISOString(),
      }));

    const shapes: Record<string, { readings: any[]; expected: string[]; arrival: any }> = {
      healthy: {
        readings: [...steady(480, SIGNALS.engineRunningStatus, 1),
          ...steady(480, SIGNALS.gsmSignalStrength, -70)],
        expected: [SIGNALS.engineRunningStatus, SIGNALS.gsmSignalStrength],
        arrival: { count: 960, medianLagSeconds: 10, maxLagSeconds: 30 },
      },
      dark: {
        readings: [], expected: [SIGNALS.engineRunningStatus],
        arrival: { count: 0, medianLagSeconds: 0, maxLagSeconds: 0 },
      },
      intermittent: {
        readings: [...steady(200, SIGNALS.engineRunningStatus, 1),
          ...steady(100, SIGNALS.engineRunningStatus, 1, 380)],
        expected: [SIGNALS.engineRunningStatus],
        arrival: { count: 300, medianLagSeconds: 10, maxLagSeconds: 30 },
      },
      'weak-signal': {
        readings: [...steady(479, SIGNALS.gsmSignalStrength, -75),
          { signal: SIGNALS.gsmSignalStrength, value: -106, unit: null,
            sourceTimestamp: new Date(start.getTime() + 479 * 60_000).toISOString() }],
        expected: [SIGNALS.gsmSignalStrength],
        arrival: { count: 480, medianLagSeconds: 10, maxLagSeconds: 30 },
      },
    };
    const shape = shapes[state] ?? shapes.healthy;

    const assessed = assessLink({
      windowStart: start, windowEnd: endAt,
      readings: shape.readings, expectedSignals: shape.expected, arrival: shape.arrival,
    });
    expect(assessed.state).toBe(state);

    return health.record({
      tenantId: 'acme', imei, sourceSystem: CLIENT_SOURCE_SYSTEM, externalId,
      localDate: start.toISOString().slice(0, 10), health: assessed,
    });
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    health = new DeviceHealthService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['device_link_health', 'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
    await equipment.create(boss, { code: 'DG-2', name: 'Generator 2', plantId: north });
  });

  it('stores the verdict with the site it happened at', async () => {
    const row = await record(IMEI_A, 'DG-1', 1, 'healthy');
    expect(row.state).toBe('healthy');
    expect(row.plantId).toBe(north);
    expect(row.signalScale).toBe('dbm');
    expect(row.signalBand).toBe('excellent');
  });

  it('replaces the verdict when a window is assessed again', async () => {
    const first = await record(IMEI_A, 'DG-1', 1, 'dark');
    const second = await record(IMEI_A, 'DG-1', 1, 'healthy');
    // One row, not two: a window has one right answer, and the second assessment is
    // the same window seen with the readings that had not arrived the first time.
    expect(second.id).toBe(first.id);
    expect((await health.forDevice(boss, IMEI_A))).toHaveLength(1);
    expect((await health.forDevice(boss, IMEI_A))[0].state).toBe('healthy');
  });

  it('never stores a band without the scale that gives it meaning', async () => {
    // -95 is fair on dBm and poor on CSQ. A band with no scale is a verdict nobody can
    // interpret, and the database refuses it.
    await expect(owner.query(
      `INSERT INTO "device_link_health"
         ("tenant_id","imei","source_system","external_id","local_date","window_start",
          "window_end","state","detail","signal_band")
       VALUES ('acme','x','client','DG-1','2026-09-14',$1,$2,'healthy','d','poor')`,
      [NOW, NOW],
    )).rejects.toThrow(/ck_device_link_health_band_needs_scale/);
  });

  it('counts how many consecutive windows a device has been in its state', async () => {
    // The number that separates a weekend in a shed from a site visit.
    for (const d of [1, 2, 3, 4]) await record(IMEI_A, 'DG-1', d, 'dark');
    const [row] = await health.fleet(boss, {}, NOW);
    expect(row.state).toBe('dark');
    expect(row.windowsInState).toBe(4);
  });

  it('resets the count when the state changed in between', async () => {
    // Dark, dark, healthy, dark, dark — the current run is two, not four. Counting
    // every dark window would turn a logger that recovered into a standing alarm.
    await record(IMEI_A, 'DG-1', 5, 'dark');
    await record(IMEI_A, 'DG-1', 4, 'dark');
    await record(IMEI_A, 'DG-1', 3, 'healthy');
    await record(IMEI_A, 'DG-1', 2, 'dark');
    await record(IMEI_A, 'DG-1', 1, 'dark');

    const [row] = await health.fleet(boss, {}, NOW);
    expect(row.state).toBe('dark');
    expect(row.windowsInState).toBe(2);
  });

  it('returns the newest window per device, worst first', async () => {
    await record(IMEI_A, 'DG-1', 2, 'dark');
    await record(IMEI_A, 'DG-1', 1, 'dark');
    await record(IMEI_B, 'DG-2', 1, 'healthy');

    const rows = await health.fleet(boss, {}, NOW);
    expect(rows.map((r) => r.imei)).toEqual([IMEI_A, IMEI_B]);
    expect(rows[0].state).toBe('dark');
  });

  it('puts the longest-standing fault first within a state', async () => {
    // Two dark loggers: the one dark for four windows is a different errand from the
    // one dark since this morning.
    for (const d of [1, 2, 3, 4]) await record(IMEI_A, 'DG-1', d, 'dark');
    await record(IMEI_B, 'DG-2', 1, 'dark');

    const rows = await health.fleet(boss, {}, NOW);
    expect(rows[0].imei).toBe(IMEI_A);
    expect(rows[0].windowsInState).toBe(4);
    expect(rows[1].windowsInState).toBe(1);
  });

  it('filters to the states somebody asked about', async () => {
    await record(IMEI_A, 'DG-1', 1, 'dark');
    await record(IMEI_B, 'DG-2', 1, 'healthy');
    expect((await health.fleet(boss, { states: ['dark'] }, NOW)).map((r) => r.imei))
      .toEqual([IMEI_A]);
    expect(await health.fleet(boss, { states: ['partial'] }, NOW)).toEqual([]);
  });

  it('ignores windows older than the look-back', async () => {
    await record(IMEI_A, 'DG-1', 30, 'dark');
    expect(await health.fleet(boss, { sinceDays: 7 }, NOW)).toEqual([]);
    expect(await health.fleet(boss, { sinceDays: 60 }, NOW)).toHaveLength(1);
  });

  it('shows an operator only the loggers on their own machines', async () => {
    await record(IMEI_A, 'DG-1', 1, 'dark');
    await record(IMEI_B, 'DG-2', 1, 'dark');
    expect((await health.fleet(operator, {}, NOW)).map((r) => r.imei)).toEqual([IMEI_A]);
    expect(await health.forDevice(operator, IMEI_B)).toEqual([]);
    expect(await health.forDevice(operator, IMEI_A)).toHaveLength(1);
  });

  it('keeps one account\'s loggers out of another\'s view', async () => {
    await record(IMEI_A, 'DG-1', 1, 'dark');
    expect(await health.fleet(stranger, {}, NOW)).toEqual([]);
    expect(await health.forDevice(stranger, IMEI_A)).toEqual([]);
  });

  it('carries the evidence a screen needs to explain itself', async () => {
    await record(IMEI_A, 'DG-1', 1, 'intermittent');
    const [row] = await health.fleet(boss, {}, NOW);
    expect(row.detail).toMatch(/Longest silence/);
    expect(row.longestGapSeconds).toBeGreaterThan(1800);
    expect(row.medianLagSeconds).toBe(10);
  });
});
