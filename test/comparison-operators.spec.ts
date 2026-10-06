import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula, COMPILER_VERSION } from '../src/catalog/formula/formula-compiler';
import { lookupExecutor } from '../src/catalog/formula/executor-registry';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const SIGNALS = [
  { signal: 'coolant_temp_c', unit: 'degC' },
  { signal: 'oil_pressure_kpa', unit: 'kPa' },
  { signal: 'vibration_mm_s', unit: 'mm/s' },
];
const compile = (expression: string) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'genset', expectedSignals: SIGNALS,
});

/**
 * Comparison operators and `count_exceeding` (task QCE5) — the gap QCE4 reported:
 * summing z-scores composed, "count how many exceed 2" did not.
 */
describe('QCE5: compiling comparisons', () => {
  it('the cross-sensor risk score now composes, and is dimensionless', () => {
    const risk = compile(
      '(zscore(coolant_temp_c, 90d) > 2) + (zscore(oil_pressure_kpa, 90d) > 2) + (zscore(vibration_mm_s, 90d) > 2)',
    );
    expect(risk.resultUnit).toBe('dimensionless');
    expect(risk.resultKind).toBe('series');
    expect(risk.requiredSignals).toEqual(['coolant_temp_c', 'oil_pressure_kpa', 'vibration_mm_s']);
  });

  it('compares in the signal\'s own unit against a literal, and the result is dimensionless', () => {
    const series = compile('coolant_temp_c > 105');
    expect(series).toMatchObject({ resultKind: 'series', resultUnit: 'dimensionless' });
    expect(series.plan).toMatchObject({ type: 'compare', op: '>' });
    expect(compile('avg(coolant_temp_c) >= 105')).toMatchObject({ resultKind: 'scalar', resultUnit: 'dimensionless' });
  });

  it('binds looser than arithmetic: a + b > c compares the sum', () => {
    expect(compile('avg(coolant_temp_c) + 5 > 105').plan).toMatchObject({ type: 'compare', left: { type: 'binary' } });
  });

  it('refuses comparing two different units — they have no order', () => {
    expect(() => compile('coolant_temp_c > oil_pressure_kpa')).toThrow(/compares "degC" with "kPa"/);
  });

  it('refuses a chain, which reads as a range and means something else', () => {
    expect(() => compile('80 < coolant_temp_c < 105')).toThrow(/do not chain/);
  });

  it('refuses equality, naming why', () => {
    expect(() => compile('coolant_temp_c == 105')).toThrow(/no equality comparison/);
    expect(() => compile('coolant_temp_c != 105')).toThrow(/no equality comparison/);
  });

  it('refuses count() over a comparison, pointing at count_exceeding — it would count every point', () => {
    expect(() => compile('count(zscore(coolant_temp_c, 90d) > 2)')).toThrow(/count_exceeding/);
  });

  it('marks plans compiled with the new node as such', () => {
    expect(compile('coolant_temp_c > 105').compilerVersion).toBe(COMPILER_VERSION);
  });
});

describe('QCE5: count_exceeding', () => {
  it('compiles to a dimensionless scalar', () => {
    expect(compile('count_exceeding(coolant_temp_c, 105)')).toMatchObject({
      resultKind: 'scalar', resultUnit: 'dimensionless',
    });
  });

  it('refuses a threshold in another unit', () => {
    expect(() => compile('count_exceeding(coolant_temp_c, avg(oil_pressure_kpa))')).toThrow(/threshold in "kPa"/);
  });

  const ctx = { windowFrom: new Date('2026-09-22T00:00:00Z'), windowTo: new Date('2026-09-22T12:00:00Z'), history: [], excludedRanges: [] };
  const at = (h: number) => new Date(ctx.windowFrom.getTime() + h * HOUR);

  it('counts readings strictly above — the same ">" a comparison uses', () => {
    const series = [80, 105, 106, 120].map((value, i) => ({ at: at(i + 1), value }));
    expect(lookupExecutor('count_exceeding')!.run([series], [105], [], ctx)).toEqual({ ok: true, value: 2 });
  });

  it('no readings is no_readings, not 0', () => {
    expect(lookupExecutor('count_exceeding')!.run([[]], [105], [], ctx)).toEqual({ ok: false, reason: 'no_readings' });
  });
});

