import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { lookupExecutor } from '../src/catalog/formula/executor-registry';
import { DIMENSIONLESS, multiplyByHour, renderUnit } from '../src/catalog/formula/units';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { GeofenceTracker } from '../src/geofence/geofence-tracker.service';
import { GeofenceService } from '../src/geofence/geofence.service';
import { ZoneShape } from '../src/geofence/geometry';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const PIT: ZoneShape = { type: 'Circle', center: [77.2, 12.2], radiusM: 500 };
const SIGNALS = [
  { signal: 'latitude', unit: 'deg' }, { signal: 'longitude', unit: 'deg' }, { signal: 'coolant_temp_c', unit: 'degC' },
];
const compile = (expression: string) => compileFormula({ formulaKey: 'f', expression, classSlug: 'genset', expectedSignals: SIGNALS });

/** Zone operators and time in zone (task QGEO2, stage 3). */
describe('QGEO2: compiling zone operators', () => {
  it('compiles each with a quoted zone code — capitals, digits and .-_ included — keeping the code in the plan', () => {
    expect(compile("outside_zone(latitude, longitude, 'PIT')")).toMatchObject({ resultKind: 'scalar', resultUnit: 'dimensionless' });
    expect(compile("fraction_in_zone(latitude, longitude, 'HAUL-RD.2')")).toMatchObject({ resultUnit: 'dimensionless' });
    const c = compile("time_in_zone(latitude, longitude, 'yard_1')");
    expect(c.resultUnit).toBe(renderUnit(multiplyByHour(DIMENSIONLESS)));
    expect((c.plan as { args: unknown[] }).args[2]).toEqual({ type: 'zone', kind: 'scalar', unit: 'dimensionless', code: 'yard_1' });
  });

  it('refuses a zone that is not a quoted code, and a pair that is not one position', () => {
    expect(() => compile('outside_zone(latitude, longitude, 3)')).toThrow(/not a quoted zone code/);
    expect(() => compile("outside_zone(latitude, coolant_temp_c, 'PIT')")).toThrow(/latitude and longitude share a unit/);
    expect(() => compile("outside_zone(latitude, longitude, 'a b')")).toThrow(/not a quoted name/);
  });

  it('a state name is still held to lower_snake_case, now by the compiler', () => {
    expect(() => compileFormula({
      formulaKey: 'f', expression: "fraction_in_state(mode, 'Idle')", classSlug: 'x',
      expectedSignals: [{ signal: 'mode', unit: 'dimensionless' }],
    })).toThrow(/'Idle' is not a state name: lower_snake_case/);
  });
});

describe('QGEO2: zone executors', () => {
  const from = new Date('2026-10-29T00:00:00Z');
  const ctx = { windowFrom: from, windowTo: new Date(from.getTime() + 10 * HOUR), history: [], excludedRanges: [], zoneShape: PIT };
  const at = (h: number, value: number) => ({ at: new Date(from.getTime() + h * HOUR), value });
  // In the pit 0–4h, 50 km away 4–6h, back 6–10h.
  const lat = [at(0, 12.2), at(4, 12.65), at(6, 12.2)];
  const lng = [at(0, 77.2), at(4, 77.2), at(6, 77.2)];

  it('outside_zone reads the latest position; fraction and time weigh each position until the next', () => {
    expect(lookupExecutor('outside_zone')!.run([lat, lng], [], [], ctx)).toEqual({ ok: true, value: 0 });
    expect(lookupExecutor('outside_zone')!.run([lat.slice(0, 2), lng.slice(0, 2)], [], [], ctx)).toEqual({ ok: true, value: 1 });
    expect(lookupExecutor('fraction_in_zone')!.run([lat, lng], [], [], ctx)).toEqual({ ok: true, value: 0.8 });
    expect(lookupExecutor('time_in_zone')!.run([lat, lng], [], [], ctx)).toEqual({ ok: true, value: 8 });
  });

  it('no positions is no_readings, never "outside" or zero hours', () => {
    for (const op of ['outside_zone', 'fraction_in_zone', 'time_in_zone']) {
      expect(lookupExecutor(op)!.run([[], []], [], [], ctx)).toEqual({ ok: false, reason: 'no_readings' });
    }
  });
});

