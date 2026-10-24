import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const CLASS_SLUG = 'diesel-generator';
const platform: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

/**
 * One draft per class (tester bug TC_127). A publish that failed, then a corrected
 * re-upload, used to leave v1 a draft beside v2; publishing v2 left v1 behind, and the
 * Equipment Classes card showed it — with a Publish that would have retired v2. The
 * importer now retires the draft it replaces, and the database refuses a second one.
 */
describeDb('equipment class: one draft per slug', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;
  let authoring: CatalogAuthoringService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    await ds.getRepository(Sensor).save(
      ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' }),
    );
  });

  /** The template workbook, with the class renamed so each upload is a real change. */
  const upload = async (className: string): Promise<string> => {
    const wb = new Workbook();
    // Same exceljs/@types-node Buffer mismatch worked around throughout catalog import.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(await templates.build(new Date('2026-10-24T00:00:00.000Z')) as any);
    const columns = ALL_SHEETS.find((s) => s.sheet === 'equipment_class')!.columns.map((c) => c.name);
    const sheet = wb.getWorksheet('equipment_class')!;
    sheet.eachRow((row) => {
      if (row.getCell(columns.indexOf('slug') + 1).value === CLASS_SLUG) {
        row.getCell(columns.indexOf('name') + 1).value = className;
      }
    });
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const parsed = await parser.parse(buffer, `${className}.xlsx`, 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };

  const versions = async () => (await ds.getRepository(EquipmentClassProfile).find({
    where: { slug: CLASS_SLUG }, order: { version: 'ASC' },
  })).map((c) => [c.version, c.status]);

  it('re-uploading over an unpublished draft retires it: the class keeps one draft', async () => {
    await applier.apply(await upload('Generator, first try'), 'deepak');
    const summary = await applier.apply(await upload('Generator, corrected'), 'deepak');

    expect(summary.classes[CLASS_SLUG]).toMatchObject({ action: 'new_version', version: 2 });
    expect(await versions()).toEqual([[1, 'retired'], [2, 'draft']]);
  });

  it('TC_127, scenario 1: unpublished v1, corrected re-upload, publish — v2 is published and v1 is not a draft', async () => {
    await applier.apply(await upload('Generator, first try'), 'deepak');
    await applier.apply(await upload('Generator, corrected'), 'deepak');

    const published = await authoring.publishClass(platform, CLASS_SLUG);

    expect(published.version).toBe(2);
    expect(await versions()).toEqual([[1, 'retired'], [2, 'published']]);
  });

  it('the database refuses a second draft of the same class', async () => {
    await applier.apply(await upload('Generator, first try'), 'deepak');
    const repo = ds.getRepository(EquipmentClassProfile);
    const v1 = await repo.findOneOrFail({ where: { slug: CLASS_SLUG, version: 1 } });

    await expect(repo.insert(repo.create({ ...v1, id: undefined, version: 2 })))
      .rejects.toThrow(/uq_equipment_class_profile_one_draft/);
    expect(await versions()).toEqual([[1, 'draft']]);
  });

  it('two different uploads applied together still leave the class one draft', async () => {
    await applier.apply(await upload('Generator, first try'), 'deepak');
    const [a, b] = [await upload('Generator, fix A'), await upload('Generator, fix B')];

    const results = await Promise.allSettled([applier.apply(a, 'deepak'), applier.apply(b, 'deepak')]);

    // One may lose to the other's insert; neither may leave a second draft behind.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const drafts = (await versions()).filter(([, status]) => status === 'draft');
    expect(drafts).toHaveLength(1);
  });

  // Last: it takes the schema down past this migration and back up.
  it('OneDraftPerClass1762100000000: up retires stale and duplicate drafts, down drops only the index', async () => {
    await undoMigrationNamed(owner, 'OneDraftPerClass1762100000000');

    const insert = (version: number, status: string) => owner.query(
      `INSERT INTO "equipment_class_profile"
         ("slug", "version", "name", "status", "published_at", "expected_signals", "failure_modes",
          "default_thresholds", "source")
       VALUES ($1, $2, 'Generator', $3, CASE WHEN $3 = 'published' THEN now() END,
               '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'manual')`,
      [CLASS_SLUG, version, status],
    );
    // The state TC_127 left behind, and more: a draft older than the published
    // version, and two drafts newer than it. Possible only without the index.
    await insert(1, 'draft');
    await insert(2, 'published');
    await insert(3, 'draft');
    await insert(4, 'draft');

    await owner.runMigrations({ transaction: 'all' });

    expect(await versions()).toEqual([[1, 'retired'], [2, 'published'], [3, 'retired'], [4, 'draft']]);
    await expect(insert(5, 'draft')).rejects.toThrow(/uq_equipment_class_profile_one_draft/);
  }, 60_000);
});
