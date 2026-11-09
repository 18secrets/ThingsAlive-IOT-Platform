import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { EquipmentTemplate } from '../src/equipment-template/entities/equipment-template.entity';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { EquipmentTemplateService } from '../src/equipment-template/services/equipment-template.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { OPERATIONAL_PARAMETERS } from '../src/parameters/parameter-catalog';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ModelRatings1763700000000';
const HOUR = 3_600_000;

/**
 * Rated figures on a model, and a machine naming its model (D57). A class spans a range
 * of motors; the rating that every motor threshold is a ratio to has to be the machine's
 * own model's, or a 1 HP pump reads at 4,600% load (the workbook's V-01).
 */
describeDb('D57: model ratings', () => {
  let owner: DataSource;
  let ds: DataSource;
  let library: EquipmentTemplateService;
  let models: ClientEquipmentTemplateService;
  let equipment: EquipmentService;
  let parameters: ParameterService;
  let evaluator: KpiEvaluatorService;

  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const EARLIER = new Date('2026-01-01T00:00:00.000Z');
  const master: RequestScope = { tenantId: '', userId: 'u-master', roles: [], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const other: RequestScope = { tenantId: 'other', userId: 'u-other', roles: ['super admin'], isPlatformRole: false };
  const CLASS = 'motor-1ph';
  const IMEI = 'imei-motor-1';

  const ONE_HP = [
    { name: 'rated_current', value: 5.5, unit: 'A', source: 'Datasheet MINI-1HP p.5' },
    { name: 'rated_voltage', value: 220, source: 'Datasheet MINI-1HP p.5' },
    { name: 'poles', value: 2, source: 'Datasheet MINI-1HP p.5' },
  ];

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    library = new EquipmentTemplateService(ds.getRepository(EquipmentTemplate), ds);
    models = new ClientEquipmentTemplateService(ds);
    equipment = new EquipmentService(ds);
    parameters = new ParameterService(ds);
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "tenant_parameter"`);
    for (const t of ['telemetry_reading', 'signal_binding_version', 'device_projection', 'equipment_profile',
      'client_equipment_template_rating', 'client_equipment_template', 'equipment_template_rating',
      'equipment_template', 'client_formula', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    for (const tenantId of ['acme', 'other']) {
      for (const slug of [CLASS, 'pump-borewell']) {
        await owner.getRepository(ClientEquipmentClass).save({
          tenantId, slug, name: slug, description: null, category: 'motor',
          expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: slug, templateVersion: 1,
          templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        });
      }
    }
  });

  const libraryModel = async (name = 'Mini 1 HP', classSlug = CLASS) => {
    const t = await library.create({ name, equipmentClassSlug: classSlug });
    await library.replaceRatings(master, t.id, ONE_HP);
    return t;
  };

  describe('the database refuses what a rating cannot be', () => {
    let templateId: string;
    beforeEach(async () => { templateId = (await library.create({ name: 'Bare' })).id; });
    const insert = (name: string, value: number | string, source: string) => owner.query(
      `INSERT INTO "equipment_template_rating" ("template_id", "name", "value", "source", "updated_by")
       VALUES ($1, $2, $3, $4, 'u-master')`, [templateId, name, value, source],
    );

    it('a name that is not a rating', async () => {
      await expect(insert('fuel_price', 1, 'a page')).rejects.toThrow(/fk_equipment_template_rating_name/);
    });

    it('a figure with no source', async () => {
      await expect(insert('rated_current', 5.5, '   ')).rejects.toThrow(/ck_equipment_template_rating_source/);
    });

    it('NaN and infinity, which would reach a tile as numbers', async () => {
      await expect(insert('rated_current', 'NaN', 'p.5')).rejects.toThrow(/ck_equipment_template_rating_finite/);
      await expect(insert('rated_current', 'Infinity', 'p.5')).rejects.toThrow(/ck_equipment_template_rating_finite/);
    });

    it('its list of ratings is the compiler\'s list, unit for unit', async () => {
      const rows: { name: string; unit: string | null }[] = await owner.query(`SELECT "name", "unit" FROM "rating_parameter" ORDER BY "name"`);
      const catalog = OPERATIONAL_PARAMETERS.filter((p) => p.compilesWithUnit)
        .map((p) => ({ name: p.name, unit: p.unit })).sort((a, b) => a.name.localeCompare(b.name));
      expect(rows).toEqual(catalog);
    });
  });

  describe('Master Admin\'s library', () => {
    it('refuses a rating in another unit, not converting it', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      await expect(library.replaceRatings(master, t.id, [{ name: 'rated_current', value: 5500, unit: 'mA', source: 'p.5' }]))
        .rejects.toThrow(/"rated_current" is measured in "A", not "mA"/);
      expect(await library.ratings(t.id)).toEqual([]);
    });

    it('refuses a parameter that is not a rating, and a name given twice', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      await expect(library.replaceRatings(master, t.id, [{ name: 'fuel_price', value: 1, source: 'p.1' }]))
        .rejects.toThrow(/"fuel_price" is not a rating a model can carry/);
      await expect(library.replaceRatings(master, t.id, [ONE_HP[0], ONE_HP[0]]))
        .rejects.toThrow(/"rated_current" is given twice/);
    });

    it('reports each rating in its own unit', async () => {
      const t = await libraryModel();
      expect((await library.ratings(t.id)).map((r) => [r.name, r.value, r.unit])).toEqual([
        ['poles', 2, null], ['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V'],
      ]);
    });

    it('replacing is idempotent: two identical saves at once both succeed, one set results', async () => {
      const t = await library.create({ name: 'Mini 1 HP' });
      const results = await Promise.allSettled([
        library.replaceRatings(master, t.id, ONE_HP), library.replaceRatings(master, t.id, ONE_HP),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM "equipment_template_rating" WHERE "template_id" = $1`, [t.id]);
      expect(n).toBe(3);
    });
  });

  describe('an account\'s copy', () => {
    it('copies the ratings with the model, and later library edits do not follow', async () => {
      const t = await libraryModel();
      const copy = await models.copyFromMaster(acme, t.id);
      expect(copy.equipmentClassSlug).toBe(CLASS);
      await library.replaceRatings(master, t.id, [{ ...ONE_HP[0], value: 6 }]);
      expect((await models.ratings(acme, copy.id)).find((r) => r.name === 'rated_current')?.value).toBe(5.5);
    });

    it('another account cannot read it', async () => {
      const copy = await models.copyFromMaster(acme, (await libraryModel()).id);
      await expect(models.ratings(other, copy.id)).rejects.toThrow(/No equipment template/);
    });

    it('replacing the account\'s own figures is idempotent under concurrency too', async () => {
      const copy = await models.copyFromMaster(acme, (await libraryModel()).id);
      const changed = [{ ...ONE_HP[0], value: 5.2, source: 'Our bench test, 2026-11-09' }];
      const results = await Promise.allSettled([
        models.replaceRatings(acme, copy.id, changed), models.replaceRatings(acme, copy.id, changed),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await models.ratings(acme, copy.id)).toEqual([expect.objectContaining({ name: 'rated_current', value: 5.2 })]);
    });
  });

  describe('a machine naming its model', () => {
    let modelId: string;
    const EQUIPMENT = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-1' };

    beforeEach(async () => {
      modelId = (await models.copyFromMaster(acme, (await libraryModel()).id)).id;
    });

    const machine = (extra: Record<string, unknown> = {}) =>
      equipment.create(acme, { code: 'PUMP-1', name: 'Pump 1', equipmentClassSlug: CLASS, ...extra } as never);

    const wireLoadRatio = async () => {
      await owner.getRepository(DeviceProjection).save({
        sourceSystem: EQUIPMENT.sourceSystem, externalId: 'dev-PUMP-1', tenantId: 'acme',
        payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
        imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
      });
      await owner.getRepository(SignalBindingVersion).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        signalKey: 'motor_current', measurementRole: 'motor_current', componentId: '',
        origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
        canonicalUnit: 'A', sourceUnit: null, validFrom: EARLIER, validTo: null,
        expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
        discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
      });
      const expression = 'avg(motor_current) / @rated_current';
      const compiled = compileFormula({
        formulaKey: 'load_ratio', expression, classSlug: CLASS, expectedSignals: [{ signal: 'motor_current', unit: 'A' }],
      });
      await owner.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: CLASS, formulaKey: 'load_ratio', kind: 'empirical', expression,
        compiledPlan: compiled.plan as any, compiledAt: NOW, compilerVersion: compiled.compilerVersion,
        resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
        requiredParameters: compiled.requiredParameters, bindings: [], resultKind: compiled.resultKind,
        displayUnit: null, displayFormat: 'number:2', targetValue: null, targetMin: null, targetMax: null,
        targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
        templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await owner.getRepository(TelemetryReading).save([5.5, 5.5].map((value, i) => ({
        tenantId: 'acme', imei: IMEI, signal: 'motor_current', value, unit: 'A',
        sourceTimestamp: new Date(NOW.getTime() - (2 - i) * 0.1 * HOUR), receivedAt: NOW, source: 'live' as const,
      })));
    };

    it('reads its rated current from the model: the load ratio computes with nothing typed on the machine', async () => {
      await machine({ modelId });
      await wireLoadRatio();
      expect(await evaluator.evaluateOne(acme, EQUIPMENT, 'load_ratio', NOW)).toMatchObject({
        readiness: 'ready', value: 1, unit: 'dimensionless',
      });
    });

    it('a nameplate value on the machine beats the model\'s catalogue figure', async () => {
      const profile = await machine({ modelId });
      await wireLoadRatio();
      await parameters.set(acme, { scope: 'equipment', scopeRef: profile.id, name: 'rated_current', value: 5, effectiveFrom: EARLIER });
      expect((await evaluator.evaluateOne(acme, EQUIPMENT, 'load_ratio', NOW)).value).toBeCloseTo(1.1, 5);
    });

    it('with no model and no nameplate value it is not_configured, never a default', async () => {
      await machine();
      await wireLoadRatio();
      expect(await evaluator.evaluateOne(acme, EQUIPMENT, 'load_ratio', NOW)).toMatchObject({
        readiness: 'not_configured', missingParameters: ['rated_current'],
      });
    });

    it('refuses a model of another class', async () => {
      const pumpModel = (await models.copyFromMaster(acme, (await libraryModel('Borewell 5 HP', 'pump-borewell')).id)).id;
      await expect(machine({ modelId: pumpModel })).rejects.toThrow(/is a model of "pump-borewell", and this machine is a "motor-1ph"/);
    });

    it('refuses another account\'s model — and so does the database, by itself', async () => {
      const theirs = (await models.copyFromMaster(other, (await libraryModel('Theirs')).id)).id;
      await expect(machine({ modelId: theirs })).rejects.toThrow(/No equipment model/);
      const profile = await machine();
      await expect(owner.query(
        `UPDATE "equipment_profile" SET "client_equipment_template_id" = $1 WHERE "id" = $2`, [theirs, profile.id],
      )).rejects.toThrow(/fk_equipment_profile_model/);
    });

    it('deleting a model a machine names is refused; once released, it deletes with its ratings', async () => {
      await machine({ modelId });
      await expect(models.remove(acme, modelId)).rejects.toThrow(/Machines name this template as their model/);
      await equipment.update(acme, EQUIPMENT, { modelId: null });
      await models.remove(acme, modelId);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM "client_equipment_template_rating" WHERE "template_id" = $1`, [modelId]);
      expect(n).toBe(0);
    });
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const gone = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('rating_parameter', 'equipment_template_rating', 'client_equipment_template_rating')`);
    expect(gone).toHaveLength(0);
    const col = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'equipment_profile' AND column_name = 'client_equipment_template_id'`);
    expect(col).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('rating_parameter', 'equipment_template_rating', 'client_equipment_template_rating')`);
    expect(back).toHaveLength(3);
  });
});
