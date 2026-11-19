import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

jest.setTimeout(30_000);

const ALERT = 'diesel-generator-coolant-drift-alert';
const EXAMPLE_ACTION = 'Check the coolant level and clean the radiator fins before the next shift.';

/**
 * The `recommended_action` column on the `alert_rule` sheet (D62).
 *
 * The action is what Vani tells a customer to do, so the import is how the library gets
 * one at scale rather than template by template. Each case uploads a real workbook —
 * the template's own, edited — and reads what landed. A workbook from before the column
 * existed must still import and mean "no action", because an optional column asks
 * nothing of a workbook that predates it.
 */
describeDb('catalog import: an alert rule\'s recommended action', () => {
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
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "alert_rule_template", "scenario_definition",
        "causal_chain", "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    await ds.getRepository(Sensor).save(
      ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' }),
    );
  });

  const COLUMNS = ALL_SHEETS.find((s) => s.sheet === 'alert_rule')!.columns.map((c) => c.name);

  /** The template workbook with its alert_rule example row edited, staged and validated. */
  const upload = async (action?: string, opts: { dropColumn?: boolean } = {}): Promise<string> => {
    const wb = new Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(await templates.build(new Date('2026-11-19T00:00:00.000Z')) as any);
    const sheet = wb.getWorksheet('alert_rule')!;
    const col = COLUMNS.indexOf('recommended_action') + 1;
    if (action !== undefined) sheet.getRow(2).getCell(col).value = action;
    if (opts.dropColumn) sheet.spliceColumns(col, 1);
    const parsed = await parser.parse((await wb.xlsx.writeBuffer()) as unknown as Buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };

  const alertRow = async (batchId: string) =>
    (await ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'alert_rule' } }))[0];
  const versions = () => ds.getRepository(AlertRuleTemplate).find({ where: { slug: ALERT }, order: { version: 'ASC' } });

  it('imports the action written on the row', async () => {
    await applier.apply(await upload(), 'deepak');
    const [rule] = await versions();
    expect(rule.recommendedAction).toBe(EXAMPLE_ACTION);
  });

  it('reads a blank cell as no action', async () => {
    await applier.apply(await upload(''), 'deepak');
    expect((await versions())[0].recommendedAction).toBeNull();
  });

  it('imports a workbook made before the column existed, as no action', async () => {
    const batchId = await upload(undefined, { dropColumn: true });
    expect([(await alertRow(batchId)).status, (await alertRow(batchId)).message]).toEqual(['valid', null]);
    await applier.apply(batchId, 'deepak');
    expect((await versions())[0].recommendedAction).toBeNull();
  });

  it('refuses an action too long to say on a call, naming the row, and writes nothing for it', async () => {
    const batchId = await upload('x'.repeat(301));
    const row = await alertRow(batchId);
    expect(row.status).toBe('invalid');
    expect(row.message).toMatch(/recommended_action .* 300 characters/);
  });

  it('treats a changed action on a published rule as a new version, and the same one as unchanged', async () => {
    await applier.apply(await upload(), 'deepak');
    await ds.getRepository(AlertRuleTemplate).update({ slug: ALERT }, { status: 'published', publishedAt: new Date() });

    const same = await applier.apply(await upload(), 'deepak');
    expect(same.rules!.alertRule).toMatchObject({ unchanged: 1, newVersions: 0 });

    const changed = await applier.apply(await upload('Inspect the coolant pump this week.'), 'deepak');
    expect(changed.rules!.alertRule).toMatchObject({ newVersions: 1 });
    expect((await versions()).map((v) => [v.version, v.status, v.recommendedAction])).toEqual([
      [1, 'published', EXAMPLE_ACTION],
      [2, 'draft', 'Inspect the coolant pump this week.'],
    ]);
  });

  it('keeps a published rule with no action unchanged when re-imported without one', async () => {
    // Every template published before this column existed has a null action. Re-uploading
    // its workbook must not mint a new version of each just because the column is new.
    await applier.apply(await upload(undefined, { dropColumn: true }), 'deepak');
    await ds.getRepository(AlertRuleTemplate).update({ slug: ALERT }, { status: 'published', publishedAt: new Date() });
    const again = await applier.apply(await upload(''), 'deepak');
    expect(again.rules!.alertRule).toMatchObject({ unchanged: 1, newVersions: 0 });
  });
});