describeDb('QGEO2: zones in evaluation, and time in zone', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;
  let zones: GeofenceService;
  let tracker: GeofenceTracker;

  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-Z' };
  const IMEI = 'imei-dg-z';
  const NOW = new Date('2026-10-29T12:00:00.000Z');
  const KEYS = ['outside_zone', 'fraction_in_zone', 'time_in_zone'];

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    zones = new GeofenceService(ds);
    tracker = new GeofenceTracker(ds, zones);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['geofence_visit', 'geofence_zone', 'domain_event', 'telemetry_reading', 'signal_binding_version',
      'device_projection', 'equipment_profile', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: 'geo-genset', name: 'Genset', description: null, category: 'power',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'geo-genset', templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await owner.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: 'geo-genset', classVersion: 1, plantId: null, tier: 'standard',
      commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u-boss',
    });
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: EQUIPMENT.sourceSystem, externalId: 'dev-z', tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
      syncedAt: NOW, checksum: 'c', status: 'live', imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
    });
    for (const signal of ['latitude', 'longitude']) {
      await owner.getRepository(SignalBindingVersion).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: signal, measurementRole: signal, componentId: '', origin: 'physical', imei: IMEI, channel: signal,
        sensorInstanceId: null, canonicalUnit: 'deg', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
        expectedPeriodSeconds: 3600, isPrimary: true, status: 'active',
        discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
      });
    }
    for (const key of KEYS) {
      const expression = `${key}(latitude, longitude, 'PIT')`;
      const c = compile(expression);
      await owner.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'geo-genset', formulaKey: key, kind: 'empirical',
        expression, compiledPlan: c.plan as any, compiledAt: NOW,
        compilerVersion: c.compilerVersion, resultUnit: c.resultUnit, requiredSignals: c.requiredSignals,
        requiredParameters: [], bindings: [], resultKind: c.resultKind, displayUnit: null, displayFormat: 'number:2',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
        aggregationWindow: '24h', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
    }
    // Hourly positions for 20h, newest 0.1h old: in the pit for 15h, then 50 km away.
    const readings = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: 19.1 - i, away: i >= 15 }));
    await owner.getRepository(TelemetryReading).save(readings.flatMap((r) => (['latitude', 'longitude'] as const).map((signal) => ({
      tenantId: 'acme', imei: IMEI, signal, unit: 'deg', receivedAt: NOW, source: 'live' as const,
      value: signal === 'latitude' ? (r.away ? 12.65 : 12.2) : 77.2,
      sourceTimestamp: new Date(NOW.getTime() - r.hoursAgo * HOUR),
    }))));
  });

  it('with the zone on this machine: outside now, 15 of 19.1 known hours inside', async () => {
    await zones.create(boss, { code: 'PIT', name: 'Pit', kind: 'restricted', shape: PIT, appliesTo: 'equipment-class', equipmentClassSlug: 'geo-genset' });
    const pick = (e: { readiness: string; value: unknown }) => ({ readiness: e.readiness, value: e.value });
    expect(pick(await evaluator.evaluateOne(boss, EQUIPMENT, 'outside_zone', NOW))).toEqual({ readiness: 'ready', value: 1 });
    const share = await evaluator.evaluateOne(boss, EQUIPMENT, 'fraction_in_zone', NOW);
    expect(share.value).toBeCloseTo(15 / 19.1, 5);
    const hours = await evaluator.evaluateOne(boss, EQUIPMENT, 'time_in_zone', NOW);
    expect(hours.value).toBeCloseTo(15, 5);
  });

  it('a zone this machine does not have — never drawn, switched off, or another machine\'s — is not_configured', async () => {
    const notApplied = { value: null, readiness: 'not_configured', reason: 'zone_not_applied' };
    expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'time_in_zone', NOW)).toMatchObject(notApplied);

    const z = await zones.create(boss, { code: 'PIT', name: 'Pit', kind: 'restricted', shape: PIT, appliesTo: 'account' });
    await zones.update(boss, z.id, { enabled: false });
    expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'outside_zone', NOW)).toMatchObject(notApplied);

    await zones.remove(boss, z.id);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('acme', 'ta-2.0', 'OTHER', 'Other', 'client', 'active', 'basic', '{}'::jsonb)`,
    );
    await zones.create(boss, { code: 'PIT', name: 'Pit', kind: 'restricted', shape: PIT, appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'OTHER' });
    expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'fraction_in_zone', NOW)).toMatchObject(notApplied);
  });

  describe('time in zone, per local day', () => {
    const fix = (iso: string, lat: number) => [
      { imei: IMEI, signal: 'latitude', value: lat, sourceTimestamp: iso },
      { imei: IMEI, signal: 'longitude', value: 77.2, sourceTimestamp: iso },
    ];
    beforeEach(async () => {
      await zones.create(boss, { code: 'PIT', name: 'Pit', kind: 'restricted', shape: PIT, appliesTo: 'account' });
      // In the pit 22:00 on the 27th to 02:00 on the 28th UTC, then 10:00 on the 28th until now (12:00 on the 29th).
      await tracker.trackWindow({
        tenantId: 'acme', ...EQUIPMENT, start: new Date('2026-10-27T00:00:00Z'), end: new Date('2026-10-29T00:00:00Z'),
        readings: [
          ...fix('2026-10-27T22:00:00Z', 12.2), ...fix('2026-10-28T02:00:00Z', 12.65),
          ...fix('2026-10-28T10:00:00Z', 12.2),
        ],
      });
    });
    const hours = (rows: { day: string; hours: number }[]) => rows.map((r) => [r.day, r.hours]);

    it('splits a visit at midnight, counts an open one up to now and no further, in UTC by default', async () => {
      const rows = await tracker.timeInZone(boss, { from: new Date('2026-10-27T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') }, NOW);
      expect(hours(rows)).toEqual([['2026-10-27', 2], ['2026-10-28', 16], ['2026-10-29', 12]]);
      expect(rows[0]).toMatchObject({ externalId: 'DG-Z', zoneCode: 'PIT', zoneKind: 'restricted' });
    });

    it('cuts days where the time zone asked for does', async () => {
      const rows = await tracker.timeInZone(boss, {
        from: new Date('2026-10-27T00:00:00Z'), to: new Date('2026-10-30T00:00:00Z'), timezone: 'Asia/Kolkata',
      }, NOW);
      // 22:00Z on the 27th is 03:30 on the 28th in India: the first visit is one Indian day.
      expect(hours(rows)).toEqual([['2026-10-28', 4 + 8.5], ['2026-10-29', 17.5]]);
    });

    it('keeps to the range, and refuses a backwards or over-long range, an unknown zone, and half a machine', async () => {
      const rows = await tracker.timeInZone(boss, { from: new Date('2026-10-28T00:00:00Z'), to: new Date('2026-10-28T01:00:00Z') }, NOW);
      expect(hours(rows)).toEqual([['2026-10-28', 1]]);
      const day = new Date('2026-10-28T00:00:00Z');
      await expect(tracker.timeInZone(boss, { from: day, to: day })).rejects.toThrow(/to comes after from/);
      await expect(tracker.timeInZone(boss, { from: day, to: new Date(day.getTime() + 93 * 24 * HOUR) })).rejects.toThrow(/at most 92 days/);
      await expect(tracker.timeInZone(boss, { from: day, to: NOW, timezone: 'Mars/Olympus' })).rejects.toThrow(/not a time zone name/);
      await expect(tracker.timeInZone(boss, { from: day, to: NOW, externalId: 'DG-Z' })).rejects.toThrow(/go together/);
    });

    it('a person who cannot see the machine sees none of its hours', async () => {
      const elsewhere: RequestScope = { ...boss, equipmentIds: ['SOMETHING-ELSE'] };
      expect(await tracker.timeInZone(elsewhere, { from: new Date('2026-10-27T00:00:00Z'), to: NOW }, NOW)).toEqual([]);
    });
  });
});
