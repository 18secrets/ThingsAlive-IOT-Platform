import { DataSource } from 'typeorm';
import { WindowReading } from '../src/alert/services/alert-rules';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { ShiftDefinition, Weekday } from '../src/shift/services/shift-window';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { aggregateAvailability, Availability, computeAvailability } from '../src/utilization/services/availability';
import { AvailabilityService } from '../src/utilization/services/availability.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** 08:00–16:00 UTC, every day. UTC so the arithmetic in these tests reads at a glance. */
const DAY_SHIFT: ShiftDefinition = { startMinute: 480, endMinute: 960, days: EVERY_DAY, timeZone: 'UTC' };

/**
 * A day a week ago, at UTC midnight. Relative rather than pinned: telemetry is
 * partitioned from a couple of months back, and a pinned date is the time bomb
 * `recommendation.spec.ts` turned into once the calendar passed it (fix/ci-green).
 */
const DAY = (() => {
  const d = new Date(Date.now() - 7 * 24 * HOUR);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
})();
const at = (hours: number) => new Date(DAY.getTime() + hours * HOUR);
const WHOLE_DAY = { from: at(0), to: at(24) };

/** `engine_running_status` every five minutes over [fromHour, toHour], inclusive of both ends. */
function running(fromHour: number, toHour: number, value = 1): WindowReading[] {
  const out: WindowReading[] = [];
  for (let t = at(fromHour).getTime(); t <= at(toHour).getTime(); t += 5 * MINUTE) {
    out.push({ signal: 'engine_running_status', value, sourceTimestamp: new Date(t).toISOString() });
  }
  return out;
}

/**
 * Running over [fromHour, toHour), then an explicit stop at toHour.
 *
 * A reading speaks for up to three reporting intervals after it (duty-cycle's carry),
 * so a fixture whose last word is "running" is credited 15 minutes past it. A machine
 * that stops says so; this is what one looks like.
 */
const runsThenStops = (fromHour: number, toHour: number) =>
  [...running(fromHour, toHour - 5 / 60), ...running(toHour, toHour, 0)];

describe('availability (pure) — the agreed definitions', () => {
  it('1. a machine running through its whole shift is available 1.0', () => {
    const a = computeAvailability([DAY_SHIFT], running(8, 16), WHOLE_DAY);
    expect(a.readiness).toBe('ready');
    expect(a.scheduledHours).toBe(8);
    expect(a.uptimeHours).toBe(8);
    expect(a.downtimeHours).toBe(0);
    expect(a.availability).toBe(1);
  });

  it('2. running half the scheduled window is 0.5, and downtime is the other half', () => {
    const readings = [...running(8, 11 + 55 / 60), ...running(12, 16, 0)];
    const a = computeAvailability([DAY_SHIFT], readings, WHOLE_DAY);
    expect(a.availability).toBe(0.5);
    expect(a.uptimeHours).toBe(4);
    expect(a.downtimeHours).toBe(4);
    expect(a.downtimeHours).toBe(a.scheduledHours / 2);
  });

  it('3. running outside the shift is unscheduled — not uptime, and availability never passes 1.0', () => {
    const a = computeAvailability([DAY_SHIFT], runsThenStops(6, 18), WHOLE_DAY);
    expect(a.uptimeHours).toBe(8);
    expect(a.unscheduledRunningHours).toBe(4);
    expect(a.availability).toBe(1);
  });

  it('4. no shift schedule is not_configured / no_shift_schedule, availability null — not 0%, not 100%', () => {
    const a = computeAvailability([], runsThenStops(8, 16), WHOLE_DAY);
    expect(a.readiness).toBe('not_configured');
    expect(a.reason).toBe('no_shift_schedule');
    expect(a.availability).toBeNull();
    expect(a.scheduledHours).toBe(0);
    // The machine still ran, with nothing scheduled — that is reported, not dropped.
    expect(a.unscheduledRunningHours).toBe(8);
  });

  it('5. a schedule but no telemetry in the period is not_available / no_readings — null, not 0', () => {
    const a = computeAvailability([DAY_SHIFT], [], WHOLE_DAY);
    expect(a.readiness).toBe('not_available');
    expect(a.reason).toBe('no_readings');
    expect(a.availability).toBeNull();
    expect(a.uptimeHours).toBeNull();
    // Downtime is not the whole schedule: a logger off the network is not a machine that was down.
    expect(a.downtimeHours).toBeNull();
    expect(a.scheduledHours).toBe(8);
  });

  it('5b. readings outside the period do not count as telemetry in it', () => {
    const a = computeAvailability([DAY_SHIFT], running(8, 16), { from: at(24), to: at(48) });
    expect(a.reason).toBe('no_readings');
  });

  it('7. a period that cuts a shift in half counts only the half inside it', () => {
    const a = computeAvailability([DAY_SHIFT], running(8, 16), { from: at(12), to: at(24) });
    expect(a.scheduledHours).toBe(4);
    expect(a.uptimeHours).toBe(4);
    expect(a.availability).toBe(1);
  });

  it('an overnight shift cut by the period end counts its first part only', () => {
    const night: ShiftDefinition = { startMinute: 1320, endMinute: 360, days: EVERY_DAY, timeZone: 'UTC' };
    const a = computeAvailability([night], running(22, 24), { from: at(12), to: at(24) });
    expect(a.scheduledHours).toBe(2);
    expect(a.availability).toBe(1);
  });

  it('a schedule with no window inside the period has no scheduled hours: no_shift_schedule, not a ratio over nothing', () => {
    const today = new Date(DAY).getUTCDay() as Weekday;
    const otherDays = EVERY_DAY.filter((d) => d !== today);
    const a = computeAvailability([{ ...DAY_SHIFT, days: otherDays }], running(8, 16), WHOLE_DAY);
    expect(a.reason).toBe('no_shift_schedule');
    expect(a.availability).toBeNull();
  });

  it('a logger that goes quiet mid-shift counts as downtime — scheduled, and nothing showed it running', () => {
    const a = computeAvailability([DAY_SHIFT], running(8, 12), WHOLE_DAY);
    expect(a.readiness).toBe('ready');
    // Four hours observed running, plus one carry interval (15 min) past the last sample.
    expect(a.uptimeHours).toBe(4.25);
    expect(a.downtimeHours).toBe(3.75);
  });
});

