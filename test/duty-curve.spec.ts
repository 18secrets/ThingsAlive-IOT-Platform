import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { curveAt } from '../src/catalog/formula/executor-registry';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { EquipmentTemplate } from '../src/equipment-template/entities/equipment-template.entity';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { EquipmentTemplateService } from '../src/equipment-template/services/equipment-template.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'DutyCurves1763800000000';
const HOUR = 3_600_000;
const SIGNALS = [
  { signal: 'input_power', unit: 'kW' },
  { signal: 'motor_current', unit: 'A' },
];
const compile = (expression: string) => compileFormula({
  formulaKey: 'f', expression, classSlug: 'pump', expectedSignals: SIGNALS,
});

// Illustrative numbers in the shape of a small self-priming pump's table, NOT catalogue
// figures: head falls as flow rises, and input power falls with it. Flow in L/min.
const CURVE = [
  { headM: 50, flowLpm: 15, inputKw: 1.10 },
  { headM: 36, flowLpm: 35, inputKw: 1.00 },
  { headM: 27, flowLpm: 50, inputKw: 0.95 },
  { headM: 18, flowLpm: 60, inputKw: 0.90 },
  { headM: 6, flowLpm: 70, inputKw: 0.80 },
];
const ROWS = CURVE.map((p) => [p.headM, p.flowLpm, p.inputKw]);
const [HEAD, FLOW, POWER] = [0, 1, 2];

/**
 * The duty curve and `curve_at` (D58). The sensorless pump design estimates flow by
 * reading the catalogue curve backwards from measured power; the curve is the capacity
 * carrier, so the same formulas serve a 0.5 HP and a 5 HP pump.
 */
describe('D58: compiling curve_at', () => {
  it('the flow estimate reads flow by measured power, in L/min', () => {
    const q = compile("curve_at('flow_lpm', 'input_kw', avg(input_power))");
    expect(q.resultUnit).toBe('L/min');
    expect(q.resultKind).toBe('scalar');
  });

  it('expected power at the installation reads power by the install head (a D56 rating in m)', () => {
    expect(compile("curve_at('input_kw', 'head_m', @install_head)").resultUnit).toBe('kW');
  });

  it('refuses a value in another unit than the column it is read by', () => {
    expect(() => compile("curve_at('flow_lpm', 'input_kw', avg(motor_current))"))
      .toThrow(/by 'input_kw' with a value in "A"; it must be in "kW"/);
  });

  it('refuses a column the curve does not have, including an inherited name', () => {
    expect(() => compile("curve_at('pressure', 'input_kw', avg(input_power))")).toThrow(/columns are 'head_m', 'flow_lpm', 'input_kw'/);
    expect(() => compile("curve_at('constructor', 'input_kw', avg(input_power))")).toThrow(/as a curve column/);
  });

  it('refuses reading a column by itself, and a raw signal as the value', () => {
    expect(() => compile("curve_at('input_kw', 'input_kw', avg(input_power))")).toThrow(/by itself/);
    expect(() => compile("curve_at('flow_lpm', 'input_kw', input_power)")).toThrow(/Reduce the signal first/);
  });
});

describe('D58: reading the curve', () => {
  it('a printed point returns the printed figure', () => {
    expect(curveAt(ROWS, FLOW, HEAD, 27)).toEqual({ ok: true, value: 50 });
  });

  it('between points it is linear', () => {
    expect(curveAt(ROWS, FLOW, POWER, 0.975)).toEqual({ ok: true, value: 42.5 });
  });

  it('reads backwards along the curve as readily as forwards', () => {
    const power = curveAt(ROWS, POWER, HEAD, 31.5);
    expect(power.ok && power.value).toBeCloseTo(0.975, 10);
  });

  it('never extrapolates: outside the printed range there is no answer', () => {
    expect(curveAt(ROWS, FLOW, POWER, 1.5)).toEqual({ ok: false, reason: 'out_of_curve' });
    expect(curveAt(ROWS, FLOW, HEAD, 60)).toEqual({ ok: false, reason: 'out_of_curve' });
  });

  it('a column that turns back has two answers somewhere, so it gives none', () => {
    const humped = ROWS.map((r, i) => [r[0], r[1], i === 2 ? 1.2 : r[2]]);
    expect(curveAt(humped, FLOW, POWER, 1.05)).toEqual({ ok: false, reason: 'curve_not_monotonic' });
  });
});

