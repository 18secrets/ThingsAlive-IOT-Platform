import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceInventory } from '../src/inventory/entities/device-inventory.entity';
import { InventoryService } from '../src/inventory/services/inventory.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ImeiCorrection1764500000000';

/**
 * A mistyped IMEI can be put right (testing sheet TC_152) — but only on a device that
 * has never been anywhere. Once it has moved or been bound, readings and bindings name
 * that IMEI, and the database refuses the change whatever the service is asked.
 */
describeDb('correcting a device IMEI', () => {
  let owner: DataSource;
  let ds: DataSource;
  let inventory: InventoryService;
  const master: RequestScope = { tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    inventory = new InventoryService(ds, new DeviceCatalogService(
      ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping),
    ));
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM "device_inventory_event"; DELETE FROM "device_inventory"`);
    await inventory.register(master, [{ imei: '35000000000001X', model: 'TA-200' }, { imei: '350000000000002' }]);
  });

  const imeis = async () => (await owner.getRepository(DeviceInventory).find()).map((d) => d.imei).sort();

  it('corrects a device still on the shelf, and its history follows it to the new number', async () => {
    const saved = await inventory.updateDevice(master, '35000000000001X', { imei: ' 350000000000001 ' });
    expect(saved.imei).toBe('350000000000001');
    expect(await imeis()).toEqual(['350000000000001', '350000000000002']);
    const history = await inventory.historyFor(master, '350000000000001');
    expect(history.map((e) => [e.action, e.imei])).toEqual([
      ['register', '35000000000001X'],
      ['correct-imei', '350000000000001'],
    ]);
    expect(history[1]).toMatchObject({ previousImei: '35000000000001X', reason: 'IMEI corrected from 35000000000001X' });
  });

  it('refuses an IMEI another device already has, and a blank one', async () => {
    await expect(inventory.updateDevice(master, '35000000000001X', { imei: '350000000000002' }))
      .rejects.toThrow(/already in the inventory/);
    await expect(inventory.updateDevice(master, '35000000000001X', { imei: '  ' })).rejects.toThrow(BadRequestException);
    expect(await imeis()).toEqual(['350000000000002', '35000000000001X']);
  });

  it('refuses a device that is with a client', async () => {
    await inventory.assign(master, ['35000000000001X'], 'acme');
    await expect(inventory.updateDevice(master, '35000000000001X', { imei: '350000000000001' }))
      .rejects.toThrow(/assigned to a client/);
  });

  it('the database refuses a device that has been out and come back, though it looks like stock again', async () => {
    // Released back to stock it passes the service's own check — in stock, nobody's —
    // so this is the database's refusal: its history says it has been somewhere.
    await inventory.assign(master, ['35000000000001X'], 'acme');
    await inventory.release(master, ['35000000000001X'], 'returned unused');
    await expect(inventory.updateDevice(master, '35000000000001X', { imei: '350000000000001' }))
      .rejects.toThrow(/its IMEI is fixed/);
    // And not through the service either: the application's own role, straight at the row.
    await expect(runTenantSpanning(ds, 'test', (m) =>
      m.query(`UPDATE device_inventory SET imei = '350000000000001' WHERE imei = '35000000000001X'`)))
      .rejects.toThrow(/its IMEI is fixed/);
    expect(await imeis()).toEqual(['350000000000002', '35000000000001X']);
  });

  it('a correction racing an assign: one wins, never both', async () => {
    const [correct, assign] = await Promise.allSettled([
      inventory.updateDevice(master, '35000000000001X', { imei: '350000000000001' }),
      inventory.assign(master, ['35000000000001X'], 'acme'),
    ]);
    const devices = await owner.getRepository(DeviceInventory).find();
    const device = devices.find((d) => d.imei !== '350000000000002')!;
    if (correct.status === 'fulfilled') {
      // Corrected first: the assign no longer finds the old number, so nothing went to acme.
      expect(device).toMatchObject({ imei: '350000000000001', tenantId: null, state: 'in-stock' });
    } else {
      expect(assign.status).toBe('fulfilled');
      expect(device).toMatchObject({ imei: '35000000000001X', tenantId: 'acme', state: 'assigned' });
    }
  });

  it(`${MIGRATION} comes off and goes back on`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const cols = await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'device_inventory_event' AND column_name = 'previous_imei'`);
    expect(cols).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_imei_correction'`)).toHaveLength(1);
  });
});
