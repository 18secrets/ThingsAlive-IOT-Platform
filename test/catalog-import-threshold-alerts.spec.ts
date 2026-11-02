import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

// Parse, validate and apply, sometimes twice, in one test: the default 5 s is tight.
jest.setTimeout(30_000);

const CLASS_SLUG = 'diesel-generator';
const TEMPLATE_SLUG = 'diesel-generator-coolant-temp-c-limit';

/**
 * A signal row's limits become a draft alert template (tester bug TC_116). The
 * workbook's min/max used to be stored on the class and read by nothing, so an import
 * full of limits produced no alerts at all.
 */
describeDb('catalog import: signal limits draft alert templates', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "alert_rule_template",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    await ds.getRepository(Sensor).save(
      ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' }),
    );
  });

  /** The template workbook — coolant_temp_c, max 105, critical — edited as asked. */
  const upload = async (edit?: { className?: string; signal?: Record<string, string | number> }): Promise<string> => {
    const wb = new Workbook();
    // Same exceljs/@types-node Buffer mismatch worked around throughout catalog import.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(await templates.build(new Date('2026-10-24T00:00:00.000Z')) as any);
    const columnsOf = (sheet: string) => ALL_SHEETS.find((s) => s.sheet === sheet)!.columns.map((c) => c.name);
    if (edit?.className) {
      const cols = columnsOf('equipment_class');
      wb.getWorksheet('equipment_class')!.getRow(2).getCell(cols.indexOf('name') + 1).value = edit.className;
    }
    for (const [column, value] of Object.entries(edit?.signal ?? {})) {
      const cols = columnsOf('signal');
      wb.getWorksheet('signal')!.getRow(2).getCell(cols.indexOf(column) + 1).value = value;
    }
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const parsed = await parser.parse(buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };

  const drafts = () => ds.getRepository(AlertRuleTemplate).find({ where: { equipmentClassSlug: CLASS_SLUG } });

  it('a limit on a signal row becomes a draft signal-threshold template, with the row\'s severity', async () => {
    const summary = await applier.apply(await upload(), 'deepak');

    expect(summary.classes[CLASS_SLUG].draftedAlertTemplates).toBe(1);
    const [t] = await drafts();
    expect(t).toMatchObject({
      slug: TEMPLATE_SLUG, version: 1, status: 'draft', publishedAt: null, trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105 }, severity: 'critical', name: 'coolant_temp_c above 105 degC',
      createdBy: 'deepak',
    });
  });

  it('re-uploading neither duplicates the draft nor overwrites an author\'s edit of it', async () => {
    await applier.apply(await upload(), 'deepak');
    await ds.getRepository(AlertRuleTemplate).update({ slug: TEMPLATE_SLUG }, { name: 'Coolant too hot (edited)' });

    const summary = await applier.apply(await upload({ className: 'Generator, revised' }), 'deepak');

    expect(summary.classes[CLASS_SLUG].draftedAlertTemplates).toBeUndefined();
    expect((await drafts()).map((t) => t.name)).toEqual(['Coolant too hot (edited)']);
  });

  it('both bounds read as one rule, low and high', async () => {
    await applier.apply(await upload({ signal: { min: 60 } }), 'deepak');

    const [t] = await drafts();
    expect(t.params).toEqual({ signal: 'coolant_temp_c', min: 60, max: 105 });
    expect(t.name).toBe('coolant_temp_c below 60 degC or above 105 degC');
  });

  it('a signal row with no limit drafts nothing', async () => {
    const summary = await applier.apply(await upload({ signal: { max: '', severity: '' } }), 'deepak');

    expect(summary.classes[CLASS_SLUG].draftedAlertTemplates).toBeUndefined();
    expect(await drafts()).toEqual([]);
  });
});
