import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { Plant } from '../src/equipment/entities/plant.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { withTenantSession } from '../src/scope/tenant-session';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { detectBreakdowns, oeeOf, performanceOf, qualityOf, Sample } from '../src/utilization/services/oee';
import { OeeService, windowBounds } from '../src/utilization/services/oee.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIGRATION = 'Oee1759900000000';

/**
 * OEE (task QOEE1): three divisions chained so that each one's denominator is the one
 * above it's numerator — and the reason it is usually wrong is that somebody averaged
 * the ratios instead of summing the totals.
 */

// ===================================================================== the detector
describe('the breakdown detector: idle with fuel, inside a shift, past the threshold', () => {
  const T0 = Date.UTC(2026, 9, 5, 0, 0);
  const at = (h: number, m = 0) => T0 + h * HOUR + m * MIN;
  const shift = [{ start: at(6), end: at(16) }];
  /** Every five minutes from `from` to `to`, `value(t)` at each. */
  const series = (from: number, to: number, value: (t: number) => number): Sample[] => {
    const out: Sample[] = [];
    for (let t = from; t < to; t += 5 * MIN) out.push({ at: t, value: value(t) });
    return out;
  };
  const idleBetween = (a: number, b: number) => (t: number) => (t >= a && t < b ? 5 : 60);
  const detect = (load: Sample[], fuel: Sample[], scheduled = shift, until = at(18)) => detectBreakdowns({
    running: { signal: 'engine_load', samples: load, idleBound: 20 },
    availability: { signal: 'fuel_level', samples: fuel },
    scheduled, thresholdMinutes: 30, until,
  });
  const fuelled = series(at(0), at(23), () => 50);

  it('1. idle with fuel for 45 minutes inside a shift, threshold 30: one event of 45 minutes', () => {
    const events = detect(series(at(0), at(23), idleBetween(at(10), at(10, 45))), fuelled);
    expect(events).toHaveLength(1);
    expect((events[0].end - events[0].start) / MIN).toBe(45);
    expect(events[0]).toMatchObject({ start: at(10), open: false });
    expect(events[0].detectedFrom).toEqual({
      runningSignal: 'engine_load', runningValue: 5, availabilitySignal: 'fuel_level', availabilityValue: 50,
    });
  });

  it('2. idle with fuel for 20 minutes: no event', () => {
    expect(detect(series(at(0), at(23), idleBetween(at(10), at(10, 20))), fuelled)).toEqual([]);
  });

  it('3. idle with NO fuel for two hours: no event — waiting on a refuel is not a breakdown', () => {
    const load = series(at(0), at(23), idleBetween(at(10), at(12)));
    const empty = series(at(0), at(23), () => 0);
    expect(detect(load, empty)).toEqual([]);
    // The same two hours with fuel in the tank is one.
    expect(detect(load, fuelled)).toHaveLength(1);
  });

  it('4. idle for 45 minutes outside any shift: no event', () => {
    expect(detect(series(at(0), at(23), idleBetween(at(18), at(18, 45))), fuelled, shift, at(23))).toEqual([]);
  });

  it('5. a stoppage spanning the shift\'s end counts only its scheduled part', () => {
    const events = detect(series(at(0), at(23), idleBetween(at(15, 15), at(17))), fuelled);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: at(15, 15), end: at(16), open: false });
    // Twenty scheduled minutes of a two-hour stoppage are not a breakdown at all.
    expect(detect(series(at(0), at(23), idleBetween(at(15, 40), at(18))), fuelled)).toEqual([]);
  });

  it('6. still idle now, inside the shift: open, counting to now', () => {
    const events = detect(series(at(0), at(23), idleBetween(at(10), at(12))), fuelled, shift, at(10, 50));
    expect(events).toEqual([expect.objectContaining({ start: at(10), end: at(10, 50), open: true })]);
  });

  it('16. replaying over unchanged telemetry finds exactly the same events', () => {
    const load = series(at(0), at(23), (t) => (t >= at(8) && t < at(9) ? 5 : t >= at(13) && t < at(14, 10) ? 10 : 60));
    expect(detect(load, fuelled)).toEqual(detect(load, fuelled));
    expect(detect(load, fuelled)).toHaveLength(2);
  });
});

