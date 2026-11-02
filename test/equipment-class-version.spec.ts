import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { FleetImportService } from '../src/fleet-import/fleet-import.service';
import { EQUIPMENT_COLUMNS } from '../src/fleet-import/fleet-workbook';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'EquipmentClassVersionBackfill1762500000000';

/**
 * A machine classified through the register gets the class version its account holds.
 *
 * Every pass that reads the catalog — forecasts, recommendations, OEE, workflows —
 * looks it up by (class slug, class version) and reads a null version as "nothing
 * declared". Machines created by hand, by the assistant or by a workbook were saved
 * with the slug and no version, so they showed their class on the page and were never
 * forecast. Nothing failed; the pass simply had nothing to do for them.
 */
describeDb('equipment class version', () => {
  let owner: DataSource;
  let ds: DataSource;
  let equipment: EquipmentService;
  let fleet: FleetImportService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    equipment = new EquipmentService(ds);
    fleet = new FleetImportService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * acme holds hydraulic-excavator forked from v3 (the library has since moved on),
   * prime-diesel-generator from v1, and my-loader — renamed away from wheel-loader.
   * globex holds hydraulic-excavator from v5, which must not leak into acme.
   */
  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "equipment_placement_event", "equipment_profile", "client_equipment_class" CASCADE`,
    );
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, template_slug, template_version) VALUES
         ('acme', 'hydraulic-excavator', 'Excavator', 'hydraulic-excavator', 3),
         ('acme', 'prime-diesel-generator', 'Generator', 'prime-diesel-generator', 1),
         ('acme', 'my-loader', 'Our loader', 'wheel-loader', 2),
         ('globex', 'hydraulic-excavator', 'Excavator', 'hydraulic-excavator', 5)`,
    );
  });

  const versionOf = async (code: string) =>
    (await owner.getRepository(EquipmentProfile).findOneByOrFail({ tenantId: 'acme', externalId: code })).classVersion;

  it('pins a machine created by hand to the version its account forked', async () => {
    const created = await equipment.create(acme, { code: 'EX-1', name: 'Excavator 1', equipmentClassSlug: 'hydraulic-excavator' });
    // 3, not globex's 5 and not whatever the library publishes next: the account
    // takes a newer template when it chooses to.
    expect(created.classVersion).toBe(3);
    expect(await versionOf('EX-1')).toBe(3);
  });

  it('leaves the version empty when the account does not hold the class', async () => {
    await equipment.create(acme, { code: 'EX-2', name: 'Excavator 2', equipmentClassSlug: 'excavator' });
    await equipment.create(acme, { code: 'EX-3', name: 'Excavator 3' });
    expect(await versionOf('EX-2')).toBeNull();
    expect(await versionOf('EX-3')).toBeNull();
  });

  it('leaves it empty for a class renamed away from its template', async () => {
    // The library has no "my-loader"; pinning it to wheel-loader's version would pair
    // a slug and a version that name nothing together.
    await equipment.create(acme, { code: 'WL-1', name: 'Loader 1', equipmentClassSlug: 'my-loader' });
    expect(await versionOf('WL-1')).toBeNull();
  });

  it('re-pins when the class changes, and clears it when the class is removed', async () => {
    await equipment.create(acme, { code: 'M-1', name: 'Machine 1', equipmentClassSlug: 'hydraulic-excavator' });

    await equipment.update(acme, { sourceSystem: 'ta-2.0', externalId: 'M-1' }, { equipmentClassSlug: 'prime-diesel-generator' });
    expect(await versionOf('M-1')).toBe(1);

    await equipment.update(acme, { sourceSystem: 'ta-2.0', externalId: 'M-1' }, { equipmentClassSlug: null });
    expect(await versionOf('M-1')).toBeNull();
  });

  it('classifies a machine created unclassified once it is given a class', async () => {
    await equipment.create(acme, { code: 'M-2', name: 'Machine 2' });
    await equipment.update(acme, { sourceSystem: 'ta-2.0', externalId: 'M-2' }, { equipmentClassSlug: 'hydraulic-excavator' });
    expect(await versionOf('M-2')).toBe(3);
  });

  it('does not move the version on an edit that leaves the class alone', async () => {
    await equipment.create(acme, { code: 'M-3', name: 'Machine 3', equipmentClassSlug: 'hydraulic-excavator' });
    // The account takes a newer template; the machine stays where it was until
    // somebody reclassifies it, not the next time somebody corrects its name.
    await owner.query(`UPDATE client_equipment_class SET template_version = 4 WHERE tenant_id = 'acme' AND slug = 'hydraulic-excavator'`);

    await equipment.update(acme, { sourceSystem: 'ta-2.0', externalId: 'M-3' }, { name: 'Machine three' });
    await equipment.update(acme, { sourceSystem: 'ta-2.0', externalId: 'M-3' }, { equipmentClassSlug: 'hydraulic-excavator' });
    expect(await versionOf('M-3')).toBe(3);
  });

  it('pins machines that arrive in a fleet workbook', async () => {
    const wb = new Workbook();
    const sheet = wb.addWorksheet('Equipment');
    sheet.addRow([EQUIPMENT_COLUMNS.code, EQUIPMENT_COLUMNS.name, EQUIPMENT_COLUMNS.classSlug]);
    sheet.addRow(['EX-10', 'Excavator 10', 'hydraulic-excavator']);
    sheet.addRow(['DG-10', 'Generator 10', 'prime-diesel-generator']);
    sheet.addRow(['XX-10', 'Unknown 10', 'excavator']);

    await fleet.apply(acme, Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));

    expect(await versionOf('EX-10')).toBe(3);
    expect(await versionOf('DG-10')).toBe(1);
    expect(await versionOf('XX-10')).toBeNull();
  });

  it(`${MIGRATION} mends machines saved before the fix, by the same rule`, async () => {
    await undoMigrationNamed(owner, MIGRATION);

    // What the old create path left behind, plus one machine pinned by hand that the
    // backfill must not move even though its account has since forked a newer copy.
    const profile = (tenant: string, code: string, slug: string | null, version: number | null) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness,
         equipment_class_slug, class_version)
       VALUES ($1, 'ta-2.0', $2, $2, 'client', 'active', 'basic', '{}'::jsonb, $3, $4)`,
      [tenant, code, slug, version],
    );
    await profile('acme', 'OLD-EX', 'hydraulic-excavator', null);
    await profile('acme', 'OLD-DG', 'prime-diesel-generator', null);
    await profile('acme', 'OLD-XX', 'excavator', null);
    await profile('acme', 'OLD-WL', 'my-loader', null);
    await profile('acme', 'OLD-NONE', null, null);
    await profile('acme', 'PINNED', 'hydraulic-excavator', 2);
    await profile('globex', 'OLD-EX', 'hydraulic-excavator', null);

    await owner.runMigrations({ transaction: 'all' });

    expect(await versionOf('OLD-EX')).toBe(3);
    expect(await versionOf('OLD-DG')).toBe(1);
    expect(await versionOf('OLD-XX')).toBeNull();
    expect(await versionOf('OLD-WL')).toBeNull();
    expect(await versionOf('OLD-NONE')).toBeNull();
    expect(await versionOf('PINNED')).toBe(2);
    // Each machine reads its own account's copy, never the other account's.
    const [globex] = await owner.query(
      `SELECT class_version FROM equipment_profile WHERE tenant_id = 'globex' AND external_id = 'OLD-EX'`);
    expect(globex.class_version).toBe(5);

    // Down keeps what it filled: the null was the defect, and putting it back would
    // stop these machines being forecast again.
    await undoMigrationNamed(owner, MIGRATION);
    expect(await versionOf('OLD-EX')).toBe(3);
    await owner.runMigrations({ transaction: 'all' });
  });
});
