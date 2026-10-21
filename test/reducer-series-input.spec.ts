import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
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
const SIGNALS = [{ signal: 'coolant_temp_c', unit: 'degC' }, { signal: 'oil_pressure_kpa', unit: 'kPa' }];
const compile = (expression: string, siblingFormulas?: { formulaKey: string; expression: string }[]) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'genset', expectedSignals: SIGNALS, siblingFormulas,
});

/**
 * An operator's series argument is a signal by name (QCE5 follow-up). Anything else
 * used to compile and then read `unbound` at runtime — telling somebody to wire a
 * sensor that was already wired.
 */
describe('a series argument must be a signal', () => {
  it.each([
    ['avg(zscore(coolant_temp_c, 20d))', /"avg" over the output of "zscore"/],
    ['count_exceeding(zscore(coolant_temp_c, 20d), 2)', /"count_exceeding" over the output of "zscore"/],
    ['zscore(baseline_avg(coolant_temp_c, 20d), 20d)', /"zscore" over the output of "baseline_avg"/],
    ['avg(coolant_temp_c * 2)', /"avg" over a computed expression/],
    ['max(-coolant_temp_c)', /"max" over a computed expression/],
  ])('refuses %s, saying what to do instead', (expression, message) => {
    expect(() => compile(expression)).toThrow(message);
    expect(() => compile(expression)).toThrow(/Apply the operator to each signal/);
  });

  it('refuses another formula as the series argument', () => {
    expect(() => compile('avg(#hot)', [{ formulaKey: 'hot', expression: 'coolant_temp_c' }]))
      .toThrow(/"avg" over another formula \("#hot"\)/);
  });

  it('still points a comparison at count_exceeding', () => {
    expect(() => compile('count(coolant_temp_c > 105)')).toThrow(/count_exceeding/);
  });

  it('leaves every form the runtime can execute alone', () => {
    for (const expression of [
      'avg(coolant_temp_c)',
      'count_exceeding(coolant_temp_c, 105)',
      'fraction_within(coolant_temp_c, 80, 105)',
      'zscore(coolant_temp_c, 20d) + zscore(oil_pressure_kpa, 20d)',
      '(zscore(coolant_temp_c, 20d) > 2) + (zscore(oil_pressure_kpa, 20d) > 2)',
      'avg(coolant_temp_c) * 2',
    ]) {
      expect(() => compile(expression)).not.toThrow();
    }
  });
});

describeDb('a plan stored before the rule', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-R' };
  const IMEI = 'imei-dg-r';
  const CLASS = 'reducer-genset';
  const NOW = new Date('2026-09-22T12:00:00.000Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));

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
    await owner.getRepository(TelemetryReading).save([0.2, 0.1].map((h) => ({
      tenantId: 'acme', imei: IMEI, signal: 'coolant_temp_c', value: 80, unit: 'degC',
      sourceTimestamp: new Date(NOW.getTime() - h * HOUR), receivedAt: NOW, source: 'live' as const,
    })));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('is not_configured — never "unbound" for a signal that is bound and reporting', async () => {
    // What the compiler emitted for avg(zscore(coolant_temp_c, 20d)) before it refused it.
    const legacyPlan = {
      type: 'call', kind: 'scalar', unit: 'dimensionless', name: 'avg',
      args: [{
        type: 'call', kind: 'series', unit: 'dimensionless', name: 'zscore',
        args: [
          { type: 'signal', kind: 'series', unit: 'degC', name: 'coolant_temp_c' },
          { type: 'duration', kind: 'scalar', unit: 'dimensionless', hours: 480 },
        ],
      }],
    };
    await owner.getRepository(ClientFormula).save({
      tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: 'legacy', kind: 'empirical',
      expression: 'avg(zscore(coolant_temp_c, 20d))', compiledPlan: legacyPlan as any, compiledAt: NOW,
      compilerVersion: 'qce1.1.0', resultUnit: 'dimensionless', requiredSignals: ['coolant_temp_c'],
      requiredParameters: [], bindings: [], resultKind: 'scalar', displayUnit: null, displayFormat: 'number:1',
      targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
      aggregationWindow: '24h', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active',
      updatedBy: 'u-master',
    });
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'legacy', NOW);
    expect(envelope).toMatchObject({ value: null, readiness: 'not_configured' });
    expect(envelope.reason).toBeUndefined();
  });
});