describeDb('QCE5: evaluating comparisons', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-C' };
  const IMEI = 'imei-dg-c';
  const CLASS = 'compare-genset';
  const NOW = new Date('2026-09-22T12:00:00.000Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection',
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
    await owner.getRepository(SignalBindingVersion).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c', componentId: '',
      origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
      canonicalUnit: 'degC', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
    });
  });

  const saveFormula = async (formulaKey: string, expression: string) => {
    const compiled = compileFormula({
      formulaKey, expression, classSlug: CLASS, expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
    });
    await owner.getRepository(ClientFormula).save({
      tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey, kind: 'empirical', expression,
      compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
      resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
      requiredParameters: compiled.requiredParameters, bindings: [], resultKind: compiled.resultKind,
      displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
      targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
      templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
  };

  const seedReadings = (points: { hoursAgo: number; value: number }[]) => owner.getRepository(TelemetryReading).save(
    points.map((p) => ({
      tenantId: 'acme', imei: IMEI, signal: 'coolant_temp_c', value: p.value, unit: 'degC',
      sourceTimestamp: new Date(NOW.getTime() - p.hoursAgo * HOUR), receivedAt: NOW, source: 'live' as const,
    })),
  );

  it('a scalar comparison is 1 or 0', async () => {
    await saveFormula('above', 'avg(coolant_temp_c) > 85');
    await saveFormula('at_least', 'avg(coolant_temp_c) >= 85');
    await seedReadings([{ hoursAgo: 0.2, value: 80 }, { hoursAgo: 0.1, value: 90 }]); // avg 85
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'above', NOW)).toMatchObject({ readiness: 'ready', value: 0 });
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'at_least', NOW)).toMatchObject({ readiness: 'ready', value: 1 });
  });

  it('count_exceeding counts readings above the threshold over the window', async () => {
    await saveFormula('hot', 'count_exceeding(coolant_temp_c, 85)');
    await seedReadings([{ hoursAgo: 0.3, value: 80 }, { hoursAgo: 0.2, value: 90 }, { hoursAgo: 0.1, value: 100 }]);
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'hot', NOW)).toMatchObject({
      readiness: 'ready', value: 2, unit: 'dimensionless',
    });
  });

  it('a series comparison buckets to 0, 1 or null — a bucket with no reading is never a 0', async () => {
    await saveFormula('hot_series', 'coolant_temp_c > 85');
    await seedReadings([{ hoursAgo: 10, value: 100 }, { hoursAgo: 0.1, value: 80 }]);
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'hot_series', NOW);
    expect(envelope.readiness).toBe('ready');
    const values = (envelope.value as { v: number | null }[]).map((p) => p.v);
    expect(values).toContain(1);
    expect(values).toContain(0);
    expect(values).toContain(null);
    expect(values.every((v) => v === null || v === 0 || v === 1)).toBe(true);
  });

  it('the risk score evaluates: a count of baselines exceeded, at the window\'s end, as one point', async () => {
    await saveFormula('risk', '(zscore(coolant_temp_c, 20d) > 2) + (zscore(coolant_temp_c, 20d) < -2)');
    // A steady history, then a spike: far above +2 sigma, nowhere near -2.
    const history = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: (20 - i) * 24, value: i % 2 ? 48 : 52 }));
    await seedReadings([...history, { hoursAgo: 0.1, value: 200 }]);
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'risk', NOW);
    expect(envelope.readiness).toBe('ready');
    expect(envelope.value).toEqual([{ t: NOW.toISOString(), v: 1 }]);
  });
});