// ===================================================================== the arithmetic
describe('the arithmetic', () => {
  it('8. 6 L/h nominal, 10 L/h actual: Quality 0.60, waste 0.40 — the client\'s own example, exactly', () => {
    expect(qualityOf(6, 60, 10)).toMatchObject({
      value: 0.6, readiness: 'ready', nominalFuel: 6, wasteFraction: 0.4, wasteLitres: 4,
    });
  });

  it('9. 4 L/h actual against 6 L/h nominal: Quality 1.0, not 1.5', () => {
    expect(qualityOf(6, 60, 4)).toMatchObject({ value: 1, wasteFraction: 0, wasteLitres: 0 });
  });

  it('15. zero fuel over productive minutes: undefined_result — not a divide by zero, not infinity', () => {
    expect(qualityOf(6, 60, 0)).toMatchObject({ value: null, readiness: 'blocked', reason: 'undefined_result' });
  });

  it('performance is floored at 0, and says so rather than clamping quietly', () => {
    const p = performanceOf(90, 60);
    expect(p.value).toBe(0);
    expect(p.warning).toMatch(/breakdown_exceeds_available/);
  });

  it('OEE is null when any factor is, carrying the first blocking factor\'s reason', () => {
    expect(oeeOf([
      { value: 0.9, readiness: 'ready' }, { value: null, readiness: 'blocked', reason: 'insufficient_coverage' },
      { value: null, readiness: 'not_configured', reason: 'parameter_not_set' },
    ])).toEqual({ value: null, readiness: 'blocked', reason: 'insufficient_coverage' });
  });

  it('11. a month queried mid-month covers the elapsed days and does not extrapolate', () => {
    const now = new Date('2026-10-06T12:00:00.000Z');
    const w = windowBounds('month', now, now);
    expect(w).toEqual({ from: new Date('2026-10-01T00:00:00.000Z'), to: now, daysCovered: 6 });
  });
});