describe('availability (pure) — fleet aggregation', () => {
  const ready = (scheduled: number, uptime: number): Availability => ({
    scheduledHours: scheduled, uptimeHours: uptime, downtimeHours: scheduled - uptime,
    unscheduledRunningHours: 0, availability: uptime / scheduled, readiness: 'ready',
  });
  const unscheduled: Availability = {
    scheduledHours: 0, uptimeHours: null, downtimeHours: null, unscheduledRunningHours: 3,
    availability: null, readiness: 'not_configured', reason: 'no_shift_schedule',
  };

  it('6. three machines, one without a schedule: the sum covers two and the exclusion is counted', () => {
    const fleet = aggregateAvailability([ready(8, 8), ready(8, 4), unscheduled]);
    expect(fleet.machinesMeasured).toBe(2);
    expect(fleet.excluded).toEqual({ noShiftSchedule: 1, noReadings: 0 });
    expect(fleet.scheduledHours).toBe(16);
    expect(fleet.uptimeHours).toBe(12);
    expect(fleet.availability).toBe(0.75);
  });

  it('sums hours rather than averaging ratios — a 4-hour shift does not weigh as much as a 12-hour one', () => {
    // Averaging the ratios would give (1.0 + 0.5) / 2 = 0.75. The hours give 10 / 16.
    const fleet = aggregateAvailability([ready(4, 4), ready(12, 6)]);
    expect(fleet.availability).toBe(0.625);
  });

  it('a fleet with nothing measurable is null with a reason, never 0', () => {
    const fleet = aggregateAvailability([unscheduled]);
    expect(fleet.readiness).toBe('not_configured');
    expect(fleet.reason).toBe('no_shift_schedule');
    expect(fleet.availability).toBeNull();
    expect(aggregateAvailability([]).availability).toBeNull();
  });
});

