import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { CatalogImportBatch } from '../src/catalog-import/entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { CausalChainDefinition } from '../src/intelligence/entities/causal-chain.entity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

// Parse, validate and apply, sometimes twice, in one test.
jest.setTimeout(30_000);

const CLASS = 'diesel-generator';
const SCENARIO = 'diesel-generator-coolant-drift';
const ALERT = 'diesel-generator-coolant-drift-alert';
const CHAIN = 'diesel-generator-cooling-chain';

type Rows = Record<string, string | number>[];
interface Edit {
  /** Cells to change on a sheet's example row (row 2). */
  set?: Record<string, Record<string, string | number>>;
  /** Rows to add to a sheet, by column name. */
  add?: Record<string, Rows>;
  /** Sheets to leave out entirely. */
  drop?: string[];
}

/**
 * The rule sheets of the catalog workbook (testing sheet TC_116, TC_126): prediction
 * scenarios, alert rules and causal chains, imported as library drafts beside their
 * class. Each refusal is shown by uploading the thing refused, not by reading a rule.
 */
describeDb('catalog import: rule sheets', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let differ: CatalogImportDiffService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    differ = new CatalogImportDiffService(ds);
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

  /** The template workbook — its own example rows — edited as asked, then staged and validated. */
  const upload = async (edit: Edit = {}): Promise<string> => {
    const wb = new Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(await templates.build(new Date('2026-11-12T00:00:00.000Z')) as any);
    const columnsOf = (sheet: string) => ALL_SHEETS.find((s) => s.sheet === sheet)!.columns.map((c) => c.name);
    for (const [sheet, cells] of Object.entries(edit.set ?? {})) {
      for (const [column, value] of Object.entries(cells)) {
        wb.getWorksheet(sheet)!.getRow(2).getCell(columnsOf(sheet).indexOf(column) + 1).value = value;
      }
    }
    for (const [sheet, rows] of Object.entries(edit.add ?? {})) {
      for (const row of rows) wb.getWorksheet(sheet)!.addRow(columnsOf(sheet).map((c) => row[c] ?? null));
    }
    for (const sheet of edit.drop ?? []) wb.removeWorksheet(wb.getWorksheet(sheet)!.id);
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const parsed = await parser.parse(buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };

  const rowsOf = (batchId: string, sheet: string) =>
    ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet }, order: { rowNumber: 'ASC' } });
  const scenarios = () => ds.getRepository(ScenarioDefinition).find({ order: { slug: 'ASC', version: 'ASC' } });
  const chains = () => ds.getRepository(CausalChainDefinition).find({ order: { slug: 'ASC', version: 'ASC' } });
  const alertRules = () => ds.getRepository(AlertRuleTemplate).find({ where: { slug: ALERT }, order: { version: 'ASC' } });

  it('the template\'s own example rules validate, and land as drafts beside the class', async () => {
    const batchId = await upload();
    for (const sheet of ['prediction_scenario', 'alert_rule', 'causal_chain', 'causal_chain_stage']) {
      expect((await rowsOf(batchId, sheet)).map((r) => [r.status, r.message])).toEqual([['valid', null]]);
    }
    const preview = await differ.buildDiff(batchId);

    const summary = await applier.apply(batchId, 'deepak');

    const one = { created: 1, newVersions: 0, unchanged: 0, conflicts: [] };
    expect(summary.rules).toEqual({ scenario: one, alertRule: one, causalChain: one });
    // The diff promised what apply did, from the same plan.
    expect(preview.rules).toEqual(summary.rules);

    const [scenario] = await scenarios();
    expect(scenario).toMatchObject({
      slug: SCENARIO, version: 1, status: 'draft', equipmentClassSlug: CLASS, severity: 'high', tier: 1,
      requiredSignals: ['coolant_temp_c'], minimumHistoryDays: 7,
    });
    // The sigma columns are the scorer's own parameter keys.
    expect(scenario.parameters.map((p) => [p.key, p.default])).toEqual([
      ['warning_sigma', 2], ['critical_sigma', 3], ['baseline_window_days', 14], ['minimum_samples', 30],
    ]);
    const [rule] = await alertRules();
    expect(rule).toMatchObject({
      status: 'draft', trigger: 'prediction-severity', severity: 'high', enabledOnCopy: true,
      params: { atLeast: 'high', clientScenarioSlug: SCENARIO }, createdBy: 'deepak',
    });
    const [chain] = await chains();
    expect(chain).toMatchObject({ slug: CHAIN, status: 'draft', scenarioSlug: SCENARIO, alignmentSeconds: 60 });
    expect(chain.nodes).toEqual([{
      signal: 'coolant_temp_c', label: 'Coolant under load', intercept: 70,
      drivers: [{ signal: 'engine_load_pct', coefficient: 0.3, lagSeconds: 120 }],
      warnAbove: 5, criticalAbove: 10, direction: 'above', limits: { warnAt: 100, criticalAt: 105 },
    }]);
    expect((await rowsOf(batchId, 'causal_chain_stage'))[0].status).toBe('applied');
  });

  it('the same workbook again changes nothing', async () => {
    await applier.apply(await upload(), 'deepak');
    const again = await applier.apply(await upload(), 'deepak');
    const same = { created: 0, newVersions: 0, unchanged: 1, conflicts: [] };
    expect(again.rules).toEqual({ scenario: same, alertRule: same, causalChain: same });
    expect(await scenarios()).toHaveLength(1);
  });

  it('a changed rule over a draft is a conflict: the author\'s draft is not overwritten', async () => {
    await applier.apply(await upload(), 'deepak');
    await ds.getRepository(ScenarioDefinition).update({ slug: SCENARIO }, { name: 'Coolant drift (edited by hand)' });

    const batchId = await upload({ set: { prediction_scenario: { name: 'Coolant drifting hot, revised' } } });
    const summary = await applier.apply(batchId, 'deepak');

    expect(summary.rules!.scenario).toEqual({ created: 0, newVersions: 0, unchanged: 0, conflicts: [SCENARIO] });
    expect((await scenarios()).map((s) => [s.version, s.name])).toEqual([[1, 'Coolant drift (edited by hand)']]);
    const [row] = await rowsOf(batchId, 'prediction_scenario');
    expect(row.status).toBe('skipped');
    expect(row.message).toMatch(/already has a draft \(v1\)/);
  });

  it('a changed rule over a published version becomes the next version, as a draft', async () => {
    await applier.apply(await upload(), 'deepak');
    await ds.getRepository(ScenarioDefinition).update({ slug: SCENARIO }, { status: 'published', publishedAt: new Date() });

    const summary = await applier.apply(await upload({ set: { prediction_scenario: { critical_sigma: 4 } } }), 'deepak');

    expect(summary.rules!.scenario).toMatchObject({ newVersions: 1 });
    expect((await scenarios()).map((s) => [s.version, s.status])).toEqual([[1, 'published'], [2, 'draft']]);
  });

  it('refuses what the class page would refuse, each with its row, and writes none of it', async () => {
    const batchId = await upload({
      add: {
        prediction_scenario: [{ class_slug: CLASS, slug: 'dg-unknown-signal', name: 'X', required_signals: 'oil_pressure_kpa' }],
        alert_rule: [
          { class_slug: CLASS, slug: 'dg-threshold-unknown', name: 'X', trigger: 'signal-threshold', signal: 'oil_pressure_kpa', max: 5 },
          { class_slug: CLASS, slug: 'dg-no-such-scenario', name: 'X', trigger: 'prediction-severity', at_least: 'high', scenario_slug: 'nope' },
          { class_slug: CLASS, slug: 'dg-composite', name: 'X', trigger: 'composite' },
        ],
        causal_chain_stage: [{ chain_slug: 'no-such-chain', signal: 'coolant_temp_c', intercept: 1, drivers: 'x=1', warn_above: 1, critical_above: 2 }],
      },
    });

    expect((await rowsOf(batchId, 'prediction_scenario'))[1].message).toMatch(/does not declare oil_pressure_kpa/);
    const alerts = await rowsOf(batchId, 'alert_rule');
    expect(alerts[1].message).toMatch(/does not declare oil_pressure_kpa/);
    expect(alerts[2].message).toMatch(/no scenario "nope"/);
    expect(alerts[3].message).toMatch(/trigger must be one of/);
    expect((await rowsOf(batchId, 'causal_chain_stage'))[1].message).toMatch(/no causal_chain row "no-such-chain"/);

    await applier.apply(batchId, 'deepak');
    expect((await scenarios()).map((s) => s.slug)).toEqual([SCENARIO]);
    expect(await ds.getRepository(AlertRuleTemplate).count({ where: { trigger: 'composite' as never } })).toBe(0);
  });

  it('a chain stands or falls whole: a bad stage refuses its chain, and a rule naming that chain', async () => {
    const batchId = await upload({
      set: { causal_chain_stage: { drivers: 'engine_load_pct is 0.3' } },
      add: { alert_rule: [{ class_slug: CLASS, slug: 'dg-chain-rule', name: 'X', trigger: 'chain-origin', at_least: 'warning', chain_slug: CHAIN }] },
    });
    expect((await rowsOf(batchId, 'causal_chain_stage'))[0].message).toMatch(/is not "signal=coefficient"/);
    expect((await rowsOf(batchId, 'causal_chain'))[0].message).toMatch(/were refused, so the chain is incomplete/);
    expect((await rowsOf(batchId, 'alert_rule'))[1].message).toMatch(/no causal chain "diesel-generator-cooling-chain"/);
  });

  it('a slug the library holds on another class is refused, not versioned across classes', async () => {
    await ds.getRepository(ScenarioDefinition).save(ds.getRepository(ScenarioDefinition).create({
      slug: SCENARIO, version: 1, status: 'published', publishedAt: new Date(), equipmentClassSlug: 'excavator',
      name: 'Someone else\'s', requiredSignals: [], parameters: [],
    }));
    const batchId = await upload();
    expect((await rowsOf(batchId, 'prediction_scenario'))[0].message).toMatch(/already exists in the library on class "excavator"/);
  });

  it('a workbook carrying only rules for an existing class adds the rules and leaves the class alone', async () => {
    await applier.apply(await upload({ drop: ['prediction_scenario', 'alert_rule', 'causal_chain', 'causal_chain_stage'] }), 'deepak');
    const before = await ds.getRepository(EquipmentClassProfile).find({ where: { slug: CLASS } });

    const summary = await applier.apply(await upload({
      drop: ['equipment_class', 'signal', 'failure_mode', 'recommendation', 'layout', 'sensor_capability', 'formula'],
    }), 'deepak');

    expect(summary.classes).toEqual({});
    expect(summary.rules!.scenario.created).toBe(1);
    expect(await ds.getRepository(EquipmentClassProfile).find({ where: { slug: CLASS } })).toEqual(before);
  });

  it('TC_116: an unchanged class re-uploaded drafts the limit alert it is missing', async () => {
    const plain = { drop: ['prediction_scenario', 'alert_rule', 'causal_chain', 'causal_chain_stage'] };
    await applier.apply(await upload(plain), 'deepak');
    // A draft discarded by an author, or a class uploaded before limits became drafts.
    // As the owner: the application holds no DELETE on library content.
    await owner.query(`DELETE FROM alert_rule_template WHERE slug = 'diesel-generator-coolant-temp-c-limit'`);

    const summary = await applier.apply(await upload(plain), 'deepak');

    expect(summary.classes[CLASS]).toMatchObject({ action: 'unchanged', draftedAlertTemplates: 1 });
  });

  it('two applies of one batch, fired together: one writes, the other is refused, the rules are written once', async () => {
    const batchId = await upload();
    const results = await Promise.allSettled([applier.apply(batchId, 'deepak'), applier.apply(batchId, 'deepak')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await scenarios()).toHaveLength(1);
    expect(await chains()).toHaveLength(1);
    expect(await alertRules()).toHaveLength(1);
  });

  it('a discard racing an apply waits for it: an applied batch is never deleted from under what it wrote', async () => {
    const batchId = await upload();
    const [applied, discarded] = await Promise.allSettled([applier.apply(batchId, 'deepak'), differ.discard(batchId)]);
    const batch = await ds.getRepository(CatalogImportBatch).findOne({ where: { id: batchId } });
    if (applied.status === 'fulfilled') {
      expect(discarded.status).toBe('rejected');
      expect(batch?.status).toBe('applied');
    } else {
      // Discarded first: nothing was written.
      expect(batch).toBeNull();
      expect(await scenarios()).toEqual([]);
    }
  });
});
