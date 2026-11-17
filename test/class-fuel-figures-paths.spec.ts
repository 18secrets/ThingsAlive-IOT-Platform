import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { readFuelFigures, writeFuelFigures } from '../src/catalog/services/class-fuel-figures';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The two ways a class's cold-start fuel figures arrive (fuel test report FU-3/FU-5): the
 * library workbook, and a draft forked from a published version. The figures are not on
 * the entity's ordinary reads and writes (`class-fuel-figures.ts` says why), so each path
 * has to carry them explicitly — these hold it to doing so.
 */
describeDb('class fuel figures reach the library by the import and survive a fork', () => {
  let owner: DataSource;
  let ds: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;
  const master: RequestScope = { tenantId: 'platform', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(() => owner.query(
    `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "equipment_class_recommendation",
      "equipment_class_failure_mode", "equipment_class_formula", "equipment_class_sensor_requirement",
      "equipment_class_profile", "sensor" RESTART IDENTITY CASCADE`,
  ));

  const workbook = async (figures: Record<string, unknown>) => {
    const wb = new Workbook();
    await wb.xlsx.load((await templates.build(new Date('2026-11-04T00:00:00Z'))) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    wb.removeWorksheet(wb.getWorksheet('sensor_capability')!.id);
    const schema = ALL_SHEETS.find((s) => s.sheet === 'equipment_class')!;
    for (const [column, value] of Object.entries(figures)) {
      const index = schema.columns.findIndex((c) => c.name === column);
      expect(index).toBeGreaterThanOrEqual(0);
      wb.getWorksheet('equipment_class')!.getRow(2).getCell(index + 1).value = value as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };
  const importOf = async (figures: Record<string, unknown>) => {
    const parsed = await parser.parse(await workbook(figures), 'library.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };
  const FIGURES = {
    nominal_fuel_per_hour: 18, nominal_fuel_unit: 'L/h', nominal_fuel_source: 'Genset datasheet DG-250, p. 4',
    rated_power_kw: 200, working_load_pct: 70, bsfc_g_per_kwh: 210, bsfc_source: 'Engine performance curve, p. 2',
    idle_fuel_per_hour: 3, working_share: 0.8,
  };

  it('a workbook with every fuel figure applies, and the class version carries each', async () => {
    const batchId = await importOf(FIGURES);
    const row = (await ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'equipment_class' } }))[0];
    expect(row.status).toBe('valid');
    await applier.apply(batchId, 'deepak');
    const v = await owner.getRepository(EquipmentClassProfile).findOneOrFail({ where: { slug: 'diesel-generator' }, order: { version: 'DESC' } });
    expect(await readFuelFigures(owner.manager, 'diesel-generator', v.version)).toEqual({
      nominalFuelSource: 'Genset datasheet DG-250, p. 4', ratedPowerKw: 200, workingLoadPct: 70, bsfcGPerKwh: 210,
      bsfcSource: 'Engine performance curve, p. 2', idleFuelPerHour: 3, workingShare: 0.8,
    });
  });

  it('a BSFC with no datasheet is refused at validation, naming the row, and nothing is applied', async () => {
    const batchId = await importOf({ ...FIGURES, bsfc_source: '' });
    const row = (await ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'equipment_class' } }))[0];
    expect(row.status).toBe('invalid');
    expect(JSON.stringify(row)).toContain('bsfc_g_per_kwh has no bsfc_source');
  });

  it('a draft forked from a published version keeps that version\'s fuel figures', async () => {
    const v1 = await owner.getRepository(EquipmentClassProfile).save({
      slug: 'hydraulic-excavator', version: 1, name: 'Hydraulic Excavator', status: 'published', publishedAt: new Date(),
      expectedSignals: [{ signal: 'fuel_level', unit: '%', required: true }],
      nominalFuelPerHour: 15, nominalFuelUnit: 'L/h',
    });
    await writeFuelFigures(owner.manager, v1.id, {
      nominalFuelSource: 'Cat 320 spec sheet', idleFuelPerHour: 2.1, workingShare: 0.7,
    });
    const authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula), ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias), ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    const draft = await authoring.editClass(master, 'hydraulic-excavator', { description: 'Edited' } as never);
    expect(draft.version).toBe(2);
    expect(await readFuelFigures(owner.manager, 'hydraulic-excavator', 2)).toMatchObject({
      nominalFuelSource: 'Cat 320 spec sheet', idleFuelPerHour: 2.1, workingShare: 0.7,
    });
  });
});
