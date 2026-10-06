import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { DataSource } from 'typeorm';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { retiredSensorProblem } from '../src/device-catalog/services/sensor-retirement';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportBatch } from '../src/catalog-import/entities/catalog-import-batch.entity';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { analyzeSensorCapability } from '../src/catalog-import/services/sensor-review';
import { RequestScope } from '../src/auth/types/request-scope';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const master: RequestScope = { tenantId: 'things-alive', userId: 'tester', roles: ['master-admin'], isPlatformRole: true };
const signals = [{ signal: 'coolant_temp_c', unit: 'degC', required: true }];

describeDb('sensor retirement on new content and guarded deletion', () => {
  let app: INestApplication;
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;
  let author: CatalogAuthoringService;
  let sensor: Sensor;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping));
    author = new CatalogAuthoringService(ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias), ds.getRepository(AlertRuleTemplate),
      ds.getRepository(NamedFormula), ds.getRepository(SensorRoleCapability));
    process.env.AUTH_JWT_SECRET = 'test-secret-for-signing';
    process.env.AUTH_JWT_ISSUER = 'things-alive-platform-test';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 30000);
  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });
  beforeEach(async () => {
    await owner.query(`TRUNCATE sensor, sensor_category, equipment_class_profile, client_equipment_class,
      tool_mapping, catalog_import_batch RESTART IDENTITY CASCADE`);
    sensor = await ds.getRepository(Sensor).save({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' });
  });
  const capability = () => ds.getRepository(SensorRoleCapability).save({
    sensorId: sensor.id, measurementRole: 'coolant_temp_c', canonicalUnit: 'degC',
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

  it('rechecks retirement between validation and apply, without writing a class', async () => {
    const batch = await workbook();
    await catalog.retireSensor(sensor.id, 'tester');
    await expect(new CatalogImportApplyService(ds).apply(batch.id, 'tester', true)).rejects.toThrow('sensor_retired');
    expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(0);
    expect((await ds.getRepository(CatalogImportBatch).findOneByOrFail({ id: batch.id })).status).toBe('validated');
  });

  it('API create refuses a role whose only sensor is retired, with the same message', async () => {
    await capability();
    const retired = await catalog.retireSensor(sensor.id, 'tester');
    await expect(author.createClass(master, 'new-class', { expectedSignals: signals })).rejects.toThrow(retiredSensorProblem(retired)!);
    expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(0);
  });

  it('API edits refuse adding a retired role and publishing rechecks an existing draft', async () => {
    await capability();
    await author.createClass(master, 'draft', { expectedSignals: signals });
    await author.createClass(master, 'empty', {});
    await catalog.retireSensor(sensor.id, 'tester');
    await expect(author.editClass(master, 'empty', { expectedSignals: signals })).rejects.toThrow('sensor_retired');
    await expect(author.publishClass(master, 'draft')).rejects.toThrow('sensor_retired');
    await expect(author.editClass(master, 'draft', { name: 'New title' })).resolves.toMatchObject({ name: 'New title' });
  });

  it('published content survives retirement byte-for-byte, but a new version is refused', async () => {
    await capability();
    await author.createClass(master, 'published', { expectedSignals: signals });
    const published = await author.publishClass(master, 'published');
    await catalog.retireSensor(sensor.id, 'tester');
    expect(await ds.getRepository(EquipmentClassProfile).findOneByOrFail({ id: published.id })).toEqual(published);
    await expect(author.editClass(master, 'published', { name: 'Fork' })).rejects.toThrow('sensor_retired');
  });

  it('accepts a live alternative for the same role and unit, and accepts un-retirement', async () => {
    await capability();
    await catalog.retireSensor(sensor.id, 'tester');
    const other = await ds.getRepository(Sensor).save({ sensorName: 'Other', slug: 'other' });
    await ds.getRepository(SensorRoleCapability).save({ sensorId: other.id, measurementRole: 'coolant_temp_c', canonicalUnit: 'degC' });
    await expect(author.createClass(master, 'alternative', { expectedSignals: signals })).resolves.toBeDefined();
    await catalog.unretireSensor(sensor.id);
    await expect(author.createClass(master, 'restored', { expectedSignals: signals })).resolves.toBeDefined();
  });

  it('the database refuses new capability and mapping references even without the service', async () => {
    await catalog.retireSensor(sensor.id, 'tester');
    await expect(capability()).rejects.toThrow('sensor_retired');
    await expect(ds.getRepository(ToolMapping).save({ toolName: 'Invalid', mappedSensors: [{ sensorId: sensor.id, parameters: [] }] })).rejects.toThrow('sensor_retired');
  });

  it('deletes an unused sensor and returns not found on a second delete', async () => {
    await catalog.deleteSensor(sensor.id);
    expect(await ds.getRepository(Sensor).findOneBy({ id: sensor.id })).toBeNull();
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('No sensor');
  });

  it('refuses published references and capability cascade, naming both counts', async () => {
    await capability();
    await author.createClass(master, 'published', { expectedSignals: signals });
    await author.publishClass(master, 'published');
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('equipment_class_profile: 1 row(s)');
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('sensor_role_capability: 1 row(s)');
    expect(await ds.getRepository(SensorRoleCapability).count()).toBe(1);
  });

  it('counts a tenant-only reference even when the caller cannot select that tenant', async () => {
    await capability();
    await owner.query(`INSERT INTO client_equipment_class (tenant_id, slug, name, expected_signals)
      VALUES ('hidden-tenant', 'copy', 'Copy', $1::jsonb)`, [JSON.stringify(signals)]);
    expect(await ds.query('SELECT * FROM client_equipment_class')).toEqual([]);
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('client_equipment_class: 1 row(s)');
    expect(await ds.query('SELECT * FROM client_equipment_class')).toEqual([]);
  });

  it('counts JSON mapping references', async () => {
    await catalog.createToolMapping({ toolName: 'Logger', mappedSensors: [{ sensorId: sensor.id, parameters: [] }] });
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('tool_mapping: 1 row(s)');
  });

  it('counts sensor instances and bindings across tenant boundaries', async () => {
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('hidden-tenant', 'Hidden') ON CONFLICT DO NOTHING`);
    await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug)
      VALUES ('hidden-tenant', 'test', 'machine', 'generator')`);
    const [instance] = await owner.query(`INSERT INTO sensor_instance (tenant_id, source_system, external_id, sensor_id)
      VALUES ('hidden-tenant', 'test', 'machine', $1) RETURNING id`, [sensor.id]);
    await owner.query(`INSERT INTO signal_binding_version
      (tenant_id, source_system, external_id, signal_key, measurement_role, origin, imei, canonical_unit, valid_from, sensor_instance_id)
      VALUES ('hidden-tenant', 'test', 'machine', 'coolant_temp_c', 'coolant_temp_c', 'physical', '123', 'degC', now(), $1)`, [instance.id]);
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('sensor_instance: 1 row(s)');
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('signal_binding_version: 1 row(s)');
  });

  it('counts UUID references independently of their JSON letter case', async () => {
    await ds.getRepository(ToolMapping).save({ toolName: 'Uppercase', mappedSensors: [{ sensorId: sensor.id.toUpperCase(), parameters: [] }] });
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('tool_mapping: 1 row(s)');
  });

  it('counts approval provenance by slug', async () => {
    await ds.getRepository(CatalogImportBatch).save({ filename: 'x', checksumSha256: 'hash', templateVersion: '3', uploadedBy: 'tester',
      sensorDecisions: [{ kind: 'sensor', slug: sensor.slug, decision: 'approved', by: 'tester', at: new Date().toISOString() }] });
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('catalog_import_batch: 1 row(s)');
  });

  it('refuses a category containing a retired sensor and deletes an empty category', async () => {
    const cat = await catalog.createCategory('Engine');
    await catalog.updateSensor(sensor.id, { categoryId: cat.id });
    await catalog.retireSensor(sensor.id, 'tester');
    await expect(catalog.deleteCategory(cat.id)).rejects.toThrow('sensor: 1 row(s)');
    const empty = await catalog.createCategory('Empty');
    await catalog.deleteCategory(empty.id);
    expect(await ds.getRepository(SensorCategory).findOneBy({ id: empty.id })).toBeNull();
  });

  it('denies unguarded DELETE to the application role', async () => {
    await expect(ds.query('DELETE FROM sensor WHERE id = $1', [sensor.id])).rejects.toThrow('permission denied');
  });

  const waitForLock = async (pid: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (row?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The competing write never waited on a database lock');
  };

  it('a mapping write waiting behind deletion cannot leave a dangling JSON id', async () => {
    const deletion = ds.createQueryRunner();
    const writer = ds.createQueryRunner();
    await deletion.connect(); await writer.connect(); await deletion.startTransaction();
    try {
      const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');
      await deletion.query('SELECT delete_unused_sensor($1, false)', [sensor.id]);
      const outcome = writer.query('INSERT INTO tool_mapping (tool_name, mapped_sensors) VALUES ($1, $2)',
        ['Racing', JSON.stringify([{ sensorId: sensor.id, parameters: [] }])])
        .then(() => 'unexpected success', (e: Error) => e.message);
      await waitForLock(pid);
      await deletion.commitTransaction();
      expect(await outcome).toContain('sensor_reference');
      expect(await ds.getRepository(ToolMapping).count()).toBe(0);
    } finally {
      if (deletion.isTransactionActive) await deletion.rollbackTransaction();
      await deletion.release(); await writer.release();
    }
  });

  it('new class content waits for an open retirement and then refuses it', async () => {
    await capability();
    const retirement = ds.createQueryRunner();
    const writer = ds.createQueryRunner();
    await retirement.connect(); await writer.connect(); await retirement.startTransaction();
    try {
      const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');
      await retirement.query('UPDATE sensor SET retired_at = now() WHERE id = $1', [sensor.id]);
      const outcome = writer.query(`INSERT INTO equipment_class_profile (slug, version, name, expected_signals)
        VALUES ('racing', 1, 'Racing', $1)`, [JSON.stringify(signals)])
        .then(() => 'unexpected success', (e: Error) => e.message);
      await waitForLock(pid);
      await retirement.commitTransaction();
      expect(await outcome).toContain('sensor_retired');
      expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(0);
    } finally {
      if (retirement.isTransactionActive) await retirement.rollbackTransaction();
      await retirement.release(); await writer.release();
    }
  });

  it('retirement waits for a content write to commit, preserving that existing content', async () => {
    await capability();
    const writer = ds.createQueryRunner();
    const retirement = ds.createQueryRunner();
    await writer.connect(); await retirement.connect(); await writer.startTransaction();
    try {
      const [{ pid }] = await retirement.query('SELECT pg_backend_pid() AS pid');
      await writer.query(`INSERT INTO equipment_class_profile (slug, version, name, expected_signals)
        VALUES ('before-retirement', 1, 'Existing', $1)`, [JSON.stringify(signals)]);
      const outcome = retirement.query('UPDATE sensor SET retired_at = now() WHERE id = $1', [sensor.id])
        .then(() => 'retired', (e: Error) => e.message);
      await waitForLock(pid);
      await writer.commitTransaction();
      expect(await outcome).toBe('retired');
      expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(1);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release(); await retirement.release();
    }
  });

  it('deletion waits for an in-flight approval before locking its sensor', async () => {
    const batch = await ds.getRepository(CatalogImportBatch).save({ filename: 'x', checksumSha256: 'hash', templateVersion: '3', uploadedBy: 'tester' });
    const approval = ds.createQueryRunner();
    const deletion = ds.createQueryRunner();
    await approval.connect(); await deletion.connect(); await approval.startTransaction();
    try {
      await approval.query('SELECT id FROM catalog_import_batch WHERE id = $1 FOR UPDATE', [batch.id]);
      await approval.query('SELECT id FROM sensor WHERE id = $1 FOR SHARE', [sensor.id]);
      const [{ pid }] = await deletion.query('SELECT pg_backend_pid() AS pid');
      const outcome = deletion.query('SELECT delete_unused_sensor($1, false)', [sensor.id])
        .then(() => 'unexpected success', (e: Error) => e.message);
      await waitForLock(pid);
      await approval.query('UPDATE catalog_import_batch SET sensor_decisions = $2 WHERE id = $1', [batch.id, JSON.stringify([
        { kind: 'sensor', slug: sensor.slug, decision: 'approved', by: 'tester', at: new Date().toISOString() },
      ])]);
      await approval.commitTransaction();
      expect(await outcome).toContain('catalog_import_batch: 1 row(s)');
    } finally {
      if (approval.isTransactionActive) await approval.rollbackTransaction();
      await approval.release(); await deletion.release();
    }
  });

  const token = (role: 'master-admin' | 'catalog-author') => mintPlatformToken(
    { role, subject: 'tester' }, { secret: 'test-secret-for-signing', issuer: 'things-alive-platform-test' },
  ).token;

  it('HTTP deletion requires device-catalog.write and returns 204 for an unused sensor', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/device-catalog/sensors/${sensor.id}`)
      .set('Authorization', `Bearer ${token('catalog-author')}`).expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/device-catalog/sensors/${sensor.id}`)
      .set('Authorization', `Bearer ${token('master-admin')}`).expect(204);
    await request(app.getHttpServer()).delete(`/api/v1/device-catalog/sensors/${sensor.id}`)
      .set('Authorization', `Bearer ${token('master-admin')}`).expect(404);
  });

  it('HTTP authoring returns a readable 400 for a retired sensor', async () => {
    await capability();
    const retired = await catalog.retireSensor(sensor.id, 'tester');
    const response = await request(app.getHttpServer()).post('/api/v1/catalog/equipment-classes')
      .set('Authorization', `Bearer ${token('master-admin')}`)
      .send({ slug: 'http-class', expectedSignals: signals }).expect(400);
    expect(JSON.stringify(response.body)).toContain(retiredSensorProblem(retired)!.replace(/"/g, '\\"'));
  });

  it('approval provenance cannot introduce a dangling sensor slug', async () => {
    await expect(ds.getRepository(CatalogImportBatch).save({ filename: 'x', checksumSha256: 'hash', templateVersion: '3', uploadedBy: 'tester',
      sensorDecisions: [{ kind: 'sensor', slug: 'missing', decision: 'approved', by: 'tester', at: new Date().toISOString() }] }))
      .rejects.toThrow('sensor_reference');
  });

  it('migration reverts by name and reapplies over existing content', async () => {
    await capability();
    await author.createClass(master, 'existing', { expectedSignals: signals });
    await undoMigrationNamed(owner, 'SensorContentGuards1758310000000');
    expect((await owner.query("SELECT to_regprocedure('delete_unused_sensor(uuid,boolean)') AS fn"))[0].fn).toBeNull();
    await owner.runMigrations({ transaction: 'all' });
    expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(1);
    await expect(catalog.deleteSensor(sensor.id)).rejects.toThrow('sensor_referenced');
  });
});
