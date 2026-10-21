import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;

/**
 * Client parameters reaching the two places that read them (task QPARAM1 §4): the
 * evaluator's `@param`, and `stale_after_seconds`. A stored value nothing reads is how
 * `expected_period_seconds` sat unused for weeks, so these go end to end.
 */
describeDb('tenant parameters: wired into evaluation', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;
  let bindings: SignalBindingService;
  let parameters: ParameterService;
  let plantId: string;
  let equipmentId: string;

  const TENANT = 'acme';
  const CLASS = 'param-genset';
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-P' };
  const IMEI = 'imei-dg-p';
  const NOW = new Date('2026-09-22T12:00:00.000Z');
  const EARLIER = new Date('2026-01-01T00:00:00.000Z');
  const boss: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    bindings = new SignalBindingService(ds);
    evaluator = new KpiEvaluatorService(ds, bindings);
    parameters = new ParameterService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "tenant_parameter"`);
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection', 'device_inventory',
      'equipment_profile', 'client_formula', 'client_equipment_class',
      'equipment_class_sensor_requirement', 'equipment_class_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    [{ id: plantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name) VALUES ($1, 'P-1', 'Plant 1') RETURNING id`, [TENANT],
    );
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: TENANT, slug: CLASS, name: 'Genset', description: null, category: 'power',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    const profile = await owner.getRepository(EquipmentProfile).save({
      tenantId: TENANT, sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: CLASS, classVersion: 1, plantId, tier: 'standard', commissionedAt: null,
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
      signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c', componentId: '',
      origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
      canonicalUnit: 'degC', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 12 * HOUR / 1000, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
    });
  });

  const saveFormula = async (formulaKey: string, expression: string, resultKind?: 'scalar' | 'series') => {
    const compiled = compileFormula({
      formulaKey, expression, classSlug: CLASS, expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
    });
    await owner.getRepository(ClientFormula).save({
      tenantId: TENANT, clientEquipmentClassSlug: CLASS, formulaKey, kind: 'empirical', expression,
      compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
      resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
      requiredParameters: compiled.requiredParameters, bindings: [], resultKind: resultKind ?? compiled.resultKind,
      displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
      targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
      templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
  };

  const readingsAt = (hoursAgo: number[]) => owner.getRepository(TelemetryReading).save(hoursAgo.map((h, i) => ({
    tenantId: TENANT, imei: IMEI, signal: 'coolant_temp_c', value: 80 + i * 10, unit: 'degC',
    sourceTimestamp: new Date(NOW.getTime() - h * HOUR), receivedAt: NOW, source: 'live' as const,
  })));

  describe('@param in a formula (§4a)', () => {
    beforeEach(async () => {
      await saveFormula('derated', 'avg(coolant_temp_c) * @derate_factor');
      await readingsAt([0.2, 0.1]); // avg 85
    });

    it('unset, the KPI is not_configured naming the parameter — never 0', async () => {
      const envelope = await evaluator.evaluateOne(boss, EQUIPMENT, 'derated', NOW);
      expect(envelope).toMatchObject({
        value: null, readiness: 'not_configured', reason: 'parameter_not_set', missingParameters: ['derate_factor'],
      });
    });

    it('set at the site, it computes', async () => {
      await parameters.set(boss, { scope: 'site', scopeRef: plantId, name: 'derate_factor', value: 2, effectiveFrom: EARLIER });
      const envelope = await evaluator.evaluateOne(boss, EQUIPMENT, 'derated', NOW);
      expect(envelope).toMatchObject({ readiness: 'ready', value: 170 });
      expect(envelope.missingParameters).toBeUndefined();
    });

    it('the machine\'s own value wins over the site\'s', async () => {
      await parameters.set(boss, { scope: 'site', scopeRef: plantId, name: 'derate_factor', value: 2, effectiveFrom: EARLIER });
      await parameters.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'derate_factor', value: 0.5, effectiveFrom: EARLIER });
      expect((await evaluator.evaluateOne(boss, EQUIPMENT, 'derated', NOW)).value).toBe(42.5);
    });

    it('a value effective after the window ends does not apply to it', async () => {
      await parameters.set(boss, { scope: 'client', name: 'derate_factor', value: 2, effectiveFrom: new Date(NOW.getTime() + HOUR) });
      expect(await evaluator.evaluateOne(boss, EQUIPMENT, 'derated', NOW))
        .toMatchObject({ readiness: 'not_configured', reason: 'parameter_not_set' });
    });

    it('a series formula applies the parameter to every bucket instead of refusing the shape', async () => {
      await saveFormula('derated_series', 'coolant_temp_c * @derate_factor', 'series');
      await parameters.set(boss, { scope: 'client', name: 'derate_factor', value: 10, effectiveFrom: EARLIER });
      const envelope = await evaluator.evaluateOne(boss, EQUIPMENT, 'derated_series', NOW);
      expect(envelope.readiness).toBe('ready');
      const values = (envelope.value as { v: number | null }[]).map((p) => p.v).filter((v) => v !== null);
      expect(values).toContain(900);
    });
  });

  describe('stale_after_seconds (§4b)', () => {
    beforeEach(async () => {
      await saveFormula('avg_coolant', 'avg(coolant_temp_c)');
      await readingsAt([2, 1]); // newest reading an hour old: stale against the 900s default
    });

    it('a tenant value overrides the platform default', async () => {
      expect((await evaluator.evaluateOne(boss, EQUIPMENT, 'avg_coolant', NOW)).reason).toBe('stale');
      await parameters.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'stale_after_seconds', value: 7200, effectiveFrom: EARLIER });
      expect((await evaluator.evaluateOne(boss, EQUIPMENT, 'avg_coolant', NOW)).readiness).toBe('ready');
    });

    it('a tenant value overrides the class requirement too, in the evaluator and in coverage()', async () => {
      await owner.getRepository(EquipmentClassProfile).save({
        slug: CLASS, version: 1, name: 'Genset', status: 'published',
        expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
      } as Partial<EquipmentClassProfile>);
      await owner.getRepository(EquipmentClassSensorRequirement).save({
        classSlug: CLASS, classVersion: 1, measurementRole: 'coolant_temp_c', componentScope: '',
        criticality: 'required', minCount: 1, enables: [], staleAfterSeconds: 300,
      } as Partial<EquipmentClassSensorRequirement>);
      await owner.getRepository(DeviceInventory).save({ imei: IMEI, tenantId: TENANT, equipmentExternalId: EQUIPMENT.externalId });
      await parameters.set(boss, { scope: 'site', scopeRef: plantId, name: 'stale_after_seconds', value: 7200, effectiveFrom: EARLIER });

      expect((await evaluator.evaluateOne(boss, EQUIPMENT, 'avg_coolant', NOW)).readiness).toBe('ready');
      const coverage = await bindings.coverage(boss, EQUIPMENT, NOW);
      const coolant = [...coverage.covered, ...coverage.missing].find((r) => r.measurementRole === 'coolant_temp_c');
      expect(coolant?.staleAfterSeconds).toBe(7200);
    });

    it('clearing the tenant value falls back to what applied before it', async () => {
      await parameters.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'stale_after_seconds', value: 7200, effectiveFrom: EARLIER });
      await parameters.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'stale_after_seconds', value: null, effectiveFrom: new Date('2026-06-01') });
      expect((await evaluator.evaluateOne(boss, EQUIPMENT, 'avg_coolant', NOW)).reason).toBe('stale');
    });
  });
});
