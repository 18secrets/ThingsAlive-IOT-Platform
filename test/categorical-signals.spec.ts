import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { lookupExecutor } from '../src/catalog/formula/executor-registry';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { SignalStateService } from '../src/device-catalog/services/signal-state.service';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const HOUR = 3_600_000;
const MIGRATION = 'SignalStates1758510000000';
const SIGNALS = [{ signal: 'utilization_status', unit: 'dimensionless' }, { signal: 'coolant_temp_c', unit: 'degC' }];
const VOCAB = new Map([['utilization_status', new Map([['off', 0], ['idle', 1], ['working', 2]])]]);
const compile = (expression: string, signalStates?: typeof VOCAB) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'genset', expectedSignals: SIGNALS, signalStates,
});

/**
 * Categorical signals (task QCAT1): states stored as numeric codes, named in
 * formulas, resolved to codes at publish, read as a step function over time.
 */
describe('QCAT1: compiling categorical operators', () => {
  it('compiles fraction_in_state to a dimensionless scalar, embedding the code when given a vocabulary', () => {
    const c = compile("fraction_in_state(utilization_status, 'idle')", VOCAB);
    expect(c).toMatchObject({ resultKind: 'scalar', resultUnit: 'dimensionless' });
    expect((c.plan as any).args[1]).toMatchObject({ type: 'state', name: 'idle', code: 1 });
  });

  it('without a vocabulary (the import dry-run) keeps the name and leaves the code empty', () => {
    expect((compile("fraction_in_state(utilization_status, 'idle')").plan as any).args[1]).toMatchObject({ code: null });
  });

  it('dwell_in_state is in hours, transitions is a count', () => {
    expect(compile("dwell_in_state(utilization_status, 'idle')", VOCAB).resultUnit).toBe(compile('integrate(coolant_temp_c) / avg(coolant_temp_c)').resultUnit);
    expect(compile("transitions(utilization_status, 'off', 'working')", VOCAB).resultUnit).toBe('dimensionless');
  });

  it('refuses a state the signal does not have, listing the ones it does', () => {
    expect(() => compile("fraction_in_state(utilization_status, 'sleeping')", VOCAB))
      .toThrow(/no state 'sleeping'; its states are 'off', 'idle', 'working'/);
  });

  it('refuses a categorical operator on a signal with no vocabulary', () => {
    expect(() => compile("fraction_in_state(coolant_temp_c, 'idle')", VOCAB)).toThrow(/"coolant_temp_c", which has no state vocabulary/);
  });

  it('refuses a state anywhere but a state argument — it is a label, not a number', () => {
    expect(() => compile("utilization_status > 'idle'", VOCAB)).toThrow(/'idle' is a state/);
    expect(() => compile("'idle' + 1", VOCAB)).toThrow(/'idle' is a state/);
    expect(() => compile("avg('idle')", VOCAB)).toThrow(/'idle' is a state/);
  });

  it('refuses a number where a state belongs, and a badly spelled state name', () => {
    expect(() => compile('fraction_in_state(utilization_status, 1)', VOCAB)).toThrow(/not a quoted name/);
    expect(() => compile("fraction_in_state(utilization_status, 'Idle')", VOCAB)).toThrow(/not a state name/);
    expect(() => compile("fraction_in_state(utilization_status, 'idle)", VOCAB)).toThrow(/unterminated state name/);
  });
});

