import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { OPERATIONAL_PARAMETERS } from '../src/parameters/parameter-catalog';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const SIGNALS = [
  { signal: 'motor_current', unit: 'A' },
  { signal: 'supply_voltage', unit: 'V' },
  { signal: 'fuel_rate', unit: 'L/h' },
];
const compile = (expression: string) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'motor', expectedSignals: SIGNALS,
});

/**
 * Motor ratings compile in their unit (D56). Before this, `@rated_current` was a bare
 * number, so the load ratio came out in amps and `λ > 1.2` compared amps with a pure
 * number without complaint: the unit check passed the wrong thing silently.
 */
describe('D56: motor ratings carry their unit into the compiler', () => {
  it('the load ratio is dimensionless, not amps', () => {
    expect(compile('avg(motor_current) / @rated_current').resultUnit).toBe('dimensionless');
  });

  it('an overload threshold stated against the rating compiles as a comparison in amps', () => {
    const overload = compile('avg(motor_current) > 1.2 * @rated_current');
    expect(overload.resultUnit).toBe('dimensionless');
    expect(overload.requiredParameters).toEqual(['rated_current']);
  });

  it('refuses comparing current with a voltage rating', () => {
    expect(() => compile('avg(motor_current) > @rated_voltage'))
      .toThrow(/compares "A" with "V", which are different units/);
  });

  it('the voltage band reads in volts', () => {
    expect(compile('avg(supply_voltage) < @voltage_warn_low').resultUnit).toBe('dimensionless');
  });

  it('the thermal model adds up in degC: ambient plus rise times load squared', () => {
    const lambda = '(avg(motor_current) / @rated_current)';
    expect(compile(`@ambient_temp_reference + @rated_temp_rise * ${lambda} * ${lambda}`).resultUnit).toBe('degC');
  });

  it('pure-number ratings stay pure numbers', () => {
    expect(compile('120 * @rated_frequency / @poles').resultUnit).toBe('Hz');
  });

  // Every parameter that predates D56 compiles exactly as it did, so no published
  // formula changes its result unit when it is next compiled.
  it('parameters that predate D56, and formula-declared ones, are still bare numbers', () => {
    expect(compile('avg(fuel_rate) * @fuel_price').resultUnit).toBe('L/h');
    expect(compile('avg(motor_current) * @derate_factor').resultUnit).toBe('A');
    const predating = OPERATIONAL_PARAMETERS.filter((p) => !p.compilesWithUnit).map((p) => p.name);
    expect(predating).toEqual(expect.arrayContaining(['fuel_price', 'nominal_fuel_per_hour', 'stale_after_seconds']));
  });
});

describeDb('D56: a motor rating end to end', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;
  let parameters: ParameterService;
  let equipmentId: string;

  const TENANT = 'acme';
  const CLASS = 'units-motor';
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'MOTOR-U' };
  const IMEI = 'imei-motor-u';
  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const EARLIER = new Date('2026-01-01T00:00:00.000Z');
  const boss: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    parameters = new ParameterService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "tenant_parameter"`);
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection',
      'equipment_profile', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: TENANT, slug: CLASS, name: 'Motor', description: null, category: 'motor',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    const profile = await owner.getRepository(EquipmentProfile).save({
      tenantId: TENANT, sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: CLASS, classVersion: 1, tier: 'standard', commissionedAt: null,
      serviceIntervalHours: null, readiness: {}, updatedBy: 'u-boss',
    });
    equipmentId = profile.id;
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: EQUIPMENT.sourceSystem, externalId: `dev-${EQUIPMENT.externalId}`, tenantId: TENANT,
      payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
      imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
    });
    await owner.getRepository(SignalBindingVersion).save({
      tenantId: TENANT, sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      signalKey: 'motor_current', measurementRole: 'motor_current', componentId: '',
      origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
      canonicalUnit: 'A', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
    });
    const compiled = compileFormula({
      formulaKey: 'load_ratio', expression: 'avg(motor_current) / @rated_current', classSlug: CLASS,
      expectedSignals: [{ signal: 'motor_current', unit: 'A' }],
    });
    await owner.getRepository(ClientFormula).save({
      tenantId: TENANT, clientEquipmentClassSlug: CLASS, formulaKey: 'load_ratio', kind: 'empirical',
      expression: 'avg(motor_current) / @rated_current',
      compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
      resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
      requiredParameters: compiled.requiredParameters, bindings: [], resultKind: compiled.resultKind,
      displayUnit: null, displayFormat: 'number:2', targetValue: null, targetMin: null, targetMax: null,
      targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
      templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await owner.getRepository(TelemetryReading).save([5.0, 6.0].map((value, i) => ({
      tenantId: TENANT, imei: IMEI, signal: 'motor_current', value, unit: 'A',
      sourceTimestamp: new Date(NOW.getTime() - (2 - i) * 0.1 * HOUR), receivedAt: NOW, source: 'live' as const,
    })));
  });

  it('the nameplate rating on the machine makes the load ratio a pure number', async () => {
    await parameters.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'rated_current', value: 5.5, effectiveFrom: EARLIER });
    expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'load_ratio', NOW)).toMatchObject({
      readiness: 'ready', value: 1, unit: 'dimensionless',
    });
  });

  it('with no rating the ratio is not_configured, naming it, never a default', async () => {
    expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'load_ratio', NOW)).toMatchObject({
      readiness: 'not_configured', reason: 'parameter_not_set', missingParameters: ['rated_current'],
    });
  });

  // The firmware finding this exists for (workbook V-01) was a rating off by a factor
  // of 47; a milliamp figure stored as amps would be off by 1000.
  it('a rating in another unit is refused, not converted', async () => {
    await expect(parameters.set(boss, {
      scope: 'equipment', scopeRef: equipmentId, name: 'rated_current', value: 5500, unit: 'mA', effectiveFrom: EARLIER,
    })).rejects.toThrow(/"rated_current" is measured in "A", not "mA"/);
    const stored = await owner.query(`SELECT count(*)::int AS n FROM "tenant_parameter" WHERE "name" = 'rated_current'`);
    expect(stored[0].n).toBe(0);
  });
});
