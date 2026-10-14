import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { baselineAvg, BASELINE_COVERAGE, Reading } from '../src/catalog/formula/baseline-operators';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { DEMO_SOURCE, DEMO_TENANT, seedDemo } from '../src/database/seeds/seed-demo';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { KpiEnvelope } from '../src/kpi/types';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { AvailabilityService } from '../src/utilization/services/availability.service';
import { computeDutyCycle, engineOnIntervals } from '../src/utilization/services/duty-cycle';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * QFIX-BASELINE: a baseline is computed over operating periods only.
 *
 * The 30-day baseline averaged a running engine and a parked one — two populations —
 * so the mean sat between the clusters and σ was the distance between them. A healthy
 * machine read +1.6σ every shift and −0.8σ every night, and a real excursion sat inside
 * the same band as that noise. It took seeded telemetry to see: on an empty database
 * every statistic looks fine.
 */

// ======================================================================= the one timeline
describe('engineOnIntervals is the duty cycle\'s own engine-on time, not a second account of it', () => {
  it('sums to engineOnSeconds over an irregular day, gaps and an outage included', () => {
    const start = new Date('2026-09-21T00:00:00.000Z');
    const readings = [];
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      if (minute > 600 && minute < 700) continue; // the logger off the network
      readings.push({
        signal: 'engine_running_status', value: Math.floor(minute / 90) % 3 === 0 ? 0 : 1,
        sourceTimestamp: new Date(start.getTime() + minute * 60_000).toISOString(),
      });
    }
    const end = new Date(start.getTime() + DAY);
    const intervals = engineOnIntervals(readings, start, end);
    const summed = intervals.reduce((s, i) => s + (i.end - i.start), 0) / 1000;
    expect(intervals.length).toBeGreaterThan(1);
    expect(summed).toBeCloseTo(computeDutyCycle(readings, start, end).engineOnSeconds, 3);
  });
});

