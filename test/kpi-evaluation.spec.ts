import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { TelemetryWindowReader } from '../src/kpi/services/telemetry-window-reader';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { WorkOrder } from '../src/work/entities/work-order.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The runtime evaluator, end to end (task QCE2). Every assertion is about the
 * envelope's `readiness`/`reason`, not just that a number came back — the whole
 * point of the task is that an absence never silently becomes a value.
 */
describeDb('KPI runtime evaluator', () => {
  let ds: DataSource;
  let owner: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-1' };
  const IMEI = 'imei-dg-1';
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
    for (const t of ['telemetry_reading', 'signal_binding_version', 'work_order', 'device_projection',
      'equipment_profile', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  const compiledAvg = compileFormula({
    formulaKey: 'avg_coolant', expression: 'avg(coolant_temp_c)', classSlug: 'diesel-generator',
    expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
  });

  const seedClass = async () => runTenantSpanning(owner, 'test fixture', async (m) => {
    await m.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: 'diesel-generator', name: 'Diesel generator',
      description: null, category: 'power', expectedSignals: [], failureModes: [],
      defaultThresholds: {}, templateSlug: 'diesel-generator', templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await m.getRepository(ClientFormula).save({
      tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey: 'avg_coolant',
      kind: 'empirical', expression: 'avg(coolant_temp_c)',
      compiledPlan: compiledAvg.plan as any, compiledAt: NOW, compilerVersion: compiledAvg.compilerVersion,
      resultUnit: compiledAvg.resultUnit, requiredSignals: compiledAvg.requiredSignals,
      requiredParameters: [], bindings: [], resultKind: compiledAvg.resultKind,
      displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
      targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
      templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await m.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: 'diesel-generator', classVersion: 1, tier: 'standard', commissionedAt: null,
      serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
    });
  });

  const seedDevice = async () => runTenantSpanning(owner, 'test fixture', async (m) => {
    await m.getRepository(DeviceProjection).save({
      sourceSystem: EQUIPMENT.sourceSystem, externalId: `dev-${EQUIPMENT.externalId}`, tenantId: 'acme',
      payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
      imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
    });
  });

  // Matches this file's own sparse two-reading fixtures (one every ~hour over
  // the 24h display window) — a real deployment would set this from the
  // device's actual reporting interval; these tests are deliberately sparse
  // unit-test data, not a realistic density, so the binding declares a cadence
  // that fits the fixture rather than the other way round.
  const seedBinding = async (expectedPeriodSeconds: number | null = 12 * HOUR / 1000) => runTenantSpanning(
    owner, 'test fixture', async (m) => {
      await m.getRepository(SignalBindingVersion).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c', componentId: '',
        origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
        canonicalUnit: 'degC', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
        expectedPeriodSeconds, isPrimary: true, status: 'active',
        discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
      });
    },
  );

  const seedReadings = async (points: { hoursAgo: number; value: number }[]) => runTenantSpanning(
    owner, 'test fixture', async (m) => {
      await m.getRepository(TelemetryReading).save(points.map((p) => ({
        tenantId: 'acme', imei: IMEI, signal: 'coolant_temp_c', value: p.value, unit: 'degC',
        sourceTimestamp: new Date(NOW.getTime() - p.hoursAgo * HOUR), receivedAt: NOW, source: 'live' as const,
      })));
    },
  );

  it('1. ready: bound, fresh readings in window — a real number with its coverage', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await seedReadings([{ hoursAgo: 0.2, value: 80 }, { hoursAgo: 0.1, value: 90 }]);

    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope.readiness).toBe('ready');
    expect(envelope.value).toBe(85);
    expect(envelope.unit).toBe('degC');
    expect(envelope.reason).toBeUndefined();
  });

  it('2. not_configured/unbound: no device fitted at all', async () => {
    await seedClass();
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'unbound', value: null });
  });

  it('3. not_configured/unbound: device fitted but the signal was never bound', async () => {
    await seedClass(); await seedDevice();
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'unbound', value: null });
  });

  it('4. not_available/no_readings: bound, but nothing has ever arrived', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'no_readings', value: null });
  });

  it('5. not_available/stale: bound, readings exist, but none recent', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await seedReadings([{ hoursAgo: 20, value: 80 }]);
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'stale', value: null });
  });

  it('5b. the last reading predates the read window entirely — still stale, not no_readings '
    + '(Q08S s3: no_readings means never, not "none in this window")', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    // 24h aggregation window: this reading is 50 hours old, well outside it.
    await seedReadings([{ hoursAgo: 50, value: 80 }]);
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'stale', value: null });
  });

  it('6. division by zero is undefined_result, never Infinity or null-silently (scalar-kind formula — '
    + 'avg(...) on both sides makes the whole expression scalar, not series)', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      const zero = compileFormula({
        formulaKey: 'zero_div', expression: 'avg(coolant_temp_c) / (avg(coolant_temp_c) - avg(coolant_temp_c))',
        classSlug: 'diesel-generator', expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
      });
      expect(zero.resultKind).toBe('scalar');
      await m.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey: 'zero_div',
        kind: 'empirical', expression: 'avg(coolant_temp_c) / (avg(coolant_temp_c) - avg(coolant_temp_c))',
        compiledPlan: zero.plan as any,
        compiledAt: NOW, compilerVersion: zero.compilerVersion, resultUnit: zero.resultUnit,
        requiredSignals: zero.requiredSignals, requiredParameters: [], bindings: [],
        resultKind: zero.resultKind, displayUnit: null, displayFormat: 'number:1',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none',
        comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
    });
    await seedReadings([{ hoursAgo: 0.1, value: 80 }]);
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'zero_div', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'undefined_result', value: null });
  });

  it('7. an open work order excludes the dirty window from a baseline operator', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      const z = compileFormula({
        formulaKey: 'coolant_z', expression: 'zscore(coolant_temp_c, 20d)', classSlug: 'diesel-generator',
        expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
      });
      await m.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey: 'coolant_z',
        kind: 'empirical', expression: 'zscore(coolant_temp_c, 20d)', compiledPlan: z.plan as any,
        compiledAt: NOW, compilerVersion: z.compilerVersion, resultUnit: z.resultUnit,
        requiredSignals: z.requiredSignals, requiredParameters: [], bindings: [],
        resultKind: z.resultKind, displayUnit: null, displayFormat: 'number:1',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none',
        comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await m.getRepository(WorkOrder).save({
        tenantId: 'acme', reference: 'WO-1', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        title: 'repair', description: null, status: 'in-progress', priority: 'normal',
        assignedToUserId: null, predictionId: null, origin: 'manual', raisedForScenario: null,
        dueAt: null, startedAt: new Date(NOW.getTime() - 25 * DAY), endedAt: null, resolution: null,
        raisedBy: 'u-master',
      });
    });
    const history = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: (20 - i) * 24, value: 50 }));
    await seedReadings([...history, { hoursAgo: 0.1, value: 999 }]);

    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_z', NOW);
    // The entire 20-day history sits inside the open work order's window, so
    // the baseline cannot be established from anything clean.
    expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established' });
  });

  it('8. the list endpoint returns every KPI the class declares, including ones that are not ready', async () => {
    await seedClass(); await seedDevice();
    const envelopes = await evaluator.evaluateAll(scope, EQUIPMENT, NOW);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ formulaKey: 'avg_coolant', readiness: 'not_configured', reason: 'unbound' });
  });

  it('9. §3: the batched query touches only the partitions the window needs, not every partition', async () => {
    await owner.query(`SELECT ensure_telemetry_partition($1::date)`, ['2026-09-01']);
    await owner.query(`SELECT ensure_telemetry_partition($1::date)`, ['2026-01-01']);
    const reader = new TelemetryWindowReader();
    const { partitions, planText } = await runTenantSpanning(owner, 'test fixture', (m) => reader.explainPartitions(
      m, 'acme', [IMEI], ['coolant_temp_c'], new Date(NOW.getTime() - 12 * HOUR), NOW,
    ));
    expect(partitions.length).toBeGreaterThan(0);
    expect(partitions).not.toContain('2026_01');
    // eslint-disable-next-line no-console
    console.log(`§3 EXPLAIN (12h window) — touched partitions: ${partitions.join(', ')}\n${planText}`);
  });

  it('§7: one KPI over a 12-hour window, measured', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await seedReadings([{ hoursAgo: 0.2, value: 80 }, { hoursAgo: 0.1, value: 90 }]);
    const startedAt = Date.now();
    await evaluator.evaluateOne(scope, EQUIPMENT, 'avg_coolant', NOW);
    // eslint-disable-next-line no-console
    console.log(`§7: one KPI over a 12h window took ${Date.now() - startedAt}ms`);
  });

  it('10. §7: twenty KPIs for one machine, measured', async () => {
    await seedClass(); await seedDevice(); await seedBinding();
    await seedReadings([{ hoursAgo: 0.2, value: 80 }, { hoursAgo: 0.1, value: 90 }]);
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      const extra = Array.from({ length: 19 }, (_, i) => {
        const compiled = compileFormula({
          formulaKey: `kpi_${i}`, expression: 'avg(coolant_temp_c)', classSlug: 'diesel-generator',
          expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
        });
        return m.getRepository(ClientFormula).create({
          tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey: `kpi_${i}`,
          kind: 'empirical', expression: 'avg(coolant_temp_c)', compiledPlan: compiled.plan as any,
          compiledAt: NOW, compilerVersion: compiled.compilerVersion, resultUnit: compiled.resultUnit,
          requiredSignals: compiled.requiredSignals, requiredParameters: [], bindings: [],
          resultKind: compiled.resultKind, displayUnit: null, displayFormat: 'number:1',
          targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none',
          comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
          templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        });
      });
      await m.getRepository(ClientFormula).save(extra);
    });

    const startedAt = Date.now();
    const envelopes = await evaluator.evaluateAll(scope, EQUIPMENT, NOW);
    const elapsedMs = Date.now() - startedAt;
    expect(envelopes).toHaveLength(20);
    expect(envelopes.every((e) => e.readiness === 'ready')).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`§7: 20 KPIs for one machine took ${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
