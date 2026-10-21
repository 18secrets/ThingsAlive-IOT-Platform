import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { InventoryService } from '../src/inventory/services/inventory.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Three edits the tester found missing (2026-10-15): renaming a sensor category
 * (TC_064), offering a retired equipment class again (TC_046), and correcting a
 * device's details after registration (TC_028). Every call runs as `ta_app`, the role
 * the service uses — a test run as the owner would pass on privileges the running
 * service does not have, which is how the Signal States save went unnoticed.
 */
describeDb('tester gaps: category rename, class unretire, device edit', () => {
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;
  let authoring: CatalogAuthoringService;
  let inventory: InventoryService;

  const master: RequestScope = { tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const client: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(
      ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping),
    );
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    inventory = new InventoryService(ds, catalog);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "device_inventory_event", "device_inventory", "tool_mapping", "sensor",
        "sensor_category", "equipment_class_profile" RESTART IDENTITY CASCADE`,
    );
  });

  // ------------------------------------------------------------------ TC_064
  describe('renaming a sensor category', () => {
    it('renames it, and a sensor filed under it keeps it — sensors hold the category by id', async () => {
      const engine = await catalog.createCategory('Engin');
      const sensor = await catalog.createSensor({ sensorName: 'Oil probe', categoryId: engine.id, parameterSpecs: [] });
      const renamed = await catalog.renameCategory(engine.id, '  Engine  ');
      expect(renamed.name).toBe('Engine');
      expect((await ds.getRepository(Sensor).findOneByOrFail({ id: sensor.id })).categoryId).toBe(engine.id);
    });

    it('the database refuses a name another category already has, and the API says which', async () => {
      await catalog.createCategory('Hydraulics');
      const fuel = await catalog.createCategory('Fuel');
      await expect(catalog.renameCategory(fuel.id, 'Hydraulics')).rejects.toThrow(ConflictException);
      expect((await ds.getRepository(SensorCategory).findOneByOrFail({ id: fuel.id })).name).toBe('Fuel');
    });
  });

  // ------------------------------------------------------------------ TC_046
  describe('un-retiring an equipment class', () => {
    const classRow = (slug: string, version: number, status: 'draft' | 'published' | 'retired') => ({
      slug, version, status, name: `${slug} v${version}`, description: null, category: 'power',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, publishedAt: new Date('2026-10-01'),
    });
    const statuses = async (slug: string) => (await ds.getRepository(EquipmentClassProfile)
      .find({ where: { slug }, order: { version: 'ASC' } })).map((r) => `v${r.version}:${r.status}`);

    it('publishes the newest retired version again, and only that one', async () => {
      // v1 was superseded by v2's publish; v2 was then retired as a whole.
      await owner.getRepository(EquipmentClassProfile).save([
        classRow('genset', 1, 'retired'), classRow('genset', 2, 'retired'),
      ] as any);
      const back = await authoring.unretireClass(master, 'genset');
      expect(back.version).toBe(2);
      expect(await statuses('genset')).toEqual(['v1:retired', 'v2:published']);
    });

    it('refuses while a version is published — that class was never retired as a whole', async () => {
      // v1 retired only because v2 superseded it; reviving it would leave two published.
      await owner.getRepository(EquipmentClassProfile).save([
        classRow('genset', 1, 'retired'), classRow('genset', 2, 'published'),
      ] as any);
      await expect(authoring.unretireClass(master, 'genset')).rejects.toThrow(/v2 is published/);
      expect(await statuses('genset')).toEqual(['v1:retired', 'v2:published']);
    });

    it('refuses a class that was never published, and one that does not exist', async () => {
      await owner.getRepository(EquipmentClassProfile).save([classRow('fresh', 1, 'draft')] as any);
      await expect(authoring.unretireClass(master, 'fresh')).rejects.toThrow(BadRequestException);
      await expect(authoring.unretireClass(master, 'nope')).rejects.toThrow(/No template/);
    });

    it('a draft opened on the retired class is left a draft', async () => {
      await owner.getRepository(EquipmentClassProfile).save([
        classRow('genset', 1, 'retired'), classRow('genset', 2, 'draft'),
      ] as any);
      await authoring.unretireClass(master, 'genset');
      expect(await statuses('genset')).toEqual(['v1:published', 'v2:draft']);
    });
  });

  // ------------------------------------------------------------------ TC_028
  describe('editing a device in the pool', () => {
    const IMEI = '861000000000777';
    const mappingId = async (name: string) => (await catalog.createToolMapping({ toolName: name, mappedSensors: [] })).id;

    it('corrects model, notes and tool profile while in stock, and writes no custody event', async () => {
      const kit = await mappingId('Excavator kit');
      await inventory.register(master, [{ imei: IMEI, model: 'FMB12O', toolMappingId: null, batchRef: null, receivedAt: null, notes: null }]);
      const before = Number((await owner.query(`SELECT count(*) AS n FROM device_inventory_event`))[0].n);
      const updated = await inventory.updateDevice(master, IMEI, { model: 'FMB120', notes: ' recounted ', toolMappingId: kit });
      expect(updated).toMatchObject({ model: 'FMB120', notes: 'recounted', toolMappingId: kit, state: 'in-stock' });
      expect(Number((await owner.query(`SELECT count(*) AS n FROM device_inventory_event`))[0].n)).toBe(before);
    });

    it('a field left out is kept; an empty one is cleared', async () => {
      await inventory.register(master, [{ imei: IMEI, model: 'FMB120', toolMappingId: null, batchRef: 'DN-7', receivedAt: null, notes: 'n' }]);
      const updated = await inventory.updateDevice(master, IMEI, { notes: '' });
      expect(updated).toMatchObject({ model: 'FMB120', batchRef: 'DN-7', notes: null });
    });

    it('refuses a tool-profile change once the device is with a client', async () => {
      const kit = await mappingId('Excavator kit');
      await inventory.register(master, [{ imei: IMEI, model: null, toolMappingId: null, batchRef: null, receivedAt: null, notes: null }]);
      await inventory.assign(master, [IMEI], 'acme');
      await expect(inventory.updateDevice(master, IMEI, { toolMappingId: kit })).rejects.toThrow(/only change while it is in stock/);
      // The descriptive fields stay editable.
      await expect(inventory.updateDevice(master, IMEI, { notes: 'with acme' })).resolves.toMatchObject({ notes: 'with acme' });
    });

    it('the database refuses a tool mapping that does not exist', async () => {
      await inventory.register(master, [{ imei: IMEI, model: null, toolMappingId: null, batchRef: null, receivedAt: null, notes: null }]);
      await expect(inventory.updateDevice(master, IMEI, { toolMappingId: '00000000-0000-4000-8000-000000000000' }))
        .rejects.toThrow(/No tool mapping/);
    });

    it('a client cannot edit pool devices, and an unknown IMEI is a 404', async () => {
      await expect(inventory.updateDevice(client, IMEI, { notes: 'x' })).rejects.toThrow(ForbiddenException);
      await expect(inventory.updateDevice(master, '000', { notes: 'x' })).rejects.toThrow(/No device/);
    });
  });
});
