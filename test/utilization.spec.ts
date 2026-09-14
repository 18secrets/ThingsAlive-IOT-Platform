import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SIGNALS } from '../src/common/signals';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { computeDutyCycle } from '../src/utilization/services/duty-cycle';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Duty cycle, stored and rolled up (task P4-05).
 *
 * The unit tests next door prove the arithmetic. These prove the three things that
 * only a database can: that re-measuring a window replaces the earlier answer rather
 * than filing a second one, that a rollup weights by hours rather than by shifts, and
 * that an operator is shown their own machines and nobody else's.
 */
describeDb('utilization', () => {
  let ds: DataSource;
  let owner: DataSource;
  let utilization: UtilizationService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['utilization.read', 'equipment.write'],
  };
  const operator: RequestScope = {
    tenantId: 'acme', userId: 'u-op', roles: ['operator'], isPlatformRole: false,
    capabilities: ['utilization.read'], equipmentIds: ['DG-1'],
  };
  const stranger: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['utilization.read'],
  };

  const DAY = '2026-09-14';
  const shiftA = '11111111-1111-1111-1111-111111111111';
  const shiftB = '22222222-2222-2222-2222-222222222222';

  let north: string;
  let south: string;

  const start = (hourUtc: number) => new Date(`${DAY}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`);

  /** A machine reporting once a minute for `minutes`, running or not. */
  const shift = (from: Date, minutes: number, running: number, utilized?: number) => {
    const readings = [];
    for (let i = 0; i < minutes; i += 1) {
      const at = new Date(from.getTime() + i * 60_000).toISOString();
      readings.push({ signal: SIGNALS.engineRunningStatus, value: running, unit: null, sourceTimestamp: at });
      if (utilized !== undefined) {
        readings.push({ signal: SIGNALS.utilizationStatus, value: utilized, unit: null, sourceTimestamp: at });
      }
    }
    return readings;
  };

  const record = async (
    opts: {
      tenantId?: string; shiftId: string; externalId: string; from: Date; hours: number;
      readings: { signal: string; value: number; unit: string | null; sourceTimestamp: string }[];
    },
  ) => {
    const from = opts.from;
    const to = new Date(from.getTime() + opts.hours * 3600_000);
    return utilization.record({
      tenantId: opts.tenantId ?? 'acme',
      shiftId: opts.shiftId,
      shiftName: opts.shiftId === shiftA ? 'Morning' : 'Night',
      sourceSystem: CLIENT_SOURCE_SYSTEM,
      externalId: opts.externalId,
      localDate: DAY,
      duty: computeDutyCycle(opts.readings, from, to),
    });
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    utilization = new UtilizationService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['utilization_shift', 'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    south = (await plants.create(boss, { code: 'SOUTH', name: 'Southern yard' })).id;
    await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
    await equipment.create(boss, { code: 'DG-2', name: 'Generator 2', plantId: south });
  });

  it('copies the site and class onto the row rather than joining at read time', async () => {
    const row = await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    expect(row.plantId).toBe(north);
    expect(row.productiveSeconds).toBeGreaterThan(8 * 3600 * 0.99);

    // The machine moves. Last week's hours stay where they were worked — a join
    // would move them to the new site and a site manager would find a quarter they
    // could not reconcile with their own records.
    await equipment.move(
      boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' }, south,
      'Moved to the southern yard for the winter.',
    );
    const [again] = await utilization.forEquipment(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' });
    expect(again.plantId).toBe(north);
  });

  it('replaces the measurement when a window is measured again', async () => {
    // The thin answer first: a third of the shift reported, the rest of it dark.
    const thin = await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 160, 1, 1),
    });
    expect(thin.coverage).toBeLessThan(0.4);

    // Then the logger reconnects and pushes its buffer, and the window is rewound.
    const full = await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    expect(full.coverage).toBeGreaterThan(0.99);

    // One row, not two. A measurement of a fixed interval has one right answer, and
    // leaving both would put two contradictory accounts of Monday in the same report.
    const rows = await utilization.forEquipment(boss, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(thin.id);
    expect(rows[0].productiveSeconds).toBeGreaterThan(8 * 3600 * 0.99);
  });

  it('weights a rollup by hours worked, not by shifts worked', async () => {
    // Twelve hours idling and four hours working flat out. Averaging the two rates
    // gives 50%; the machine actually ran for four of sixteen hours.
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 12,
      readings: shift(start(0), 720, 0),
    });
    await record({
      shiftId: shiftB, externalId: 'DG-1', from: start(12), hours: 4,
      readings: shift(start(12), 240, 1, 1),
    });

    const [row] = await utilization.summary(boss, { groupBy: 'equipment' });
    expect(row.key).toBe('DG-1');
    expect(row.shifts).toBe(2);
    expect(row.utilizationRate).toBeGreaterThan(0.24);
    expect(row.utilizationRate).toBeLessThan(0.26);
  });

  it('rolls up by site', async () => {
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    await record({
      shiftId: shiftA, externalId: 'DG-2', from: start(0), hours: 8,
      readings: shift(start(0), 480, 0),
    });

    const byPlant = await utilization.summary(boss, { groupBy: 'plant' });
    expect(byPlant).toHaveLength(2);
    expect(byPlant.find((r) => r.key === north)!.utilizationRate).toBe(1);
    expect(byPlant.find((r) => r.key === south)!.utilizationRate).toBe(0);

    const justNorth = await utilization.summary(boss, { groupBy: 'equipment', plantId: north });
    expect(justNorth.map((r) => r.key)).toEqual(['DG-1']);
  });

  it('counts the shifts nobody could see instead of hiding them in the average', async () => {
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    // The machine was there and the logger was not.
    await record({ shiftId: shiftB, externalId: 'DG-1', from: start(12), hours: 8, readings: [] });

    const [row] = await utilization.summary(boss, { groupBy: 'equipment' });
    expect(row.shifts).toBe(2);
    expect(row.unobservedShifts).toBe(1);
    // The rate is still 1: the machine worked every hour anybody watched. Folding the
    // dark shift in as zero would report a machine at half utilization that in fact
    // has a connectivity problem, and send somebody to argue with the wrong person.
    expect(row.utilizationRate).toBe(1);
    expect(row.coverage).toBeLessThan(0.55);
  });

  it('shows an operator their own machines and nobody else\'s', async () => {
    for (const asset of ['DG-1', 'DG-2']) {
      await record({
        shiftId: shiftA, externalId: asset, from: start(0), hours: 8,
        readings: shift(start(0), 480, 1, 1),
      });
    }

    expect((await utilization.summary(boss, { groupBy: 'equipment' })).map((r) => r.key).sort())
      .toEqual(['DG-1', 'DG-2']);
    expect((await utilization.summary(operator, { groupBy: 'equipment' })).map((r) => r.key))
      .toEqual(['DG-1']);
    expect(await utilization.forEquipment(operator, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-2' }))
      .toEqual([]);
  });

  it('gives a caller entitled to nothing exactly that', async () => {
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    const nobody: RequestScope = { ...operator, equipmentIds: [] };
    expect(await utilization.summary(nobody, { groupBy: 'equipment' })).toEqual([]);
  });

  it('keeps one account\'s hours out of another\'s report', async () => {
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    expect(await utilization.summary(stranger, { groupBy: 'equipment' })).toEqual([]);
    expect(await utilization.forEquipment(stranger, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' }))
      .toEqual([]);
  });

  it('narrows a report to a date range', async () => {
    await record({
      shiftId: shiftA, externalId: 'DG-1', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    await record({
      shiftId: shiftB, externalId: 'DG-1', from: start(12), hours: 8,
      readings: shift(start(12), 480, 1, 1),
    });

    const afternoon = await utilization.summary(boss, { groupBy: 'shift', from: start(10) });
    expect(afternoon.map((r) => r.key)).toEqual(['Night']);
    // Half-open at the far end, so a window starting exactly at `to` belongs to the
    // next report rather than to both.
    const morning = await utilization.summary(boss, { groupBy: 'shift', to: start(12) });
    expect(morning.map((r) => r.key)).toEqual(['Morning']);
  });

  it('writes a row for a machine that is not in the register yet', async () => {
    // The uncommissioned machine is the one nobody is watching. A report that omits
    // it is a report that agrees with whoever forgot to register it.
    const row = await record({
      shiftId: shiftA, externalId: 'GHOST', from: start(0), hours: 8,
      readings: shift(start(0), 480, 1, 1),
    });
    expect(row.plantId).toBeNull();
    expect(row.equipmentClassSlug).toBeNull();
    const summary = await utilization.summary(boss, { groupBy: 'equipment' });
    expect(summary.map((r) => r.key)).toContain('GHOST');
  });

  it('refuses a grouping it does not recognise', async () => {
    await expect(utilization.summary(boss, { groupBy: 'plant_id"; DROP TABLE x --' as any }))
      .rejects.toThrow(/Cannot group utilization/);
  });
});