describeDb('D58: duty curves end to end', () => {
  let owner: DataSource;
  let ds: DataSource;
  let library: EquipmentTemplateService;
  let models: ClientEquipmentTemplateService;
  let equipment: EquipmentService;
  let evaluator: KpiEvaluatorService;

  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const EARLIER = new Date('2026-01-01T00:00:00.000Z');
  const master: RequestScope = { tenantId: '', userId: 'u-master', roles: [], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const CLASS = 'pump-mini';
  const IMEI = 'imei-pump-c';
  const EQUIPMENT = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-C' };
  const SOURCE = 'Illustrative test curve (not a catalogue figure)';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    library = new EquipmentTemplateService(ds.getRepository(EquipmentTemplate), ds);
    models = new ClientEquipmentTemplateService(ds);
    equipment = new EquipmentService(ds);
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection', 'equipment_model', 'equipment_profile',
      'client_equipment_template', 'equipment_template', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: CLASS, name: 'Mini pump', description: null, category: 'pump',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
  });

  const insertPoints = (templateId: string, points: number[][]) => owner.transaction(async (m) => {
    for (const [i, [h, q, p]] of points.entries()) {
      await m.query(
        `INSERT INTO "equipment_template_curve_point" ("template_id", "point", "head_m", "flow_lpm", "input_kw", "source", "updated_by")
         VALUES ($1, $2, $3, $4, $5, 'p.5', 'u-master')`, [templateId, i, h, q, p],
      );
    }
  });

  describe('the database holds the shape at commit', () => {
    it('refuses head rising with flow', async () => {
      const t = await library.create({ name: 'Bent' });
      await expect(insertPoints(t.id, [[50, 15, 1.1], [55, 35, 1.0]])).rejects.toThrow(/duty_curve_shape/);
    });

    it('refuses a single point, which cannot be read between', async () => {
      const t = await library.create({ name: 'Lonely' });
      await expect(insertPoints(t.id, [[50, 15, 1.1]])).rejects.toThrow(/at least two points/);
    });

    it('accepts a real duty shape', async () => {
      const t = await library.create({ name: 'Fine' });
      await insertPoints(t.id, ROWS);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM "equipment_template_curve_point" WHERE "template_id" = $1`, [t.id]);
      expect(n).toBe(5);
    });
  });

  describe('saving a curve', () => {
    it('sorts a table printed high-head-first, and names the points that are not a duty curve', async () => {
      const t = await library.create({ name: 'Mini 1 HP', equipmentClassSlug: CLASS });
      const saved = await library.replaceDutyCurve(master, t.id, { source: SOURCE, points: [...CURVE].reverse() });
      expect(saved.points.map((p) => p.flowLpm)).toEqual([15, 35, 50, 60, 70]);
      await expect(library.replaceDutyCurve(master, t.id, {
        source: SOURCE, points: [{ headM: 20, flowLpm: 30, inputKw: 1 }, { headM: 25, flowLpm: 40, inputKw: 1 }],
      })).rejects.toThrow(/Points at 30 and 40 L\/min are not a duty curve/);
    });

    it('needs a source', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      await expect(library.replaceDutyCurve(master, t.id, { source: ' ', points: CURVE })).rejects.toThrow(/needs a source/);
    });

    it('is idempotent: two identical saves at once both succeed, one curve results', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      const results = await Promise.allSettled([
        library.replaceDutyCurve(master, t.id, { source: SOURCE, points: CURVE }),
        library.replaceDutyCurve(master, t.id, { source: SOURCE, points: CURVE }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await library.dutyCurve(t.id)).points).toHaveLength(5);
    });

    it('the account\'s copy is idempotent under concurrency too', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      const copy = await models.copyFromMaster(acme, t.id);
      const results = await Promise.allSettled([
        models.replaceDutyCurve(acme, copy.id, { source: SOURCE, points: CURVE }),
        models.replaceDutyCurve(acme, copy.id, { source: SOURCE, points: CURVE }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await models.dutyCurve(acme, copy.id)).points).toHaveLength(5);
    });
  });

  describe('a machine reading its model\'s curve', () => {
    const wire = async (powerKw: number[]) => {
      await owner.getRepository(DeviceProjection).save({
        sourceSystem: EQUIPMENT.sourceSystem, externalId: 'dev-PUMP-C', tenantId: 'acme',
        payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
        imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
      });
      await owner.getRepository(SignalBindingVersion).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: 'input_power', measurementRole: 'input_power', componentId: '',
        origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
        canonicalUnit: 'kW', sourceUnit: null, validFrom: EARLIER, validTo: null,
        expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
        discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
      });
      const expression = "curve_at('flow_lpm', 'input_kw', avg(input_power))";
      const compiled = compileFormula({
        formulaKey: 'flow_estimate', expression, classSlug: CLASS, expectedSignals: [{ signal: 'input_power', unit: 'kW' }],
      });
      await owner.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: 'flow_estimate', kind: 'empirical', expression,
        compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
        resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
        requiredParameters: compiled.requiredParameters, bindings: [], resultKind: compiled.resultKind,
        displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
        targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await owner.getRepository(TelemetryReading).save(powerKw.map((value, i) => ({
        tenantId: 'acme', imei: IMEI, signal: 'input_power', value, unit: 'kW',
        sourceTimestamp: new Date(NOW.getTime() - (powerKw.length - i) * 0.1 * HOUR), receivedAt: NOW, source: 'live' as const,
      })));
    };

    const machineWithCurve = async () => {
      const t = await library.create({ name: 'Mini 1 HP', equipmentClassSlug: CLASS });
      await library.replaceDutyCurve(master, t.id, { source: SOURCE, points: CURVE });
      const copy = await models.copyFromMaster(acme, t.id);
      await equipment.create(acme, { code: 'PUMP-C', name: 'Pump C', equipmentClassSlug: CLASS });
      await equipment.setModel(acme, EQUIPMENT, copy.id);
    };

    it('estimates flow from measured power, through the curve copied with the model', async () => {
      await machineWithCurve();
      await wire([0.97, 0.98]); // avg 0.975 kW
      expect(await evaluator.evaluateOne(acme, EQUIPMENT, 'flow_estimate', NOW)).toMatchObject({
        readiness: 'ready', value: 42.5, unit: 'L/min',
      });
    });

    it('power beyond the printed table is no answer, not an extrapolated flow', async () => {
      await machineWithCurve();
      await wire([1.5, 1.5]);
      expect(await evaluator.evaluateOne(acme, EQUIPMENT, 'flow_estimate', NOW)).toMatchObject({
        readiness: 'not_available', reason: 'out_of_curve', value: null,
      });
    });

    it('a machine naming no model has no curve to read: not_configured, named', async () => {
      await equipment.create(acme, { code: 'PUMP-C', name: 'Pump C', equipmentClassSlug: CLASS });
      await wire([0.97, 0.98]);
      expect(await evaluator.evaluateOne(acme, EQUIPMENT, 'flow_estimate', NOW)).toMatchObject({
        readiness: 'not_configured', reason: 'duty_curve_not_set',
      });
    });
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const gone = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE '%curve_point'`);
    expect(gone).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE '%curve_point'`);
    expect(back).toHaveLength(2);
  });
});
