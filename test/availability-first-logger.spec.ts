import { DataSource } from 'typeorm';
import { WindowReading } from '../src/alert/services/alert-rules';
import { RequestScope } from '../src/auth/types/request-scope';
import { ShiftDefinition, Weekday } from '../src/shift/services/shift-window';
import { computeAvailability } from '../src/utilization/services/availability';
import { AvailabilityService, firstLoggerBoundAt } from '../src/utilization/services/availability.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
/** 08:00–16:00 UTC, every day. */
const DAY_SHIFT: ShiftDefinition = { startMinute: 480, endMinute: 960, days: EVERY_DAY, timeZone: 'UTC' };

/** UTC midnight eight days ago, so the week below sits inside the telemetry partitions. */
const D0 = (() => {
  const d = new Date(Date.now() - 8 * 24 * HOUR);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
})();
const at = (hours: number) => new Date(D0.getTime() + hours * HOUR);
const WEEK = { from: at(0), to: at(7 * 24) };

/** `engine_running_status` every five minutes over [fromHour, toHour]. */
function running(fromHour: number, toHour: number, value = 1): WindowReading[] {
  const out: WindowReading[] = [];
  for (let t = at(fromHour).getTime(); t <= at(toHour).getTime(); t += 5 * MINUTE) {
    out.push({ signal: 'engine_running_status', value, sourceTimestamp: new Date(t).toISOString() });
  }
  return out;
}

/**
 * Availability judges only the schedule a logger was on the machine for. Before the first
 * logger was bound nothing could have shown the machine running, so those shifts are not
 * downtime (CROMPTON-01, 25 Nov 2026: 168 h of downtime for a logger fitted that morning).
 */
describe('availability from the first bound logger (pure)', () => {
  // The last day's shift, run end to end, then a stop.
  const lastDay = [...running(6 * 24 + 8, 6 * 24 + 16 - 5 / 60), ...running(6 * 24 + 16, 6 * 24 + 16, 0)];

  it('a logger bound on the last morning: one shift scheduled, not seven', () => {
    const a = computeAvailability([DAY_SHIFT], lastDay, WEEK, at(6 * 24 + 7));
    expect(a).toMatchObject({ readiness: 'ready', scheduledHours: 8, uptimeHours: 8, downtimeHours: 0, availability: 1 });
  });

  it('bound mid-shift: the shift counts from the binding, not from its start', () => {
    const a = computeAvailability([DAY_SHIFT], lastDay, WEEK, at(6 * 24 + 12));
    expect(a.scheduledHours).toBe(4);
    expect(a.uptimeHours).toBe(4);
  });

  it('no binding date given: the whole week counts, exactly as before', () => {
    const a = computeAvailability([DAY_SHIFT], lastDay, WEEK);
    expect(a).toMatchObject({ scheduledHours: 56, uptimeHours: 8, downtimeHours: 48 });
    expect(computeAvailability([DAY_SHIFT], lastDay, WEEK, null)).toEqual(a);
  });

  it('shifts, but the logger came after the period: unmeasured, not unconfigured and not 0%', () => {
    const a = computeAvailability([DAY_SHIFT], [], WEEK, at(8 * 24));
    expect(a).toMatchObject({ scheduledHours: 0, availability: null, readiness: 'not_available', reason: 'no_readings' });
  });

  it('no shifts at all is still no_shift_schedule, whatever the logger', () => {
    expect(computeAvailability([], lastDay, WEEK, at(6 * 24)).reason).toBe('no_shift_schedule');
  });
});

describeDb('availability from the first bound logger, through the service', () => {
  const TENANT = 'motors';
  const scope: RequestScope = { tenantId: TENANT, userId: 'u-admin', roles: ['super admin'], isPlatformRole: false };
  let owner: DataSource;
  let ds: DataSource;
  let service: AvailabilityService;

  const bind = (imei: string, from: Date, to: Date | null = null) => owner.query(
    `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
       origin, imei, channel, canonical_unit, valid_from, valid_to, is_primary, status, discovered_by, approved_by, approved_at)
     VALUES ($1, 'ta-2.0', 'PUMP-1', 'engine_running_status', 'engine_running_status', '', 'physical', $2, 'ch', 'dimensionless',
       $3, $4, true, 'active', 'manual', 'u', $3)`, [TENANT, imei, from, to]);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (let d = 0; d <= 8; d += 1) {
      await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [at(d * 24).toISOString().slice(0, 10)]);
    }
    ds = await createAppDataSource();
    service = new AvailabilityService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "telemetry_reading", "signal_binding_version", "equipment_shift" CASCADE`);
    await owner.query(`DELETE FROM "equipment_profile"`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, status)
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'basic', '{}', 'active')`, [TENANT]);
    await owner.query(
      `INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone, status)
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'Day', 480, 960, '{0,1,2,3,4,5,6}', 'UTC', 'active')`, [TENANT]);
  });

  const readings = (imei: string, rows: WindowReading[]) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT $1, $2, r.signal, r.value, null, r.at, now(), 'live'
       FROM jsonb_to_recordset($3::jsonb) AS r(signal text, value float8, at timestamptz)`,
    [TENANT, imei, JSON.stringify(rows.map((r) => ({ signal: r.signal, value: r.value, at: r.sourceTimestamp })))]);

  it('a pump whose logger was bound on the last morning is judged on that day\'s shift alone', async () => {
    await bind('862360079349887', at(6 * 24 + 7));
    await readings('862360079349887', [...running(6 * 24 + 8, 6 * 24 + 12 - 5 / 60), ...running(6 * 24 + 12, 6 * 24 + 12, 0)]);
    const a = await service.forEquipment(scope, { sourceSystem: 'ta-2.0', externalId: 'PUMP-1' }, WEEK);
    expect(a).toMatchObject({ readiness: 'ready', scheduledHours: 8, uptimeHours: 4, downtimeHours: 4, availability: 0.5 });
    // The fleet row the UI lists reads the same.
    const fleet = await service.forFleet(scope, WEEK);
    expect(fleet.machines[0]).toMatchObject({ scheduledHours: 8, downtimeHours: 4 });
  });

  it('the earliest of the machine\'s loggers is where judging starts', async () => {
    // MOTOR_001 first, replaced by the IMEI logger: one primary at a time.
    await bind('MOTOR_001', at(5 * 24), at(6 * 24 + 7));
    await bind('862360079349887', at(6 * 24 + 7));
    expect(await firstLoggerBoundAt(owner.manager, TENANT, { sourceSystem: 'ta-2.0', externalId: 'PUMP-1' })).toEqual(at(5 * 24));
  });

  it('a machine never given a logger has no start', async () => {
    expect(await firstLoggerBoundAt(owner.manager, TENANT, { sourceSystem: 'ta-2.0', externalId: 'PUMP-1' })).toBeNull();
  });
});
