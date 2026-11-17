import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  describeSignalThresholdRule, evaluateRule, SignalThresholdParams, validateParams, WindowReading,
} from '../src/alert/services/alert-rules';
import { AlertService } from '../src/alert/services/alert.service';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { EquipmentTemplate } from '../src/equipment-template/entities/equipment-template.entity';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { EquipmentTemplateService } from '../src/equipment-template/services/equipment-template.service';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

jest.setTimeout(30_000);

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const current = (values: number[], unit = 'A'): WindowReading[] => values.map((value, i) => ({
  signal: 'motor_current', value, unit, imei: 'imei-1', sourceTimestamp: new Date(T0 + i * 60_000).toISOString(),
}));
const OVERLOAD: SignalThresholdParams = { signal: 'motor_current', rating: 'rated_current', max: 1.2 };
const rated = (value: number) => new Map([['rated_current', { value, unit: 'A' }]]);
const run = (params: SignalThresholdParams, readings: WindowReading[], ratings?: Map<string, { value: number; unit: string | null }>) =>
  evaluateRule({ trigger: 'signal-threshold', params, readings, predictions: [], ratings });

/**
 * Threshold bounds as multiples of a motor rating (D59). One class spans many models;
 * an overload threshold in amps is right for one and wrong for the rest, and a corrected
 * rating would not move it. The rule stays parameters (D34): a rating and a multiple.
 */
describe('D59: a rated bound', () => {
  it('fires above 1.2 × this machine\'s rated current, and says what the bound was', () => {
    const firing = run(OVERLOAD, current(Array(10).fill(7)), rated(5.5));
    expect(firing?.evidence).toMatchObject({ bound: 6.6, rating: 'rated_current', ratingValue: 5.5, factor: 1.2, direction: 'above' });
    expect(firing?.summary).toMatch(/breached 6\.6/);
  });

  it('the same current on a bigger motor of the class is no alert', () => {
    expect(run(OVERLOAD, current(Array(10).fill(7)), rated(7.4))).toBeNull();
  });

  it('a machine without the rating has no bound, so no alert, rather than a guessed one', () => {
    expect(run(OVERLOAD, current(Array(10).fill(70)))).toBeNull();
    expect(run(OVERLOAD, current(Array(10).fill(70)), new Map())).toBeNull();
  });

  it('readings in another unit than the rating are not compared with it', () => {
    expect(run(OVERLOAD, current(Array(10).fill(7000), 'mA'), rated(5.5))).toBeNull();
  });

  it('a rule without a rating is exactly what it was', () => {
    expect(run({ signal: 'motor_current', max: 6 }, current(Array(10).fill(7)))?.evidence).toMatchObject({ bound: 6 });
  });

  it('reads back as a multiple of the rating, never as amps', () => {
    expect(describeSignalThresholdRule(OVERLOAD, { displayName: 'motor current', unit: 'A' }))
      .toBe('Fires when at least 6 of the last 10 readings of motor current rise above 1.2 × rated current.');
  });

  it('refuses a rating that is not one, and a multiple that is not above 0', () => {
    expect(validateParams('signal-threshold', { ...OVERLOAD, rating: 'fuel_price' })).toMatch(/"fuel_price" is not a rating/);
    expect(validateParams('signal-threshold', { ...OVERLOAD, max: 0 })).toMatch(/multiple of it and has to be above 0/);
    expect(validateParams('signal-threshold', OVERLOAD)).toBeNull();
  });
});

