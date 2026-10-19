import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { FleetImportService } from '../src/fleet-import/fleet-import.service';
import {
  buildFleetTemplate, DEVICE_COLUMNS, EQUIPMENT_COLUMNS, FleetWorkbookRefusal, parseFleetWorkbook,
} from '../src/fleet-import/fleet-workbook';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

type Cells = Record<string, string | number | Date>;

/** A workbook the way a person fills one in: headers on row 1, a row per thing. */
async function workbook(equipment: Cells[] | null, devices: Cells[] | null, reorder = false): Promise<Buffer> {
  const wb = new Workbook();
  const add = (name: string, titles: string[], rows: Cells[]) => {
    const sheet = wb.addWorksheet(name);
    const cols = reorder ? [...titles].reverse() : titles;
    sheet.addRow(cols);
    for (const r of rows) sheet.addRow(cols.map((c) => r[c] ?? null));
  };
  if (equipment) add('Equipment', Object.values(EQUIPMENT_COLUMNS), equipment);
  if (devices) add('Devices', Object.values(DEVICE_COLUMNS), devices);
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

const E = EQUIPMENT_COLUMNS;
const D = DEVICE_COLUMNS;

/**
 * Bulk upload of equipment and devices from Excel. The workbook is read against the
 * register and only ever adds: a machine that exists differently is a conflict, a
 * logger that is not this account's is a conflict, and a row the workbook got wrong
 * refuses the whole apply. Uploading the same file twice changes nothing.
 */
describeDb('fleet import: equipment and loggers from a workbook', () => {
  let owner: DataSource;
  let ds: DataSource;
  let fleet: FleetImportService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const staff: RequestScope = { tenantId: '', userId: 'staff-1', roles: ['master-admin'], isPlatformRole: true };
  // A client-defined role that may add machines but was never given loggers.
  const builder: RequestScope = {
    tenantId: 'acme', userId: 'u-builder', roles: ['builder'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read'],
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    fleet = new FleetImportService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * Register: EX-1 exists as "Excavator 1"; OLD-1 exists, retired.
   * Sites: NORTH open, SOUTH closed.
   * Loggers: L1, L2 acme's and free; L3 acme's, fitted to EX-1; L4 globex's; L5 in stock.
   */
  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "device_inventory_event", "device_inventory", "equipment_placement_event",
        "equipment_profile", "plant" CASCADE`,
    );
    await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status) VALUES
         ('acme', 'NORTH', 'North yard', 'active'), ('acme', 'SOUTH', 'South yard', 'retired')`,
    );
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('acme', 'ta-2.0', 'EX-1', 'Excavator 1', 'client', 'active', 'basic', '{}'::jsonb),
                ('acme', 'ta-2.0', 'OLD-1', 'Old one', 'client', 'retired', 'basic', '{}'::jsonb)`,
    );
    const inv = (imei: string, tenant: string | null, state: string, machine: string | null) => owner.query(
      `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ($1, $2, $3, $4)`,
      [imei, tenant, state, machine],
    );
    await inv('L1', 'acme', 'assigned', null);
    await inv('L2', 'acme', 'assigned', null);
    await inv('L3', 'acme', 'assigned', 'EX-1');
    await inv('L4', 'globex', 'assigned', null);
    await inv('L5', null, 'in-stock', null);
  });

  const count = async (table: string) => (await owner.query(`SELECT count(*)::int AS n FROM "${table}"`))[0].n;
  const counts = async () => Promise.all(
    ['equipment_profile', 'equipment_placement_event', 'device_inventory_event'].map(count),
  );

  /** The ordinary good upload: two new machines, two loggers to fit, one already fitted. */
  const good = () => workbook(
    [
      { [E.code]: 'GEN-1', [E.name]: 'Generator 1', [E.site]: 'north', [E.commissionedAt]: '2025-03-01', [E.serviceIntervalHours]: 250 },
      { [E.code]: 'CR-7', [E.name]: 'Crane 7', [E.manufacturer]: 'Liebherr' },
      { [E.code]: 'EX-1', [E.name]: 'Excavator 1' },
    ],
    [
      { [D.imei]: 'L1', [D.equipmentCode]: 'GEN-1' },
      { [D.imei]: 'L2', [D.equipmentCode]: 'EX-1' },
      { [D.imei]: 'L3', [D.equipmentCode]: 'EX-1' },
    ],
  );

  it('plans without writing: what it would add, what is unchanged, and why each other row is not', async () => {
    const before = await counts();
    const plan = await fleet.plan(acme, await workbook(
      [
        { [E.code]: 'GEN-1', [E.name]: 'Generator 1', [E.site]: 'NORTH' },
        { [E.code]: 'EX-1', [E.name]: 'Digger' },
        { [E.code]: 'OLD-1', [E.name]: 'Old one' },
      ],
      [
        { [D.imei]: 'L1', [D.equipmentCode]: 'GEN-1' },
        { [D.imei]: 'L3', [D.equipmentCode]: 'GEN-1' },
        { [D.imei]: 'L4', [D.equipmentCode]: 'GEN-1' },
        { [D.imei]: 'L5', [D.equipmentCode]: 'GEN-1' },
      ],
    ));
    expect(plan.canApply).toBe(true);
    expect(plan.equipment.create.map((e) => [e.code, e.siteCode])).toEqual([['GEN-1', 'NORTH']]);
    expect(plan.equipment.conflicts.map((c) => [c.code, c.fields])).toEqual([['EX-1', ['name']], ['OLD-1', []]]);
    expect(plan.devices.claim.map((d) => [d.imei, d.equipmentCode])).toEqual([['L1', 'GEN-1']]);
    expect(plan.devices.conflicts.map((c) => [c.imei, c.reason])).toEqual([
      ['L3', 'claimed_to_another_machine'], ['L4', 'not_in_this_account'], ['L5', 'not_in_this_account'],
    ]);
    expect(await counts()).toEqual(before);
  });

  it('applies: machines created with their site placement, loggers fitted with their history', async () => {
    const result = await fleet.apply(acme, await good());
    expect(result.applied).toBe(true);
    expect(result.equipment.unchanged).toBe(1);
    expect(result.devices.alreadyClaimed).toBe(1);

    expect(await owner.query(
      `SELECT e.external_id, e.name, e.origin, p.code AS site, e.manufacturer,
              to_char(e.commissioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS commissioned, e.service_interval_hours
         FROM equipment_profile e LEFT JOIN plant p ON p.id = e.plant_id
        WHERE e.external_id IN ('GEN-1', 'CR-7') ORDER BY e.external_id`,
    )).toEqual([
      { external_id: 'CR-7', name: 'Crane 7', origin: 'client', site: null, manufacturer: 'Liebherr', commissioned: null, service_interval_hours: null },
      { external_id: 'GEN-1', name: 'Generator 1', origin: 'client', site: 'NORTH', manufacturer: null, commissioned: '2025-03-01', service_interval_hours: 250 },
    ]);
    expect(await owner.query(`SELECT external_id, reason FROM equipment_placement_event`))
      .toEqual([{ external_id: 'GEN-1', reason: 'fleet import' }]);
    expect(await owner.query(
      `SELECT imei, equipment_external_id, claimed_by FROM device_inventory WHERE imei IN ('L1', 'L2') ORDER BY imei`,
    )).toEqual([
      { imei: 'L1', equipment_external_id: 'GEN-1', claimed_by: 'u-acme' },
      { imei: 'L2', equipment_external_id: 'EX-1', claimed_by: 'u-acme' },
    ]);
    expect(await owner.query(`SELECT imei, action FROM device_inventory_event ORDER BY imei`))
      .toEqual([{ imei: 'L1', action: 'claim' }, { imei: 'L2', action: 'claim' }]);
  });

  it('applying the same workbook again changes nothing', async () => {
    await fleet.apply(acme, await good());
    const after = await counts();
    const again = await fleet.apply(acme, await good());
    expect(again.equipment.create).toEqual([]);
    expect(again.equipment.unchanged).toBe(3);
    expect(again.devices.claim).toEqual([]);
    expect(again.devices.alreadyClaimed).toBe(3);
    expect(await counts()).toEqual(after);
  });

  it('two applies of the same workbook at once both settle, and the work happens once', async () => {
    const file = await good();
    const results = await Promise.allSettled([fleet.apply(acme, file), fleet.apply(acme, file)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await count('equipment_profile')).toBe(4);
    expect(await count('equipment_placement_event')).toBe(1);
    expect(await count('device_inventory_event')).toBe(2);
  });

  it('a conflict is never overwritten, and the rest of the workbook still applies', async () => {
    await fleet.apply(acme, await workbook(
      [{ [E.code]: 'EX-1', [E.name]: 'Digger' }, { [E.code]: 'CR-7', [E.name]: 'Crane 7' }],
      [{ [D.imei]: 'L3', [D.equipmentCode]: 'CR-7' }, { [D.imei]: 'L4', [D.equipmentCode]: 'CR-7' }],
    ));
    expect(await owner.query(`SELECT name FROM equipment_profile WHERE external_id = 'EX-1'`)).toEqual([{ name: 'Excavator 1' }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM equipment_profile WHERE external_id = 'CR-7'`)).toEqual([{ n: 1 }]);
    expect(await owner.query(
      `SELECT imei, tenant_id, equipment_external_id FROM device_inventory WHERE imei IN ('L3', 'L4') ORDER BY imei`,
    )).toEqual([
      { imei: 'L3', tenant_id: 'acme', equipment_external_id: 'EX-1' },
      { imei: 'L4', tenant_id: 'globex', equipment_external_id: null },
    ]);
  });

  it('refuses the whole apply on any row error, and writes nothing', async () => {
    const before = await counts();
    const bad = await workbook(
      [
        { [E.code]: 'GEN-1', [E.name]: 'Generator 1' },
        { [E.code]: 'bad code!', [E.name]: 'X' },
        { [E.code]: 'S-1', [E.name]: 'South one', [E.site]: 'SOUTH' },
        { [E.code]: 'N-1', [E.name]: 'Nowhere', [E.site]: 'MARS' },
        { [E.code]: 'GEN-1', [E.name]: 'Twice' },
        { [E.code]: 'D-1', [E.name]: 'Dated', [E.commissionedAt]: 'last spring' },
        { [E.code]: 'H-1', [E.name]: 'Hours', [E.serviceIntervalHours]: -5 },
        { [E.code]: 'NN-1' },
      ],
      [
        { [D.imei]: 'L1', [D.equipmentCode]: 'GHOST' },
        { [D.imei]: 'L2', [D.equipmentCode]: 'OLD-1' },
        { [D.imei]: 'L1', [D.equipmentCode]: 'GEN-1' },
      ],
    );
    await expect(fleet.apply(acme, bad)).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toEqual(before);

    const plan = await fleet.plan(acme, bad);
    expect(plan.canApply).toBe(false);
    expect(plan.equipment.errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(plan.devices.errors.map((e) => e.row)).toEqual([2, 3, 4]);
  });

  it('a logger the account does not hold is listed, and left exactly where it is', async () => {
    await fleet.apply(acme, await workbook(null, [{ [D.imei]: 'L4', [D.equipmentCode]: 'EX-1' }]));
    expect(await owner.query(`SELECT tenant_id, equipment_external_id FROM device_inventory WHERE imei = 'L4'`))
      .toEqual([{ tenant_id: 'globex', equipment_external_id: null }]);
    expect(await count('device_inventory_event')).toBe(0);
  });

  it('a role that may add machines but not fit loggers cannot fit them through a workbook', async () => {
    const withDevices = await workbook(
      [{ [E.code]: 'GEN-1', [E.name]: 'Generator 1' }], [{ [D.imei]: 'L1', [D.equipmentCode]: 'GEN-1' }],
    );
    await expect(fleet.apply(builder, withDevices)).rejects.toMatchObject({ status: 403 });
    expect(await owner.query(`SELECT equipment_external_id FROM device_inventory WHERE imei = 'L1'`))
      .toEqual([{ equipment_external_id: null }]);
    // The same role, machines only, is fine.
    await fleet.apply(builder, await workbook([{ [E.code]: 'GEN-1', [E.name]: 'Generator 1' }], null));
    expect(await count('equipment_profile')).toBe(3);
  });

  it('a client cannot import into another account; staff must name the account they import into', async () => {
    const file = await good();
    await expect(fleet.apply(acme, file, 'globex')).rejects.toMatchObject({ status: 403 });
    await expect(fleet.apply(staff, file)).rejects.toMatchObject({ status: 400 });
    await fleet.apply(staff, file, 'acme');
    expect(await owner.query(`SELECT created_by FROM equipment_profile WHERE external_id = 'GEN-1'`))
      .toEqual([{ created_by: 'staff-1' }]);
  });

  it('reads columns by header, not by position', async () => {
    const reordered = await workbook(
      [{ [E.code]: 'GEN-1', [E.name]: 'Generator 1', [E.serialNumber]: 'SN-9' }],
      [{ [D.imei]: 'L1', [D.equipmentCode]: 'GEN-1' }], true,
    );
    const plan = await fleet.plan(acme, reordered);
    expect(plan.equipment.create.map((e) => [e.code, e.name, e.serialNumber])).toEqual([['GEN-1', 'Generator 1', 'SN-9']]);
    expect(plan.devices.claim.map((d) => d.imei)).toEqual(['L1']);
  });
});

