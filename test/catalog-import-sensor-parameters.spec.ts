import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportSensorReviewService } from '../src/catalog-import/services/catalog-import-sensor-review.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A sensor approved from a catalog import keeps the channels the workbook gave it
 * (tester bug TC-049, 2026-10-15).
 *
 * The proposal carried each row's parameter_key and canonical_unit, and approval threw
 * them away: the sensor was created with `parameterSpecs: []`. That is not cosmetic — a
 * tool mapping may only name a parameter its sensor declares, so the imported sensor
 * could not be wired to any device until somebody re-typed its channels by hand.
 */
describeDb('catalog import: an approved sensor keeps its parameters', () => {
  let owner: DataSource;
  let ds: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let diff: CatalogImportDiffService;
  let review: CatalogImportSensorReviewService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;
  let catalog: DeviceCatalogService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    diff = new CatalogImportDiffService(ds);
    review = new CatalogImportSensorReviewService(ds, diff, validator);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
    catalog = new DeviceCatalogService(
      ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping),
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "tool_mapping",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor", "sensor_category"
       RESTART IDENTITY CASCADE`,
    );
    // The template's own sensor_capability example names this sensor; seeded so the
    // plain template resolves, as in catalog-import-sensor-review.spec.ts.
    await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
      sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe',
    }));
  });

  const workbookWith = async (rows: Record<string, unknown>[]): Promise<Buffer> => {
    const wb = new Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(await templates.build(new Date('2026-09-22T00:00:00.000Z')) as any);
    const schema = ALL_SHEETS.find((s) => s.sheet === 'sensor_capability')!;
    for (const values of rows) {
      wb.getWorksheet('sensor_capability')!.addRow(schema.columns.map((c) => values[c.name] ?? ''));
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };

  const approveGhost = async (rows: Record<string, unknown>[]) => {
    const parsed = await parser.parse(await workbookWith(rows), 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    const proposal = (await diff.buildDiff(parsed.id)).proposedSensors.find((p) => p.slug === 'ghost-sensor');
    expect(proposal).toBeDefined();
    await review.review(parsed.id, { approve: [{ slug: 'ghost-sensor' }] }, 'deepak');
    return ds.getRepository(Sensor).findOneOrFail({ where: { slug: 'ghost-sensor' } });
  };

  it('every channel the workbook names for the sensor becomes a parameter, with its unit', async () => {
    const sensor = await approveGhost([
      { sensor_name: 'Ghost Sensor', signal: 'oil_pressure', parameter_key: 'oil_p', canonical_unit: 'bar' },
      { sensor_name: 'Ghost Sensor', signal: 'oil_temp', parameter_key: 'oil_t', canonical_unit: 'degC' },
    ]);
    expect(sensor.parameterSpecs.map((p) => [p.parameter, p.unit])).toEqual([['oil_p', 'bar'], ['oil_t', 'degC']]);
  });

  it('a row with no parameter_key names its channel by its signal', async () => {
    const sensor = await approveGhost([
      { sensor_name: 'Ghost Sensor', signal: 'fuel_level', canonical_unit: '%' },
    ]);
    expect(sensor.parameterSpecs.map((p) => [p.parameter, p.unit])).toEqual([['fuel_level', '%']]);
  });

  // The workbook has no range column. 0–0 would read as a real limit; null says "not set".
  it('the range is left unset, never invented', async () => {
    const sensor = await approveGhost([
      { sensor_name: 'Ghost Sensor', signal: 'oil_pressure', parameter_key: 'oil_p', canonical_unit: 'bar' },
    ]);
    expect(sensor.parameterSpecs[0]).toMatchObject({ min: null, max: null, normalRange: '' });
  });

  it('the approved sensor can be wired into a tool mapping by those parameters — and only those', async () => {
    const sensor = await approveGhost([
      { sensor_name: 'Ghost Sensor', signal: 'oil_pressure', parameter_key: 'oil_p', canonical_unit: 'bar' },
    ]);
    const mapping = await catalog.createToolMapping({
      toolName: 'Imported kit', mappedSensors: [{ sensorId: sensor.id, parameters: ['oil_p'] }],
    });
    expect(mapping.mappedSensors).toMatchObject([{ sensorId: sensor.id, parameters: ['oil_p'] }]);
    await expect(catalog.createToolMapping({
      toolName: 'Wrong kit', mappedSensors: [{ sensorId: sensor.id, parameters: ['not_declared'] }],
    })).rejects.toThrow(BadRequestException);
  });

  // The tester's case (TC_123): the sensor was already in the catalog, so nothing was
  // proposed — apply wrote the signal link and never gave the sensor the parameter.
  describe('a sensor that already exists', () => {
    const seedOilProbe = () => ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
      sensorName: 'Oil Probe', slug: 'oil-probe',
      parameterSpecs: [{ parameter: 'oil_p', unit: 'bar', min: 0, max: 10, normalRange: '2-6', notes: 'set by hand' }],
    }));
    const importAndApply = async (rows: Record<string, unknown>[]) => {
      const parsed = await parser.parse(await workbookWith(rows), 'wb.xlsx', 'deepak');
      await validator.validate(parsed.id);
      return applier.apply(parsed.id, 'deepak');
    };
    const rows = [
      { sensor_name: 'Oil Probe', sensor_slug: 'oil-probe', signal: 'oil_pressure', parameter_key: 'oil_p', canonical_unit: 'bar' },
      { sensor_name: 'Oil Probe', sensor_slug: 'oil-probe', signal: 'oil_temp', parameter_key: 'oil_t', canonical_unit: 'degC' },
    ];

    it('gains the parameters it did not declare; the ones it had, and their hand-set range, are untouched', async () => {
      const { id } = await seedOilProbe();
      const summary = await importAndApply(rows);
      const sensor = await ds.getRepository(Sensor).findOneByOrFail({ id });
      expect(sensor.parameterSpecs).toEqual([
        { parameter: 'oil_p', unit: 'bar', min: 0, max: 10, normalRange: '2-6', notes: 'set by hand' },
        expect.objectContaining({ parameter: 'oil_t', unit: 'degC', min: null, max: null }),
      ]);
      // Two: oil_t here, and the template's own example row gives the seeded Coolant
      // Temp Probe (no specs) its parameter too.
      expect(summary.sensorCapabilities.parametersAdded).toBe(2);
    });

    it('applying the same workbook again adds nothing twice', async () => {
      const { id } = await seedOilProbe();
      await importAndApply(rows);
      const again = await importAndApply(rows);
      expect(again.sensorCapabilities.parametersAdded).toBe(0);
      expect((await ds.getRepository(Sensor).findOneByOrFail({ id })).parameterSpecs.map((p) => p.parameter))
        .toEqual(['oil_p', 'oil_t']);
    });
  });
});