describeDb('availability: the service against Postgres, as ta_app', () => {
  let ds: DataSource;
  let owner: DataSource;
  let service: AvailabilityService;

  const TENANT = 'acme';
  const SOURCE = 'iot-platform-1';
  const scope: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [DAY.toISOString().slice(0, 10)]);
    ds = await createAppDataSource();
    service = new AvailabilityService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'equipment_shift', 'device_projection', 'equipment_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  /** A machine, its logger, optionally a day shift, and optionally readings. */
  const seedMachine = (
    externalId: string,
    opts: { shift?: boolean; readings?: WindowReading[]; tenantId?: string; status?: 'active' | 'retired' } = {},
  ) => runTenantSpanning(owner, 'test fixture', async (m) => {
    const tenantId = opts.tenantId ?? TENANT;
    const imei = `imei-${tenantId}-${externalId}`;
    await m.getRepository(EquipmentProfile).save({
      tenantId, sourceSystem: SOURCE, externalId, tier: 'standard', readiness: {},
      status: opts.status ?? 'active', updatedBy: 'u-boss',
    });
    await m.getRepository(DeviceProjection).save({
      sourceSystem: SOURCE, externalId: `dev-${tenantId}-${externalId}`, tenantId, payload: {},
      sourceUpdatedAt: null, syncedAt: new Date(), checksum: 'c', status: 'live',
      imei, equipmentExternalId: externalId, name: null,
    });
    if (opts.shift) {
      await m.getRepository(EquipmentShift).save({
        tenantId, sourceSystem: SOURCE, externalId, name: 'Day',
        startMinute: DAY_SHIFT.startMinute, endMinute: DAY_SHIFT.endMinute,
        days: EVERY_DAY, timeZone: 'UTC', status: 'active',
      });
    }
    if (opts.readings?.length) {
      await m.getRepository(TelemetryReading).save(opts.readings.map((r) => ({
        tenantId, imei, signal: r.signal, value: r.value, unit: null,
        sourceTimestamp: new Date(r.sourceTimestamp), receivedAt: new Date(), source: 'live' as const,
      })));
    }
  });

  it('one machine: shift and telemetry read back through RLS to the same answer as the pure computation', async () => {
    await seedMachine('DG-1', { shift: true, readings: running(8, 16) });
    const a = await service.forEquipment(scope, { sourceSystem: SOURCE, externalId: 'DG-1' }, WHOLE_DAY);
    expect(a).toMatchObject({
      externalId: 'DG-1', readiness: 'ready', scheduledHours: 8, uptimeHours: 8, availability: 1,
    });
  });

  it('5. a scheduled machine with no telemetry is not_available / no_readings through the endpoint path too', async () => {
    await seedMachine('DG-1', { shift: true });
    const a = await service.forEquipment(scope, { sourceSystem: SOURCE, externalId: 'DG-1' }, WHOLE_DAY);
    expect(a.readiness).toBe('not_available');
    expect(a.reason).toBe('no_readings');
    expect(a.availability).toBeNull();
  });

  it('6. fleet of three, one without a schedule: hours from two, one excluded and counted', async () => {
    await seedMachine('DG-1', { shift: true, readings: running(8, 16) });
    await seedMachine('DG-2', { shift: true, readings: [...running(8, 11 + 55 / 60), ...running(12, 16, 0)] });
    await seedMachine('DG-3', { readings: running(8, 16) });

    const fleet = await service.forFleet(scope, WHOLE_DAY);
    expect(fleet.machinesMeasured).toBe(2);
    expect(fleet.excluded).toEqual({ noShiftSchedule: 1, noReadings: 0 });
    expect(fleet.scheduledHours).toBe(16);
    expect(fleet.uptimeHours).toBe(12);
    expect(fleet.availability).toBe(0.75);
    expect(fleet.machines.map((m) => m.externalId)).toEqual(['DG-1', 'DG-2', 'DG-3']);
  });

  it('a retired machine is not in the fleet: taken out of service is not unavailable', async () => {
    await seedMachine('DG-1', { shift: true, readings: running(8, 16) });
    await seedMachine('DG-OLD', { shift: true, status: 'retired' });
    const fleet = await service.forFleet(scope, WHOLE_DAY);
    expect(fleet.machines.map((m) => m.externalId)).toEqual(['DG-1']);
    expect(fleet.excluded.noReadings).toBe(0);
  });

  it('an operator sees only their machines; a machine outside their scope reads as absent', async () => {
    await seedMachine('DG-1', { shift: true, readings: running(8, 16) });
    await seedMachine('DG-2', { shift: true, readings: running(8, 16) });
    const operator: RequestScope = { ...scope, roles: ['operator'], equipmentIds: ['DG-1'] };

    const fleet = await service.forFleet(operator, WHOLE_DAY);
    expect(fleet.machines.map((m) => m.externalId)).toEqual(['DG-1']);

    await expect(service.forEquipment(operator, { sourceSystem: SOURCE, externalId: 'DG-2' }, WHOLE_DAY))
      .rejects.toThrow('No such equipment');
    const none = await service.forFleet({ ...operator, equipmentIds: [] }, WHOLE_DAY);
    expect(none.machines).toEqual([]);
  });

  it('another tenant\'s machine, shifts and telemetry are invisible to this one', async () => {
    await seedMachine('DG-1', { shift: true, readings: running(8, 16), tenantId: 'globex' });
    const fleet = await service.forFleet(scope, WHOLE_DAY);
    expect(fleet.machines).toEqual([]);
    await expect(service.forEquipment(scope, { sourceSystem: SOURCE, externalId: 'DG-1' }, WHOLE_DAY))
      .rejects.toThrow('No such equipment');
  });
});
