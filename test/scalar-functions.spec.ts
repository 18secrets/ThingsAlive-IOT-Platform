import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula, COMPILER_VERSION } from '../src/catalog/formula/formula-compiler';
import { ExecContext, lookupExecutor } from '../src/catalog/formula/executor-registry';
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
  { signal: 'motor_current', unit: 'A' },
  { signal: 'supply_voltage', unit: 'V' },
  { signal: 'winding_temp_c', unit: 'degC' },
];
const compile = (expression: string) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'pump', expectedSignals: SIGNALS,
});

/**
 * Scalar functions (task QSCAL1): the vocabulary motor and pump physics needs once
 * every threshold is a ratio to a rated value. Most of what follows is refusals,
 * because these functions are where a unit mistake would otherwise vanish. "The
 * smaller of 5 A and 230 V" compiles to a number unless something stops it.
 */
describe('QSCAL1: compiling scalar functions', () => {
  it('"running" is two comparisons that must both hold, and is dimensionless', () => {
    const running = compile('and(avg(supply_voltage) > 34.5, avg(motor_current) > 0.275)');
    expect(running.resultKind).toBe('scalar');
    expect(running.resultUnit).toBe('dimensionless');
    expect(running.requiredSignals).toEqual(['motor_current', 'supply_voltage']);
  });

  it('least, greatest and clamp keep the value\'s unit when the other side is a literal', () => {
    expect(compile('least(avg(motor_current), 5.5)').resultUnit).toBe('A');
    expect(compile('greatest(0, avg(motor_current))').resultUnit).toBe('A');
    expect(compile('clamp(avg(winding_temp_c), 0, 155)').resultUnit).toBe('degC');
    expect(compile('abs(avg(supply_voltage) - 230)').resultUnit).toBe('V');
  });

  it('if takes its outcomes\' unit, and a literal outcome adopts the other\'s', () => {
    expect(compile('if(avg(motor_current) > 0.3, avg(supply_voltage), 0)').resultUnit).toBe('V');
  });

  it('nests: or of two ands, the shape the voltage-band tier needs', () => {
    const tier = compile(
      'or(and(avg(supply_voltage) < 190, avg(supply_voltage) >= 180), '
        + 'and(avg(supply_voltage) > 250, avg(supply_voltage) <= 260))',
    );
    expect(tier.resultUnit).toBe('dimensionless');
  });

  it('refuses the smaller of two different units', () => {
    expect(() => compile('least(avg(motor_current), avg(supply_voltage))'))
      .toThrow(/"least" with its two values in "A" and "V", which are different units/);
  });

  it('refuses clamp bounds in another unit than the value', () => {
    expect(() => compile('clamp(avg(winding_temp_c), 0, avg(motor_current))'))
      .toThrow(/"clamp" with a value and bounds in "degC" and "A"/);
  });

  it('refuses literal clamp bounds that are out of order, rather than picking one', () => {
    expect(() => compile('clamp(avg(winding_temp_c), 155, 0)'))
      .toThrow(/lower bound \(155\) above its upper bound \(0\)/);
  });

  it('refuses a condition carrying a unit — "any current at all" is not a threshold', () => {
    expect(() => compile('if(avg(motor_current), 1, 0)'))
      .toThrow(/"if" with its condition in "A"; a condition must be dimensionless/);
    expect(() => compile('and(avg(motor_current) > 0.3, avg(supply_voltage))'))
      .toThrow(/"and" with argument 2 in "V"/);
  });

  it('refuses if outcomes in two different units', () => {
    expect(() => compile('if(avg(motor_current) > 0.3, avg(supply_voltage), avg(motor_current))'))
      .toThrow(/"if" with its two outcomes in "V" and "A"/);
  });

  it('refuses a raw signal, and says how to reduce it', () => {
    expect(() => compile('abs(motor_current)'))
      .toThrow(/"abs" with argument 1 as a series; .*Reduce the signal first, e.g. avg\(x\) or last\(x\)/);
    expect(() => compile('and(motor_current > 0.3, avg(supply_voltage) > 34)'))
      .toThrow(/"and" with argument 1 as a series/);
  });

  it('min and max are still the series reducers — the two-value form is least/greatest', () => {
    expect(() => compile('min(avg(motor_current), 5)')).toThrow(/"min" with 2 argument\(s\); it takes 1/);
  });

  it('marks plans compiled with the new functions as such', () => {
    expect(compile('abs(avg(motor_current))').compilerVersion).toBe(COMPILER_VERSION);
  });
});

