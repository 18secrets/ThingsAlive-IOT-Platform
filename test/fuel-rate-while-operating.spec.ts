import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { Plant } from '../src/equipment/entities/plant.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { OeeService } from '../src/utilization/services/oee.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Fuel test report, 3 Nov 2026 — FU-4 / TC-FP-04: "avg_fuel_consumption 15.6 L/h on the
 * machine page vs 13.2 L/h in Signal Bindings; implied from Production litres ÷ hours,
 * 13.19 L/h."
 *
 * Retest criterion: machine page, Bindings and Production show one identical L/h for the
 * same machine and window. The KPI was `avg(fuel_consumption)`: the mean of every reading
 * in a rolling 24 hours, parked hours included, so it moved with when you looked and never
 * meant litres ÷ hours. `avg_while_operating` does mean that, by OEE's own integration.
 * These evaluate both through the real KPI evaluator against the same readings, and hold
 * the new one to Production's litres ÷ productive hours.
 */
describeDb('the fuel rate KPI is litres over running hours (FU-4)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let kpis: KpiEvaluatorService;
  let oee: OeeService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const SRC = 'ta-2.0';
  const ID = '3100092';
  const CLASS = 'shutter-converter';
  const MONDAY = Date.UTC(2026, 10, 2);
  const at = (h: number, m = 0) => MONDAY + h * HOUR + m * MIN;
  // The Production 'day' window and the KPI window are the same calendar day.
  const DAY = { from: new Date(MONDAY), to: new Date(MONDAY + 24 * HOUR) };
  const NOW = new Date(MONDAY + 24 * HOUR);

  const formula = (key: string, expression: string) => {
    const c = compileFormula({
      formulaKey: key, expression, classSlug: CLASS, expectedSignals: [{ signal: 'fuel_consumption', unit: 'L/h' }],
    });
    return {
      tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: key, kind: 'empirical', expression,
      compiledPlan: c.plan, compiledAt: NOW, compilerVersion: c.compilerVersion, resultUnit: c.resultUnit,
      requiredSignals: c.requiredSignals, requiredParameters: [], bindings: [], resultKind: c.resultKind,
      displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
      targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'number',
      templateVersion: null, copiedAt: null, status: 'active', updatedBy: 'u',
    };
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    kpis = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    oee = new OeeService(ds);

    await owner.getRepository(EquipmentClassProfile).save({
      slug: CLASS, version: 1, name: 'Shutter Converter', status: 'published', publishedAt: new Date(MONDAY),
      expectedSignals: ['engine_running_status', 'engine_load', 'fuel_level', 'fuel_consumption']
        .map((signal) => ({ signal, unit: 'x', required: true })),
      nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleBreakdownThresholdMinutes: 30,
      runningSignal: 'engine_load', runningIdleBound: 20, availabilitySignal: 'fuel_level',
    });
    const plantId = (await owner.getRepository(Plant).save(owner.getRepository(Plant).create({
      tenantId: 'acme', code: 'north', name: 'North', status: 'active',
    }))).id;
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: CLASS, name: 'Shutter Converter', description: null, category: 'construction',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u',
      });
      await m.getRepository(ClientFormula).save([
        formula('avg_fuel_consumption', 'avg_while_operating(fuel_consumption)'),
        formula('mean_of_readings', 'avg(fuel_consumption)'),
      ] as never[]);
    });
    await owner.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: SRC, externalId: ID, equipmentClassSlug: CLASS, classVersion: 1, plantId,
      tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    });
    const imei = 'imei-3100092';
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: SRC, externalId: 'dev-1', tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
      syncedAt: new Date(MONDAY), checksum: 'c', status: 'live', imei, equipmentExternalId: ID, name: null,
    });
    const units: Record<string, string> = { engine_running_status: 'state', engine_load: '%', fuel_level: '%', fuel_consumption: 'L/h' };
    await owner.getRepository(SignalBindingVersion).save(Object.entries(units).map(([signal, unit], i) => ({
      tenantId: 'acme', sourceSystem: SRC, externalId: ID, signalKey: signal, measurementRole: signal,
      componentId: '', origin: 'physical' as const, imei, channel: `ch${i}`, sensorInstanceId: null,
      canonicalUnit: unit, sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 300, isPrimary: true, status: 'active' as const, discoveredFrom: null,
      discoveredBy: 'manual' as const, approvedBy: 'u', approvedAt: new Date(MONDAY),
    })));
    // A ten-hour day shift, 06:00–16:00.
    await owner.getRepository(EquipmentShift).save({
      tenantId: 'acme', sourceSystem: SRC, externalId: ID, name: 'Day', startMinute: 6 * 60, endMinute: 16 * 60,
      days: [1] as never, timeZone: 'UTC', status: 'active', scoredThrough: null, arrivalsThrough: null,
      createdBy: 'u', updatedBy: 'u',
    });
    // Every five minutes all day: engine on and 13.2 L/h through the shift; parked the
    // rest of the day with the logger still reporting 1 L/h from the fuel line.
    const rows = [];
    for (let t = at(0); t < at(24); t += 5 * MIN) {
      const working = t >= at(6) && t < at(16);
      for (const [signal, value] of [
        ['engine_running_status', working ? 1 : 0], ['engine_load', working ? 60 : 0],
        ['fuel_level', 50], ['fuel_consumption', working ? 13.2 : 1],
      ] as [string, number][]) {
        rows.push({ tenantId: 'acme', imei, signal, value, unit: null, sourceTimestamp: new Date(t), receivedAt: new Date(t), source: 'live' as const });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await owner.getRepository(TelemetryReading).save(rows.slice(i, i + 500));
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });
  const ref = { sourceSystem: SRC, externalId: ID };

  it('litres over running hours: 13.2 L/h, whatever the parked hours around the shift', async () => {
    const e = await kpis.evaluateOne(scope, ref, 'avg_fuel_consumption', NOW, DAY);
    expect(e.readiness).toBe('ready');
    expect(e.value as number).toBeCloseTo(13.2, 6);
  });

  it('the old definition, the mean of every reading, is dragged down by the parked hours — the disagreement the tester saw', async () => {
    const e = await kpis.evaluateOne(scope, ref, 'mean_of_readings', NOW, DAY);
    // 120 readings at 13.2 and 168 at 1 over 24 hours.
    expect(e.value as number).toBeCloseTo((120 * 13.2 + 168 * 1) / 288, 6);
    expect(e.value as number).not.toBeCloseTo(13.2, 1);
  });

  it('Production\'s litres ÷ productive hours for the same day is the same number', async () => {
    const day = await oee.forEquipment(scope, ref, 'day', new Date(MONDAY), NOW);
    const productiveHours = (day.availability.availableMinutes! - day.performance.breakdownMinutes) / 60;
    const fromProduction = day.quality.actualFuel! / productiveHours;
    const kpi = (await kpis.evaluateOne(scope, ref, 'avg_fuel_consumption', NOW, DAY)).value as number;
    expect(fromProduction).toBeCloseTo(13.2, 3);
    expect(kpi).toBeCloseTo(fromProduction, 3);
  });

  it('a window with no shift in it says the machine was not operating, never an average of parked readings', async () => {
    const night = { from: new Date(at(18)), to: new Date(at(23)) };
    expect(await kpis.evaluateOne(scope, ref, 'avg_fuel_consumption', NOW, night))
      .toMatchObject({ value: null, reason: 'not_operating' });
  });
});