describe('QCAT1: categorical executors read time, not samples', () => {
  const from = new Date('2026-09-22T00:00:00Z');
  const to = new Date('2026-09-22T10:00:00Z');
  const ctx = { windowFrom: from, windowTo: to, history: [], excludedRanges: [] };
  const at = (h: number, value: number) => ({ at: new Date(from.getTime() + h * HOUR), value });
  // idle 0–1h, working 1–2h, then six quick working readings 2–2.5h, idle 2.5–5h, working 5–10h.
  const series = [at(0, 1), at(1, 2), ...[2, 2.1, 2.2, 2.3, 2.4].map((h) => at(h, 2)), at(2.5, 1), at(5, 2)];
  const run = (name: string, scalars: number[], rows = series) => lookupExecutor(name)!.run([rows], scalars, [], ctx);

  it('fraction_in_state weighs each state by how long it held, not how often it was reported', () => {
    // idle 1h + 2.5h = 3.5h of 10h. A sample count would say 2 of 9 readings.
    expect(run('fraction_in_state', [1])).toEqual({ ok: true, value: 0.35 });
  });

  it('transitions counts changes from one state to another, not repeated reports of the same one', () => {
    expect(run('transitions', [1, 2])).toEqual({ ok: true, value: 2 });
    expect(run('transitions', [2, 1])).toEqual({ ok: true, value: 1 });
  });

  it('dwell_in_state is the longest unbroken run, joining consecutive reports of the same state', () => {
    expect(run('dwell_in_state', [2])).toEqual({ ok: true, value: 5 });
    expect(run('dwell_in_state', [1])).toEqual({ ok: true, value: 2.5 });
  });

  it('no readings is no_readings, never 0', () => {
    for (const [name, args] of [['fraction_in_state', [1]], ['transitions', [1, 2]], ['dwell_in_state', [1]]] as const) {
      expect(run(name, [...args], [])).toEqual({ ok: false, reason: 'no_readings' });
    }
  });
});