describe('QSCAL1: executing scalar functions', () => {
  const ctx: ExecContext = { windowFrom: new Date(0), windowTo: new Date(0), history: [], excludedRanges: [] };
  const run = (name: string, scalars: number[]) => lookupExecutor(name)!.run([], scalars, [], ctx);

  it('computes each function', () => {
    expect(run('abs', [-3])).toEqual({ ok: true, value: 3 });
    expect(run('least', [2, 5])).toEqual({ ok: true, value: 2 });
    expect(run('greatest', [2, 5])).toEqual({ ok: true, value: 5 });
    expect(run('clamp', [3100, 0, 3000])).toEqual({ ok: true, value: 3000 });
    expect(run('clamp', [-4, 0, 3000])).toEqual({ ok: true, value: 0 });
    expect(run('clamp', [2850, 0, 3000])).toEqual({ ok: true, value: 2850 });
  });

  it('a condition is true when non-zero — what a comparison already produces', () => {
    expect(run('and', [1, 1])).toEqual({ ok: true, value: 1 });
    expect(run('and', [1, 0])).toEqual({ ok: true, value: 0 });
    expect(run('or', [0, 1])).toEqual({ ok: true, value: 1 });
    expect(run('or', [0, 0])).toEqual({ ok: true, value: 0 });
    expect(run('if', [1, 10, 20])).toEqual({ ok: true, value: 10 });
    expect(run('if', [0, 10, 20])).toEqual({ ok: true, value: 20 });
  });

  it('clamp with parameter bounds out of order has no answer, not either bound', () => {
    expect(run('clamp', [5, 10, 1])).toEqual({ ok: false, reason: 'undefined_result' });
  });

  it('a NaN from upstream arithmetic is undefined_result, never a number on a tile', () => {
    expect(run('abs', [Number.NaN])).toEqual({ ok: false, reason: 'undefined_result' });
  });
});

describeDb('QSCAL1: evaluating scalar functions', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'PUMP-S' };
  const IMEI = 'imei-pump-s';
  const CLASS = 'scalar-pump';
  const NOW = new Date('2026-11-09T12:00:00.000Z');
  // winding_temp_c is declared but never bound: the untaken branch of an `if` below.
  const DECLARED = [{ signal: 'motor_current', unit: 'A' }, { signal: 'winding_temp_c', unit: 'degC' }];

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
      tenantId: 'acme', slug: CLASS, name: 'Pump', description: null, category: 'pump',
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
      signalKey: 'motor_current', measurementRole: 'motor_current', componentId: '',
      origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
      canonicalUnit: 'A', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
    });
  });

  const saveFormula = async (formulaKey: string, expression: string) => {
    const compiled = compileFormula({ formulaKey, expression, classSlug: CLASS, expectedSignals: DECLARED });
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

  const seedCurrent = (values: number[]) => owner.getRepository(TelemetryReading).save(
    values.map((value, i) => ({
      tenantId: 'acme', imei: IMEI, signal: 'motor_current', value, unit: 'A',
      sourceTimestamp: new Date(NOW.getTime() - (values.length - i) * 0.1 * HOUR), receivedAt: NOW,
      source: 'live' as const,
    })),
  );

  it('clamps a reduced value to its band, in the value\'s unit', async () => {
    await saveFormula('capped', 'clamp(avg(motor_current), 0, 5.5)');
    await seedCurrent([6, 7]); // avg 6.5, above the cap
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'capped', NOW)).toMatchObject({
      readiness: 'ready', value: 5.5, unit: 'A',
    });
  });

  it('if picks the outcome its comparison selects', async () => {
    await saveFormula('overload', 'if(avg(motor_current) > 6.6, 2, 0)');
    await seedCurrent([7, 7]);
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'overload', NOW)).toMatchObject({ readiness: 'ready', value: 2 });
    await saveFormula('overload_ok', 'if(avg(motor_current) > 8, 2, 0)');
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'overload_ok', NOW)).toMatchObject({ readiness: 'ready', value: 0 });
  });

  // Eager on purpose: the workbook's completeness rule is that a formula activates only
  // when everything it names exists. A formula that read `ready` until the day its
  // condition flipped would hide that it was never fully configured.
  it('an untaken branch over an unbound signal still makes the formula not_configured', async () => {
    await saveFormula('branchy', 'if(avg(motor_current) > 0, 1, avg(winding_temp_c) > 0)');
    await seedCurrent([5, 5]);
    expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'branchy', NOW)).toMatchObject({ readiness: 'not_configured' });
  });
});
