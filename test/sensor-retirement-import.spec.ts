import { DataSource } from 'typeorm';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { analyzeSensorCapability } from '../src/catalog-import/services/sensor-review';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { retiredSensorProblem } from '../src/device-catalog/services/sensor-retirement';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The workbook import names a retired sensor before anything is written (QCAT2,
 * import half — Builder A's `src/catalog-import`). Without this the database guard
 * still refuses the write and the apply rolls back; what this adds is the row-level
 * message at validation, naming the sensor and its retirement date, instead of the
 * whole apply failing on the database's refusal.
 */
describeDb('sensor retirement in the workbook import', () => {
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;
  let sensor: Sensor;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping));
  }, 30000);
  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });
  beforeEach(async () => {
    await owner.query(`TRUNCATE sensor, sensor_category, equipment_class_profile, client_equipment_class,
      tool_mapping, catalog_import_batch RESTART IDENTITY CASCADE`);
    sensor = await ds.getRepository(Sensor).save({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' });
  });
  const workbook = async () => {
    const buffer = await new CatalogTemplateService().build(new Date('2026-10-05'));
    const batch = await new WorkbookParserService(ds).parse(buffer, 'retirement.xlsx', 'tester');
    await new CatalogImportValidatorService(ds).validate(batch.id);
    return batch;
  };

  it.each(['slug', 'name'])('workbook %s resolution refuses a retired sensor without proposing a replacement', async (strategy) => {
    const retired = await catalog.retireSensor(sensor.id, 'tester');
    const row = Object.assign(new CatalogImportRow(), { id: 'row', rowNumber: 2, payload: {
      sensor_name: ' Coolant Temp Probe ', ...(strategy === 'slug' ? { sensor_slug: sensor.slug } : {}),
    } });
    const result = await analyzeSensorCapability(ds.manager, [row], []);
    expect(result.resolutions[0]).toMatchObject({ status: 'retired', message: retiredSensorProblem(retired) });
    expect(result.proposedSensors).toEqual([]);
  });

  it('marks the uploaded capability invalid with the shared refusal', async () => {
    const retired = await catalog.retireSensor(sensor.id, 'tester');
    const batch = await workbook();
    const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: batch.id, sheet: 'sensor_capability' } });
    expect(rows[0]).toMatchObject({ status: 'invalid', message: retiredSensorProblem(retired) });
  });
});