// ======================================================================= the service
describeDb('OEE end to end', () => {
  let owner: DataSource;
  let ds: DataSource;
  let oee: OeeService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const other: RequestScope = { tenantId: 'other', userId: 'u-other', roles: ['admin'], isPlatformRole: false };
  const SRC = 'iot-platform-1';
  const CLASS = 'oee-excavator';
  const MONDAY = Date.UTC(2026, 9, 5);
  const TUESDAY = MONDAY + DAY;
  const at = (day: number, h: number, m = 0) => day + h * HOUR + m * MIN;
  let plantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    oee = new OeeService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "breakdown_event", "telemetry_reading", "signal_binding_version", "equipment_shift",
        "device_projection", "tenant_parameter", "equipment_profile", "plant", "equipment_class_profile" CASCADE`,
    );
    plantId = (await owner.getRepository(Plant).save(owner.getRepository(Plant).create({
      tenantId: 'acme', code: 'north', name: 'North', status: 'active',
    }))).id;
    await owner.getRepository(EquipmentClassProfile).save({
      slug: CLASS, version: 1, name: 'Excavator', status: 'published', publishedAt: new Date(MONDAY),
      expectedSignals: ['engine_running_status', 'engine_load', 'fuel_level', 'fuel_consumption']
        .map((signal) => ({ signal, unit: 'x', required: true })),
      nominalFuelPerHour: 6, nominalFuelUnit: 'L/h', idleBreakdownThresholdMinutes: 30,
      runningSignal: 'engine_load', runningIdleBound: 20, availabilitySignal: 'fuel_level',
    });
  });

  const imei = (id: string) => `imei-${id}`;
  const machine = async (id: string, opts: { tenant?: string; shifts?: [number, number, number[]][]; bindFuel?: string | null } = {}) => {
    const tenant = opts.tenant ?? 'acme';
    const profile = await owner.getRepository(EquipmentProfile).save({
      tenantId: tenant, sourceSystem: SRC, externalId: id, equipmentClassSlug: CLASS, classVersion: 1,
      plantId: tenant === 'acme' ? plantId : null, tier: 'standard', commissionedAt: null, serviceIntervalHours: null,
      readiness: {}, updatedBy: 'u',
    });
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: SRC, externalId: `dev-${id}`, tenantId: tenant, payload: {}, sourceUpdatedAt: null,
      syncedAt: new Date(MONDAY), checksum: 'c', status: 'live', imei: imei(id), equipmentExternalId: id, name: null,
    });
    const units: Record<string, string> = {
      engine_running_status: 'state', engine_load: '%', fuel_level: '%', fuel_consumption: opts.bindFuel ?? 'L/h',
    };
    await owner.getRepository(SignalBindingVersion).save(Object.entries(units)
      .filter(([s]) => s !== 'fuel_consumption' || opts.bindFuel !== null)
      .map(([signal, unit], i) => ({
        tenantId: tenant, sourceSystem: SRC, externalId: id, signalKey: signal, measurementRole: signal,
        componentId: '', origin: 'physical' as const, imei: imei(id), channel: `ch${i}`, sensorInstanceId: null,
        canonicalUnit: unit, sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
        expectedPeriodSeconds: 300, isPrimary: true, status: 'active' as const, discoveredFrom: null,
        discoveredBy: 'manual' as const, approvedBy: 'u', approvedAt: new Date(MONDAY),
      })));
    for (const [i, [start, end, days]] of (opts.shifts ?? [[6 * 60, 16 * 60, [1]]]).entries()) {
      await owner.getRepository(EquipmentShift).save({
        tenantId: tenant, sourceSystem: SRC, externalId: id, name: `Shift ${i}`, startMinute: start, endMinute: end,
        days: days as any, timeZone: 'UTC', status: 'active', // eslint-disable-line @typescript-eslint/no-explicit-any
        scoredThrough: null, arrivalsThrough: null, createdBy: 'u', updatedBy: 'u',
      });
    }
    return profile;
  };

  /** A worked shift: engine on, every five minutes; load 60 except while idle (5);
   * fuel level `fuel`; burning `rate` L/h while working. */
  const work = async (id: string, from: number, to: number, o: { idle?: [number, number][]; fuel?: number; rate?: number; tenant?: string } = {}) => {
    const rows = [];
    for (let t = from; t < to; t += 5 * MIN) {
      const idle = (o.idle ?? []).some(([a, b]) => t >= a && t < b);
      for (const [signal, value] of [
        ['engine_running_status', 1], ['engine_load', idle ? 5 : 60],
        ['fuel_level', o.fuel ?? 50], ['fuel_consumption', o.rate ?? 6],
      ] as [string, number][]) {
        rows.push({
          tenantId: o.tenant ?? 'acme', imei: imei(id), signal, value, unit: null, sourceTimestamp: new Date(t),
          receivedAt: new Date(t), source: 'live' as const,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await owner.getRepository(TelemetryReading).save(rows.slice(i, i + 500));
  };
  const setParameter = (name: string, value: number, s: 'client' | 'equipment', ref: string | null, unit: string) =>
    owner.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ('acme', $1, $2, $3, $4::jsonb, $5, '2026-01-01', 'u')`,
      [s, ref, name, JSON.stringify(value), unit],
    );
  const ref = (externalId: string) => ({ sourceSystem: SRC, externalId });
  const AFTER_MONDAY = new Date(TUESDAY);

  it('a worked Monday: the chain, factor by factor, with each denominator the numerator above', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(r.availability).toMatchObject({ value: 1, readiness: 'ready', scheduledMinutes: 600, availableMinutes: 600 });
    expect(r.performance).toMatchObject({
      value: 0.8, breakdownMinutes: 120, breakdownCount: 1, openBreakdown: false, thresholdMinutes: 30, parameterSource: 'oem',
    });
    // Productive 480 minutes at 6 L/h nominal is 48 L; 48 L burned while working.
    expect(r.quality).toMatchObject({ value: 1, nominalFuel: 48, actualFuel: 48, parameterSource: 'oem' });
    expect(r.oee).toEqual({ value: 0.8, readiness: 'ready' });
    // OEE is productive ÷ scheduled × quality, with no separate calculation behind it.
    expect(r.oee.value).toBeCloseTo((600 - 120) / 600 * 1, 6);
  });

  it('6. an open breakdown counts to now and says it is open', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), new Date(at(MONDAY, 11)));
    expect(r.performance).toMatchObject({ breakdownMinutes: 60, openBreakdown: true });
    const [row] = await owner.query(`SELECT ended_at, duration_minutes FROM breakdown_event`);
    expect(row).toEqual({ ended_at: null, duration_minutes: null });
    // Later, once it has ended, the same row closes — at its real end.
    await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(await owner.query(`SELECT ended_at, duration_minutes FROM breakdown_event`))
      .toEqual([{ ended_at: new Date(at(MONDAY, 12)), duration_minutes: 120 }]);
  });

  it('7. the threshold changes after an event was raised: the event keeps its own, and the value does not move', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 11)]] });
    const before = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(before.performance.breakdownMinutes).toBe(60);
    await setParameter('idle_breakdown_threshold_minutes', 90, 'client', null, 'min');
    const after = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(after.performance).toMatchObject({ breakdownMinutes: 60, thresholdMinutes: 90, parameterSource: 'client' });
    expect(await owner.query(`SELECT threshold_minutes FROM breakdown_event`)).toEqual([{ threshold_minutes: 30 }]);
  });

  it('10. weekly OEE over a 30-minute day and a 10-hour day is the summed totals, not the mean of the two days', async () => {
    await machine('EX-1', { shifts: [[6 * 60, 16 * 60, [1]], [6 * 60, 6 * 60 + 30, [2]]] });
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    await work('EX-1', at(TUESDAY, 6), at(TUESDAY, 6, 30));
    const now = new Date(TUESDAY + DAY);
    const monday = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), now);
    const tuesday = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(TUESDAY), now);
    const week = await oee.forEquipment(scope, ref('EX-1'), 'week', new Date(TUESDAY), now);
    expect([monday.oee.value, tuesday.oee.value]).toEqual([0.8, 1]);
    const meanOfRatios = (0.8 + 1) / 2;
    const summed = (480 + 30) / (600 + 30);
    expect(week.oee.value).toBeCloseTo(summed, 4);
    expect(week.oee.value).not.toBeCloseTo(meanOfRatios, 2);
    expect(week.daysCovered).toBe(2);
  });

  it('12. no shift schedule: no_shift_schedule, and all four values null', async () => {
    await machine('EX-1', { shifts: [] });
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16));
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    for (const factor of [r.availability, r.performance, r.quality, r.oee]) {
      expect(factor).toMatchObject({ value: null, readiness: 'not_configured', reason: 'no_shift_schedule' });
    }
  });

  it('13. no nominal at any scope: parameter_not_set — Availability and Performance still answer, OEE does not', async () => {
    await owner.query(`UPDATE equipment_class_profile SET nominal_fuel_per_hour = NULL, nominal_fuel_unit = NULL`);
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(r.availability.value).toBe(1);
    expect(r.performance.value).toBe(0.8);
    expect(r.quality).toMatchObject({ value: null, readiness: 'not_configured', reason: 'parameter_not_set' });
    expect(r.oee).toEqual({ value: null, readiness: 'not_configured', reason: 'parameter_not_set' });
  });

  it('14. a nominal at equipment and at client scope: equipment wins, and says so', async () => {
    const profile = await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { rate: 10 });
    await setParameter('nominal_fuel_per_hour', 4, 'client', null, 'L/h');
    await setParameter('nominal_fuel_per_hour', 5, 'equipment', profile.id, 'L/h');
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(r.quality).toMatchObject({ parameterSource: 'equipment', value: 0.5, nominalFuel: 50, actualFuel: 100 });
  });

  it('15. zero fuel consumed while working: undefined_result, never a divide by zero', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { rate: 0 });
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(r.quality).toMatchObject({ value: null, readiness: 'blocked', reason: 'undefined_result' });
    expect(r.oee.value).toBeNull();
  });

  it('refuses rather than converts: fuel in another unit is unit_mismatch; fuel unbound is unbound', async () => {
    await machine('EX-1', { bindFuel: 'gal/h' });
    await machine('EX-2', { bindFuel: null });
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16));
    await work('EX-2', at(MONDAY, 6), at(MONDAY, 16));
    expect((await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY)).quality)
      .toMatchObject({ value: null, readiness: 'not_configured', reason: 'unit_mismatch' });
    expect((await oee.forEquipment(scope, ref('EX-2'), 'day', new Date(MONDAY), AFTER_MONDAY)).quality)
      .toMatchObject({ value: null, readiness: 'not_configured', reason: 'unbound' });
  });

  it('fewer scheduled minutes than the threshold: insufficient_coverage, not a confident 100%', async () => {
    await machine('EX-1', { shifts: [[6 * 60, 6 * 60 + 20, [1]]] });
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 6, 20));
    const r = await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(r.performance).toMatchObject({ value: null, readiness: 'blocked', reason: 'insufficient_coverage' });
    expect(r.oee.value).toBeNull();
  });

  it('16. replaying the detector over unchanged telemetry leaves the rows exactly as they were', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 8), at(MONDAY, 9)], [at(MONDAY, 13), at(MONDAY, 14)]] });
    await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    const first = await owner.query(`SELECT * FROM breakdown_event ORDER BY started_at`);
    await oee.forEquipment(scope, ref('EX-1'), 'week', new Date(MONDAY), AFTER_MONDAY);
    await oee.breakdowns(scope, ref('EX-1'), new Date(MONDAY), AFTER_MONDAY, AFTER_MONDAY);
    expect(await owner.query(`SELECT * FROM breakdown_event ORDER BY started_at`)).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('two calls at once both settle, and each breakdown is written once', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    const results = await Promise.allSettled([
      oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY),
      oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT count(*)::int AS n FROM breakdown_event`)).toEqual([{ n: 1 }]);
  });

  it('17. RLS: a tenant cannot read another tenant\'s breakdown events', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    const seen = (s: RequestScope) => withTenantSession(ds, s, (m) => m.query(`SELECT count(*)::int AS n FROM breakdown_event`));
    expect(await seen(scope)).toEqual([{ n: 1 }]);
    expect(await seen(other)).toEqual([{ n: 0 }]);
    await expect(oee.breakdowns(other, ref('EX-1'), new Date(MONDAY), AFTER_MONDAY)).rejects.toThrow(/No such equipment/);
  });

  it('breakdown events only ever close: the database refuses rewriting a threshold or deleting a row', async () => {
    await machine('EX-1');
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    await oee.forEquipment(scope, ref('EX-1'), 'day', new Date(MONDAY), AFTER_MONDAY);
    await expect(owner.query(`UPDATE breakdown_event SET threshold_minutes = 60`)).rejects.toThrow(/breakdown_event_close_only/);
    await expect(owner.query(`DELETE FROM breakdown_event`)).rejects.toThrow(/breakdown_event_close_only/);
    await expect(owner.query(`SET LOCAL ta.bypass = 'on'; DELETE FROM breakdown_event`)).rejects.toThrow();
  });

  it('the client parameters refuse what the library refuses: a nominal of 0, a threshold under 5', async () => {
    await expect(setParameter('nominal_fuel_per_hour', 0, 'client', null, 'L/h')).rejects.toThrow(/ck_tenant_parameter_value/);
    await expect(setParameter('idle_breakdown_threshold_minutes', 4, 'client', null, 'min')).rejects.toThrow(/ck_tenant_parameter_value/);
    await expect(setParameter('idle_breakdown_threshold_minutes', 30.5, 'client', null, 'min')).rejects.toThrow(/ck_tenant_parameter_value/);
  });

  it('a site sums the ready machines and counts the rest by reason', async () => {
    await machine('EX-1');
    await machine('EX-2', { shifts: [] });
    await work('EX-1', at(MONDAY, 6), at(MONDAY, 16), { idle: [[at(MONDAY, 10), at(MONDAY, 12)]] });
    const site = await oee.forSite(scope, plantId, 'day', new Date(MONDAY), AFTER_MONDAY);
    expect(site).toMatchObject({
      oee: 0.8, availability: 1, performance: 0.8, quality: 1,
      machinesIncluded: 1, machinesExcluded: { no_shift_schedule: 1 },
    });
  });

  it(`down path (${MIGRATION}): the table is gone and the parameter check is back to before`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      expect(await owner.query(`SELECT to_regclass('breakdown_event') AS t`)).toEqual([{ t: null }]);
      // Without this migration's arm, a threshold of 4 is just a number. Rolled back:
      // tenant_parameter is append-only, and the row would fail this migration's check
      // on the way back up.
      const qr = owner.createQueryRunner();
      await qr.startTransaction();
      try {
        await qr.query(
          `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
             VALUES ('acme', 'client', NULL, 'idle_breakdown_threshold_minutes', '4'::jsonb, 'min', now(), 'u')`,
        );
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