describe('fleet workbook: the file itself', () => {
  it('the template parses as an empty upload', async () => {
    expect(await parseFleetWorkbook(await buildFleetTemplate())).toEqual({ equipment: [], devices: [] });
  });

  it('refuses a file that is not a workbook, one without either sheet, and a sheet missing a required column', async () => {
    await expect(parseFleetWorkbook(Buffer.from('not excel'))).rejects.toBeInstanceOf(FleetWorkbookRefusal);

    const other = new Workbook();
    other.addWorksheet('Sheet1').addRow(['Code', 'Name']);
    await expect(parseFleetWorkbook(Buffer.from(await other.xlsx.writeBuffer() as ArrayBuffer)))
      .rejects.toThrow(/neither an "Equipment" nor a "Devices" sheet/);

    const noName = new Workbook();
    noName.addWorksheet('Equipment').addRow(['Code']);
    await expect(parseFleetWorkbook(Buffer.from(await noName.xlsx.writeBuffer() as ArrayBuffer)))
      .rejects.toThrow(/no "Name" column/);
  });

  it('refuses more than 500 rows on a sheet', async () => {
    const big = new Workbook();
    const sheet = big.addWorksheet('Devices');
    sheet.addRow(['IMEI', 'Equipment code']);
    for (let i = 0; i < 501; i++) sheet.addRow([`IMEI-${i}`, 'GEN-1']);
    await expect(parseFleetWorkbook(Buffer.from(await big.xlsx.writeBuffer() as ArrayBuffer)))
      .rejects.toThrow(/501 rows/);
  });
});