// ================================================================ hand-built machines
describeDb('QFIX-BASELINE: the operating gate on hand-built machines', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-B' };
  const IMEI = 'imei-dg-b';
  const CLASS = 'baseline-genset';
  /** A Tuesday, noon UTC: inside the fixture's 06:00–18:00 shift. */
  const NOW = new Date('2026-09-22T12:00:00.000Z');
  const PARKED = 30;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'signal_binding_version', 'equipment_shift', 'device_projection',
      'equipment_profile', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: CLASS, name: 'Genset', description: null, category: 'power',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await owner.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: CLASS, classVersion: 1, tier: 'standard', commissionedAt: null,
      serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
    });
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: EQUIPMENT.sourceSystem, externalId: `dev-${EQUIPMENT.externalId}`, tenantId: 'acme',
      payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
      imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
    });
    await owner.getRepository(SignalBindingVersion).save(
      [['coolant_temp_c', 'degC', 'ch1'], ['engine_running_status', 'state', 'ch2']].map(([signal, unit, channel]) => ({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: signal, measurementRole: signal, componentId: '', origin: 'physical' as const, imei: IMEI, channel,
        sensorInstanceId: null, canonicalUnit: unit, sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
        expectedPeriodSeconds: 3600, isPrimary: true, status: 'active' as const,
        discoveredFrom: null, discoveredBy: 'manual' as const, approvedBy: 'u-master', approvedAt: NOW,
      })),
    );
    for (const [key, expression] of [
      ['coolant_z', 'zscore(coolant_temp_c, 20d)'],
      ['coolant_avg', 'baseline_avg(coolant_temp_c, 20d)'],
      ['coolant_sd', 'baseline_sd(coolant_temp_c, 20d)'],
    ]) {
      const compiled = compileFormula({
        formulaKey: key, expression, classSlug: CLASS, expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
      });
      await owner.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: key, kind: 'empirical', expression,
        compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
        resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals, requiredParameters: [],
        bindings: [], resultKind: compiled.resultKind, displayUnit: null, displayFormat: 'number:2',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
        aggregationWindow: '24h', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active',
        updatedBy: 'u-master',
      });
    }
  });

  const seedShift = () => owner.getRepository(EquipmentShift).save({
    tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId, name: 'Day',
    startMinute: 6 * 60, endMinute: 18 * 60, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC', status: 'active',
    scoredThrough: null, arrivalsThrough: null, createdBy: 'u-master', updatedBy: 'u-master',
  });

  /**
   * One coolant reading and one engine-state reading every hour for `days`, plus a
   * current pair six minutes before NOW. `running(t)` says whether the engine was on;
   * a running engine reads `value(t)`, a parked one sits at ambient.
   */
  const seedHistory = async (
    days: number, running: (t: Date) => boolean, value: (t: Date) => number = (t) => (t.getUTCHours() % 2 ? 81 : 79),
  ) => {
    const times: Date[] = [];
    for (let h = days * 24; h >= 1; h -= 1) times.push(new Date(NOW.getTime() - h * HOUR));
    times.push(new Date(NOW.getTime() - 0.1 * HOUR));
    const rows = times.flatMap((t) => {
      const on = running(t);
      return [
        { signal: 'engine_running_status', value: on ? 1 : 0, unit: 'state' },
        { signal: 'coolant_temp_c', value: on ? value(t) : PARKED, unit: 'degC' },
      ].map((r) => ({
        tenantId: 'acme', imei: IMEI, ...r, sourceTimestamp: t, receivedAt: NOW, source: 'live' as const,
      }));
    });
    for (let i = 0; i < rows.length; i += 500) await owner.getRepository(TelemetryReading).save(rows.slice(i, i + 500));
    return times;
  };
  const inShift = (t: Date) => t.getUTCHours() >= 6 && t.getUTCHours() < 18;
  const point = (e: KpiEnvelope) => (e.value as { v: number }[])[0].v;

  it('1. parked hours in the window: mean and σ come from operating readings only, and the parked ones were there', async () => {
    await seedShift();
    // The current reading sits on the mean, so σ is the ±1 alternation alone.
    const times = await seedHistory(21, inShift, (t) => (t.getTime() === NOW.getTime() - 0.1 * HOUR ? 80 : t.getUTCHours() % 2 ? 81 : 79));

    const parked = await owner.query(
      `SELECT count(*)::int AS n FROM telemetry_reading WHERE imei = $1 AND signal = 'coolant_temp_c' AND value = $2
         AND source_timestamp >= $3`,
      [IMEI, PARKED, new Date(NOW.getTime() - 20 * DAY)],
    );
    expect(parked[0].n).toBeGreaterThan(200);

    const avg = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_avg', NOW);
    const sd = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_sd', NOW);
    expect(avg.readiness).toBe('ready');
    expect(point(avg)).toBe(80);
    expect(point(sd)).toBeGreaterThan(0.99);
    expect(point(sd)).toBeLessThanOrEqual(1);

    // The same readings, ungated, are what the baseline used to learn from.
    const all: Reading[] = (await owner.query(
      `SELECT source_timestamp AS at, value FROM telemetry_reading WHERE imei = $1 AND signal = 'coolant_temp_c'`, [IMEI],
    )).map((r: any) => ({ at: new Date(r.at), value: Number(r.value) }));
    const ungated = baselineAvg(all, NOW, 20 * 24);
    expect(ungated.established && ungated.value).toBeLessThan(60);
    expect(times.length).toBe(21 * 24 + 1);
  });

  it('4. thirty days of history but almost no operating hours: blocked / insufficient_coverage, value null', async () => {
    await seedShift();
    // On three days only: plenty of readings those days, too few days to describe the machine.
    const onDays = new Set([5, 6, 7].map((d) => new Date(NOW.getTime() - d * DAY).toISOString().slice(0, 10)));
    await seedHistory(30, (t) => inShift(t) && onDays.has(t.toISOString().slice(0, 10)));
    for (const key of ['coolant_z', 'coolant_avg', 'coolant_sd']) {
      expect(await evaluator.evaluateOne(scope, EQUIPMENT, key, NOW))
        .toMatchObject({ readiness: 'blocked', reason: 'insufficient_coverage', value: null });
    }
  });

  it('4b. enough days, too few readings: one operating hour on each of ten days is still insufficient_coverage', async () => {
    await seedShift();
    const tenDays = new Set(Array.from({ length: 10 }, (_, d) => new Date(NOW.getTime() - (d + 2) * DAY).toISOString().slice(0, 10)));
    await seedHistory(30, (t) => t.getUTCHours() === 9 && tenDays.has(t.toISOString().slice(0, 10)));
    expect(10).toBeLessThan(BASELINE_COVERAGE.minOperatingReadings);
    expect(10).toBeGreaterThanOrEqual(BASELINE_COVERAGE.minOperatingDays);
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_avg', NOW))
      .toMatchObject({ readiness: 'blocked', reason: 'insufficient_coverage', value: null });
  });

  it('5. nine days of history: baseline_not_established, unchanged — not enough time, not too little operating', async () => {
    await seedShift();
    await seedHistory(9, inShift);
    for (const key of ['coolant_z', 'coolant_avg']) {
      expect(await evaluator.evaluateOne(scope, EQUIPMENT, key, NOW))
        .toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established', value: null });
    }
  });

  it('6. zero operating readings: insufficient_coverage — not a divide by zero, not a σ of 0', async () => {
    await seedShift();
    await seedHistory(30, () => false);
    for (const key of ['coolant_z', 'coolant_sd']) {
      expect(await evaluator.evaluateOne(scope, EQUIPMENT, key, NOW))
        .toMatchObject({ readiness: 'blocked', reason: 'insufficient_coverage', value: null });
    }
  });

  it('7. σ of 0 over valid operating readings: undefined_result, unchanged', async () => {
    await seedShift();
    // Flat while running; the parked readings would have given it a σ, and are gone.
    await seedHistory(21, inShift, () => 80);
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_z', NOW))
      .toMatchObject({ readiness: 'not_available', reason: 'undefined_result', value: null });
  });

  it('a z-score judging a parked reading is not_operating, with no number — never −20σ', async () => {
    await seedShift();
    await seedHistory(21, inShift);
    // 01:05 UTC: the newest reading, five minutes old, is the parked one at 01:00.
    const night = new Date('2026-09-22T01:05:00.000Z');
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_z', night))
      .toMatchObject({ readiness: 'not_available', reason: 'not_operating', value: null });
    // The operating mean itself still has an answer at night.
    expect(point(await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_avg', night))).toBe(80);
  });

  it('no shift schedule: not_configured / no_shift_schedule — never the unfiltered window', async () => {
    await seedHistory(21, inShift);
    for (const key of ['coolant_z', 'coolant_avg', 'coolant_sd']) {
      expect(await evaluator.evaluateOne(scope, EQUIPMENT, key, NOW))
        .toMatchObject({ readiness: 'not_configured', reason: 'no_shift_schedule', value: null });
    }
  });
});