describeDb('QCAT1: vocabulary, publish and evaluation', () => {
  let owner: DataSource;
  let ds: DataSource;
  let states: SignalStateService;
  let authoring: CatalogAuthoringService;
  let evaluator: KpiEvaluatorService;

  const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-S' };
  const IMEI = 'imei-dg-s';
  const NOW = new Date('2026-09-22T12:00:00.000Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    states = new SignalStateService(owner);
    authoring = new CatalogAuthoringService(
      owner.getRepository(EquipmentClassProfile), owner.getRepository(EquipmentClassFormula),
      owner.getRepository(ScenarioDefinition), owner.getRepository(SignalAlias),
      owner.getRepository(AlertRuleTemplate), owner.getRepository(NamedFormula),
      owner.getRepository(SensorRoleCapability),
    );
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  describe('the vocabulary', () => {
    it('refuses two states on one code', async () => {
      await expect(owner.query(
        `INSERT INTO signal_state (measurement_role, state, code, updated_by) VALUES ('x', 'a', 0, 't'), ('x', 'b', 0, 't')`,
      )).rejects.toThrow(/uq_signal_state_code/);
    });

    it('refuses a state name a formula could not write, and a negative code', async () => {
      await expect(owner.query(`INSERT INTO signal_state (measurement_role, state, code, updated_by) VALUES ('x', 'Idle', 0, 't')`))
        .rejects.toThrow(/ck_signal_state_name/);
      await expect(owner.query(`INSERT INTO signal_state (measurement_role, state, code, updated_by) VALUES ('x', 'idle', -1, 't')`))
        .rejects.toThrow(/ck_signal_state_code/);
    });

    it('replaces a role\'s vocabulary as a whole', async () => {
      await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 1 }]);
      await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 1 }, { state: 'fault', code: 9 }]);
      expect((await states.list('ignition_status')).map((s) => `${s.state}=${s.code}`)).toEqual(['off=0', 'on=1', 'fault=9']);
    });

    it('a refused replacement changes nothing', async () => {
      await expect(states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 0 }]))
        .rejects.toThrow(/once per signal/);
      expect(await states.list('ignition_status')).toHaveLength(3);
    });
  });

  describe('publish resolves states to codes', () => {
    beforeAll(async () => {
      await states.replace(master, 'utilization_status', [
        { state: 'off', code: 0 }, { state: 'idle', code: 1 }, { state: 'working', code: 2 },
      ]);
    });

    const draft = async (slug: string, expression: string) => {
      await authoring.createClass(master, slug, {
        name: slug, expectedSignals: [{ signal: 'utilization_status', unit: 'dimensionless', required: true }] as any,
      });
      await owner.getRepository(EquipmentClassFormula).save(owner.getRepository(EquipmentClassFormula).create({
        classSlug: slug, classVersion: 1, formulaKey: 'idle_share', kind: 'empirical', expression,
      }));
    };

    it('a published plan carries the code, read from the vocabulary', async () => {
      await draft('cat-genset', "fraction_in_state(utilization_status, 'idle')");
      await authoring.publishClass(master, 'cat-genset');
      const f = await owner.getRepository(EquipmentClassFormula).findOneByOrFail({ classSlug: 'cat-genset' });
      expect((f.compiledPlan as any).args[1]).toMatchObject({ name: 'idle', code: 1 });
    });

    it('a state the vocabulary does not have blocks publish, naming it', async () => {
      await draft('cat-bad', "fraction_in_state(utilization_status, 'parked')");
      await expect(authoring.publishClass(master, 'cat-bad')).rejects.toThrow(/no state 'parked'/);
    });
  });

  describe('evaluation', () => {
    const seed = async (plan: unknown) => {
      for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection', 'equipment_profile', 'client_formula', 'client_equipment_class']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await owner.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'cat-genset', name: 'Genset', description: null, category: 'power',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'cat-genset', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await owner.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        equipmentClassSlug: 'cat-genset', classVersion: 1, tier: 'standard', commissionedAt: null,
        serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
      });
      await owner.getRepository(DeviceProjection).save({
        sourceSystem: EQUIPMENT.sourceSystem, externalId: 'dev-s', tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
        syncedAt: NOW, checksum: 'c', status: 'live', imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
      });
      await owner.getRepository(SignalBindingVersion).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: 'utilization_status', measurementRole: 'utilization_status', componentId: '', origin: 'physical',
        imei: IMEI, channel: 'ch1', sensorInstanceId: null, canonicalUnit: 'dimensionless', sourceUnit: null,
        validFrom: new Date('2026-01-01'), validTo: null, expectedPeriodSeconds: 3600, isPrimary: true, status: 'active',
        discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
      });
      await owner.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'cat-genset', formulaKey: 'idle_share', kind: 'empirical',
        expression: "fraction_in_state(utilization_status, 'idle')", compiledPlan: plan as any, compiledAt: NOW,
        compilerVersion: 'qcat1.0.0', resultUnit: 'dimensionless', requiredSignals: ['utilization_status'],
        requiredParameters: [], bindings: [], resultKind: 'scalar', displayUnit: null, displayFormat: 'number:2',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
        aggregationWindow: '24h', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      // Hourly, the newest 0.1h old so the signal is fresh: idle for the first six
      // readings (6h), working after. Known time runs from the first reading, 23.1h
      // before NOW, to the window's end.
      await owner.getRepository(TelemetryReading).save(Array.from({ length: 24 }, (_, i) => ({
        tenantId: 'acme', imei: IMEI, signal: 'utilization_status', value: i < 6 ? 1 : 2, unit: 'dimensionless',
        sourceTimestamp: new Date(NOW.getTime() - (23.1 - i) * HOUR), receivedAt: NOW, source: 'live' as const,
      })));
    };

    it('the idle share of the day comes back from real readings', async () => {
      await seed(compile("fraction_in_state(utilization_status, 'idle')", VOCAB).plan);
      const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'idle_share', NOW);
      expect(envelope).toMatchObject({ readiness: 'ready', unit: 'dimensionless' });
      expect(envelope.value).toBeCloseTo(6 / 23.1, 5);
    });

    it('a plan whose state was never resolved is not_configured, not a guessed state', async () => {
      await seed(compile("fraction_in_state(utilization_status, 'idle')").plan);
      expect(await evaluator.evaluateOne(scope, EQUIPMENT, 'idle_share', NOW)).toMatchObject({ value: null, readiness: 'not_configured' });
    });
  });

  it(`${MIGRATION} runs down and up again`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ gone }] = await owner.query(`SELECT to_regclass('signal_state') IS NULL AS gone`);
    expect(gone).toBe(true);
    await owner.runMigrations({ transaction: 'all' });
    const [{ back }] = await owner.query(`SELECT to_regclass('signal_state') IS NOT NULL AS back`);
    expect(back).toBe(true);
  });
});