describeDb('D59: rated bounds end to end', () => {
  let owner: DataSource;
  let ds: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  describe('the import', () => {
    let parser: WorkbookParserService;
    let validator: CatalogImportValidatorService;
    let applier: CatalogImportApplyService;
    const templates = new CatalogTemplateService();

    beforeAll(() => {
      parser = new WorkbookParserService(ds);
      validator = new CatalogImportValidatorService(ds);
      applier = new CatalogImportApplyService(ds);
    });

    beforeEach(async () => {
      await owner.query(
        `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "alert_rule_template",
          "equipment_class_formula", "equipment_class_sensor_requirement",
          "sensor_role_capability", "equipment_class_profile", "sensor"
         RESTART IDENTITY CASCADE`,
      );
      await ds.getRepository(Sensor).save(
        ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' }),
      );
    });

    /** The template workbook's own signal row, with its limit turned into a rated one. */
    const upload = async (signal: Record<string, string | number>) => {
      const wb = new Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wb.xlsx.load(await templates.build(new Date('2026-11-09T00:00:00.000Z')) as any);
      const cols = ALL_SHEETS.find((s) => s.sheet === 'signal')!.columns.map((c) => c.name);
      for (const [column, value] of Object.entries(signal)) {
        wb.getWorksheet('signal')!.getRow(2).getCell(cols.indexOf(column) + 1).value = value;
      }
      const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as unknown as Buffer, 'wb.xlsx', 'deepak');
      await validator.validate(parsed.id);
      return parsed.id;
    };

    it('a rating on a signal row drafts a rated threshold template', async () => {
      await applier.apply(await upload({ rating: 'insulation_temp_limit', max: 0.9 }), 'deepak');
      const [t] = await ds.getRepository(AlertRuleTemplate).find();
      expect(t.params).toEqual({ signal: 'coolant_temp_c', max: 0.9, rating: 'insulation_temp_limit' });
      expect(t.name).toBe('coolant_temp_c above 0.9 × insulation temp limit');
    });

    it('a rating that is not one is refused on its row, before anything is staged', async () => {
      const batchId = await upload({ rating: 'rated_torque', max: 1.2 });
      const rows: { status: string; message: string | null }[] = await owner.query(
        `SELECT "status", "message" FROM "catalog_import_row" WHERE "batch_id" = $1 AND "sheet" = 'signal'`, [batchId],
      );
      expect(rows[0].status).toBe('invalid');
      expect(rows[0].message).toMatch(/"rated_torque" is not a rating/);
    });
  });

  describe('an alert on a machine', () => {
    const NOW = new Date('2026-11-09T12:00:00.000Z');
    const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
    const master: RequestScope = { tenantId: '', userId: 'u-master', roles: [], isPlatformRole: true };
    const EQUIPMENT = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'MOTOR-A' };
    let alerts: AlertService;
    let equipment: EquipmentService;
    let parameters: ParameterService;
    let profileId: string;

    beforeEach(async () => {
      for (const t of ['alert_event', 'alert_rule', 'equipment_model', 'equipment_profile', 'client_equipment_template',
        'equipment_template', 'client_equipment_class']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await owner.query(`TRUNCATE "tenant_parameter"`);
      alerts = new AlertService(ds);
      equipment = new EquipmentService(ds);
      parameters = new ParameterService(ds);
      await owner.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'motor-1ph', name: 'Motor', description: null, category: 'motor',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'motor-1ph', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      profileId = (await equipment.create(acme, { code: 'MOTOR-A', name: 'Motor A', equipmentClassSlug: 'motor-1ph' })).id;
      await alerts.createRule(acme, {
        slug: 'overload', name: 'Overload', trigger: 'signal-threshold', params: OVERLOAD, appliesTo: 'account',
      });
    });

    const shift = () => alerts.evaluateWindow({
      tenantId: 'acme', ...EQUIPMENT, shiftLocalDate: '2026-11-09',
      windowStart: new Date(T0), windowEnd: NOW, readings: current(Array(10).fill(7)), predictions: [],
    });

    it('reads the rated current from the machine\'s model', async () => {
      const library = new EquipmentTemplateService(ds.getRepository(EquipmentTemplate), ds);
      const t = await library.create({ name: 'Motor 1 HP', equipmentClassSlug: 'motor-1ph' });
      await library.replaceRatings(master, t.id, [{ name: 'rated_current', value: 5.5, source: 'Datasheet p.2' }]);
      const copy = await new ClientEquipmentTemplateService(ds).copyFromMaster(acme, t.id);
      await equipment.setModel(acme, EQUIPMENT, copy.id);
      const fired = await shift();
      expect(fired).toHaveLength(1);
      expect(fired[0].evidence).toMatchObject({ bound: 6.6, ratingValue: 5.5 });
    });

    it('a nameplate value on the machine wins over the model', async () => {
      await parameters.set(acme, {
        scope: 'equipment', scopeRef: profileId, name: 'rated_current', value: 7.4, effectiveFrom: new Date('2026-01-01'),
      });
      expect(await shift()).toHaveLength(0);
    });

    it('with no rating anywhere, no alert fires — not one at a guessed bound', async () => {
      expect(await shift()).toHaveLength(0);
    });
  });
});