// ======================================================================= the demo fleet
describeDb('QFIX-BASELINE: the seeded demo fleet', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;
  let availability: AvailabilityService;

  const demo: RequestScope = { tenantId: DEMO_TENANT, userId: 'u-demo', roles: ['ceo-manager'], isPlatformRole: false };
  const ref = (externalId: string) => ({ sourceSystem: DEMO_SOURCE, externalId });
  /** Tuesday 12:30 in the demo site's IST: mid-shift, the same instant seed-demo.spec uses. */
  const NOW = new Date('2026-10-06T07:00:00.000Z');
  /** Monday's shift, 08:00–18:00 IST, on the hour from 08:30 to 17:30. */
  const MONDAY = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 5, 3 + i, 0)));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await seedDemo(owner, { now: NOW, env: { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    availability = new AvailabilityService(ds);
  }, 180_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const z = async (externalId: string, at: Date) => {
    const e = await evaluator.evaluateOne(demo, ref(externalId), 'coolant_vs_baseline', at);
    expect(e.readiness).toBe('ready');
    return (e.value as { v: number }[])[0].v;
  };

  it('2. EX-01 healthy: no daily excursion — every hour of a working shift sits inside ±2σ, centred on 0', async () => {
    const values = [];
    for (const at of MONDAY) values.push(await z('EX-01', at));
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(2);
    // The defect was an offset as much as a swing: +1.6σ for every running hour.
    expect(Math.abs(values.reduce((s, v) => s + v, 0) / values.length)).toBeLessThan(1);
    // And overnight it does not swing to the other side; it does not answer at all.
    expect(await evaluator.evaluateOne(demo, ref('EX-01'), 'coolant_vs_baseline', new Date('2026-10-05T20:00:00.000Z')))
      .toMatchObject({ readiness: 'not_available', reason: 'not_operating', value: null });
  });

  it('3. EX-03 breaching: still breaches, and by more than twice EX-01\'s whole day of noise', async () => {
    const healthy = [];
    for (const at of MONDAY) healthy.push(Math.abs(await z('EX-01', at)));
    const breaching = await z('EX-03', NOW);
    expect(breaching).toBeGreaterThan(2 * Math.max(...healthy));
    const open = await owner.query(
      `SELECT count(*)::int AS n FROM alert_event WHERE tenant_id = $1 AND external_id = 'EX-03' AND state = 'open'`,
      [DEMO_TENANT],
    );
    expect(open[0].n).toBe(1);
  });

  it('8. Availability and the baseline agree on which minutes were operating — one definition, two callers', async () => {
    // A week ending at 05:30 IST, while every machine is parked.
    const period = { from: new Date('2026-09-29T00:00:00.000Z'), to: new Date('2026-10-06T00:00:00.000Z') };
    for (const machine of ['EX-01', 'EX-02', 'EX-03']) {
      const avail = await availability.forEquipment(demo, ref(machine), period);
      const gate = await evaluator.operatingPeriods(demo, ref(machine), period.from, period.to);
      const hours = gate.periods.reduce((s, p) => s + (p.end.getTime() - p.start.getTime()), 0) / HOUR;
      expect(avail.readiness).toBe('ready');
      expect(gate.scheduled).toBe(true);
      expect(Math.round(hours * 1000) / 1000).toBe(avail.uptimeHours);
      expect(hours).toBeGreaterThan(40);
    }
  });
});
