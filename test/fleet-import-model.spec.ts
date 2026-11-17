import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { FleetImportService } from '../src/fleet-import/fleet-import.service';
import { buildFleetTemplate, EQUIPMENT_COLUMNS, parseFleetWorkbook } from '../src/fleet-import/fleet-workbook';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const E = EQUIPMENT_COLUMNS;
type Cells = Record<string, string>;

async function workbook(rows: Cells[]): Promise<Buffer> {
  const wb = new Workbook();
  const sheet = wb.addWorksheet('Equipment');
  const titles = Object.values(EQUIPMENT_COLUMNS);
  sheet.addRow(titles);
  for (const r of rows) sheet.addRow(titles.map((c) => r[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

/**
 * The bulk upload names a machine's model (Crompton POC, 11 Nov): the machine form could,
 * the workbook could not, so a fleet uploaded in bulk got no rated figures and every rated
 * alert on it sat idle. The Model column is held to the form's own rule — a model of this
 * account, one of that name, of the row's class — and, like every other field, it only adds.
 */
describeDb('fleet import: the Model column', () => {
  let owner: DataSource;
  let ds: DataSource;
  let fleet: FleetImportService;
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  let mini: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    fleet = new FleetImportService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "equipment_model", "client_equipment_template", "client_equipment_class", "equipment_placement_event", "equipment_profile" CASCADE`);
    // The account's pump class is its copy of the library's, under its own slug.
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, template_slug) VALUES
         ('acme', 'acme-pump', 'Pump', 'monoblock-pump-1ph'), ('acme', 'acme-genset', 'Genset', 'diesel-generator')`,
    );
    [{ id: mini }] = await owner.query(
      `INSERT INTO client_equipment_template (tenant_id, name, equipment_class_slug, created_by, updated_by)
         VALUES ('acme', 'Crompton Mini 1 HP', 'monoblock-pump-1ph', 'u', 'u') RETURNING id`,
    );
  });

  const modelOf = async (code: string) => (await owner.query(
    `SELECT m.client_equipment_template_id AS id FROM equipment_model m JOIN equipment_profile p ON p.id = m.equipment_id
      WHERE p.external_id = $1`, [code],
  ))[0]?.id ?? null;

  it('the template has the column and says what it is', async () => {
    const parsed = await parseFleetWorkbook(await buildFleetTemplate());
    expect(parsed.equipment).toEqual([]);
    expect(Object.values(EQUIPMENT_COLUMNS)).toContain('Model');
  });

  it('a model of the row\'s class, matched by name in any case, is named on the machine it creates', async () => {
    const file = await workbook([{ [E.code]: 'POC-1', [E.name]: 'Pump 1', [E.classSlug]: 'acme-pump', [E.model]: 'crompton mini 1 hp' }]);
    const plan = await fleet.plan(acme, file);
    expect(plan.canApply).toBe(true);
    expect(plan.equipment.create[0]).toMatchObject({ code: 'POC-1', modelId: mini, modelName: 'Crompton Mini 1 HP' });
    await fleet.apply(acme, file);
    expect(await modelOf('POC-1')).toBe(mini);
    // The same file again: unchanged, not a conflict and not a second link.
    const again = await fleet.plan(acme, file);
    expect(again.equipment).toMatchObject({ create: [], unchanged: 1, conflicts: [] });
  });

  it('refuses an unknown model, a model of another class, and a model with no class given; nothing applies', async () => {
    const file = await workbook([
      { [E.code]: 'A', [E.name]: 'A', [E.classSlug]: 'acme-pump', [E.model]: 'No such pump' },
      { [E.code]: 'C', [E.name]: 'C', [E.classSlug]: 'acme-genset', [E.model]: 'Crompton Mini 1 HP' },
      { [E.code]: 'D', [E.name]: 'D', [E.model]: 'Crompton Mini 1 HP' },
    ]);
    const plan = await fleet.plan(acme, file);
    expect(plan.canApply).toBe(false);
    expect(plan.equipment.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(plan.equipment.errors[0].message).toMatch(/No model "No such pump" in this account/);
    expect(plan.equipment.errors[1].message).toMatch(/different machine/);
    expect(plan.equipment.errors[2].message).toMatch(/Class slug/);
    await expect(fleet.apply(acme, file)).rejects.toThrow(/row errors/);
  });

  it('a machine already in the register is not re-pointed: a different model is a conflict', async () => {
    await fleet.apply(acme, await workbook([{ [E.code]: 'POC-2', [E.name]: 'Pump 2', [E.classSlug]: 'acme-pump' }]));
    const plan = await fleet.plan(acme, await workbook([
      { [E.code]: 'POC-2', [E.name]: 'Pump 2', [E.classSlug]: 'acme-pump', [E.model]: 'Crompton Mini 1 HP' },
    ]));
    expect(plan.equipment.conflicts).toEqual([expect.objectContaining({ code: 'POC-2', fields: ['model'] })]);
    await fleet.apply(acme, await workbook([
      { [E.code]: 'POC-2', [E.name]: 'Pump 2', [E.classSlug]: 'acme-pump', [E.model]: 'Crompton Mini 1 HP' },
    ]));
    expect(await modelOf('POC-2')).toBeNull();
  });
});
