import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { InventoryService } from '../src/inventory/services/inventory.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'DeviceModemImei1766400000000';
const MODEM = '862360079349887';
/** The same number with its check digit wrong: the typo this column exists to refuse. */
const MISTYPED = '862360079349888';
const OTHER_MODEM = '490154203237518';

jest.setTimeout(60_000);

/**
 * A motor logger names itself in firmware (`MOTOR_001`) and its uploads are matched on that
 * name, so the modem's real IMEI is kept beside it rather than in place of it. These tests
 * prove the label can be set on a logger already fitted and reporting, that the name it is
 * matched on does not move, and that the database — not the service — refuses a bad number.
 */
describeDb('modem IMEI on a device', () => {
  const TENANT = 'motors';
  let owner: DataSource;
  let ds: DataSource;
  let inventory: InventoryService;

  const master: RequestScope = {
    tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true,
  };
  const client: RequestScope = {
    tenantId: TENANT, userId: 'u-motors', roles: ['super admin'], isPlatformRole: false,
  };

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
    await owner.query(`DELETE FROM device_inventory_event`);
    await owner.query(`DELETE FROM device_inventory`);
    // Fitted and reporting, as MOTOR_001 is on POC-MINI-01: the state in which the
    // device's own identifier is fixed, and the one this label has to work in.
    await owner.query(
      `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at)
       VALUES ('MOTOR_001', $1, 'assigned', 'POC-MINI-01', now()), ('MOTOR_002', $1, 'assigned', NULL, NULL)`,
      [TENANT]);
  });

  it('records the modem IMEI on a fitted logger, and the name its uploads match stays MOTOR_001', async () => {
    const saved = await inventory.updateDevice(master, 'MOTOR_001', { modemImei: ` ${MODEM} ` });
    expect(saved.imei).toBe('MOTOR_001');
    expect(saved.modemImei).toBe(MODEM);
    expect(saved.equipmentExternalId).toBe('POC-MINI-01');

    // The account sees it on its own device list.
    const mine = await inventory.mine(client);
    expect(mine.find((d) => d.imei === 'MOTOR_001')?.modemImei).toBe(MODEM);
  });

  it('a null clears it, and a patch that leaves it out keeps it', async () => {
    await inventory.updateDevice(master, 'MOTOR_001', { modemImei: MODEM });
    await inventory.updateDevice(master, 'MOTOR_001', { notes: 'bench unit' });
    expect((await inventory.updateDevice(master, 'MOTOR_001', {})).modemImei).toBe(MODEM);
    expect((await inventory.updateDevice(master, 'MOTOR_001', { modemImei: null })).modemImei).toBeNull();
  });

  it('refuses a number whose check digit is wrong, or that is not fifteen digits', async () => {
    await expect(inventory.updateDevice(master, 'MOTOR_001', { modemImei: MISTYPED }))
      .rejects.toThrow(/not a valid IMEI/);
    await expect(inventory.updateDevice(master, 'MOTOR_001', { modemImei: '86236007934988' }))
      .rejects.toThrow(BadRequestException);
    await expect(inventory.updateDevice(master, 'MOTOR_001', { modemImei: '86236007934988a' }))
      .rejects.toThrow(BadRequestException);
  });

  it('the database itself refuses a mistyped modem IMEI, whoever writes it', async () => {
    await expect(owner.query(`UPDATE device_inventory SET modem_imei = $1 WHERE imei = 'MOTOR_001'`, [MISTYPED]))
      .rejects.toThrow(/ck_device_inventory_modem_imei/);
    // And accepts real ones, so the rule is the check digit and not a blanket refusal.
    await owner.query(`UPDATE device_inventory SET modem_imei = $1 WHERE imei = 'MOTOR_001'`, [OTHER_MODEM]);
  });

  it('refuses one modem on two devices', async () => {
    await inventory.updateDevice(master, 'MOTOR_001', { modemImei: MODEM });
    await expect(inventory.updateDevice(master, 'MOTOR_002', { modemImei: MODEM }))
      .rejects.toThrow(/already recorded on another device/);
  });

  it('two devices claiming one modem at once: exactly one wins', async () => {
    // A service-side "is it taken?" lookup would let both through; the unique index does not.
    const results = await Promise.allSettled([
      inventory.updateDevice(master, 'MOTOR_001', { modemImei: MODEM }),
      inventory.updateDevice(master, 'MOTOR_002', { modemImei: MODEM }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM device_inventory WHERE modem_imei = $1`, [MODEM]);
    expect(n).toBe(1);
  });

  it('setting the same modem IMEI twice at once settles both, once', async () => {
    const results = await Promise.allSettled([
      inventory.updateDevice(master, 'MOTOR_001', { modemImei: MODEM }),
      inventory.updateDevice(master, 'MOTOR_001', { modemImei: MODEM }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await owner.query(`SELECT imei FROM device_inventory WHERE modem_imei = $1`, [MODEM]);
    expect(rows).toEqual([{ imei: 'MOTOR_001' }]);
  });

  it('only Things Alive sets it', async () => {
    await expect(inventory.updateDevice(client, 'MOTOR_001', { modemImei: MODEM }))
      .rejects.toThrow(/Only Things Alive/);
  });

  it('down drops the column, its rules and the check function', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ col }] = await owner.query(
      `SELECT count(*)::int AS col FROM information_schema.columns
        WHERE table_name = 'device_inventory' AND column_name = 'modem_imei'`);
    const [{ fn }] = await owner.query(`SELECT count(*)::int AS fn FROM pg_proc WHERE proname = 'imei_check_digit_ok'`);
    expect({ col, fn }).toEqual({ col: 0, fn: 0 });
    // Back up, so a later spec on this database finds the schema it expects.
    await owner.runMigrations({ transaction: 'all' });
  });
});
