import { readFileSync } from 'fs';
import { join } from 'path';
import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFailureMode } from '../src/catalog/entities/equipment-class-failure-mode.entity';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassRecommendation } from '../src/catalog/entities/equipment-class-recommendation.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { CatalogImportRefusal, WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS, CONTENT_SHEETS, META_SHEET } from '../src/catalog-import/template-schema';
import { ClientEquipmentClassFailureMode } from '../src/client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../src/client-catalog/entities/client-equipment-class-recommendation.entity';
import {
  auditClassContentTables, CLASS_CONTENT_INVENTORY, findClassReferencingTables,
} from '../src/client-catalog/services/class-content-inventory';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'LibraryContent1758100000000';
const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

/**
 * The nine class versions as they exist in Development on 2026-10-05, read with a
 * read-only SELECT — real content rather than a synthetic nine, because real content
 * has shapes nobody anticipated (task QREC0a §6).
 */
const DEVELOPMENT = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'development-class-library.json'), 'utf8'),
) as { rows: DevRow[] };
interface DevRow {
  slug: string; version: number; status: string; name: string; category: string | null;
  failure_modes: unknown[]; expected_signals: unknown[];
}

/**
 * Library content structure and template v4 (task QREC0a).
 *
 * Failure modes and recommendations became rows, the KPI presentation and forecast
 * declarations got the columns they were missing, and the template bumped once to
 * carry all of it. Every refusal here is proven by attempting the forbidden thing.
 */
describeDb('library content: failure modes, recommendations, template v4', () => {
  let owner: DataSource;
  let ds: DataSource;
  let authoring: CatalogAuthoringService;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let diff: CatalogImportDiffService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;
  let copies: CopyOnGrantService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    // The full chain from empty — the first of the two runs §8 asks for.
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    diff = new CatalogImportDiffService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
    copies = new CopyOnGrantService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const truncate = () => owner.query(
    `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "client_equipment_class_recommendation",
      "client_equipment_class_failure_mode", "client_formula", "client_scenario", "client_equipment_class",
      "equipment_class_recommendation", "equipment_class_failure_mode", "equipment_class_formula",
      "equipment_class_sensor_requirement", "sensor_role_capability", "equipment_class_profile", "sensor"
     RESTART IDENTITY CASCADE`,
  );

  const CLASS = 'qrec-test-class';
  const createClass = (failureModes: { code: string; name: string; symptom: string; signals: string[] }[] = []) =>
    authoring.createClass(scope, CLASS, {
      name: 'QREC test class',
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
      failureModes,
    });
  const overheat = { code: 'overheat', name: 'Overheating', symptom: 'Runs hot', signals: ['coolant_temp_c'] };

  // ------------------------------------------------------------------ workbooks
  const loadWorkbook = async (buffer: Buffer) => {
    const wb = new Workbook();
    await wb.xlsx.load(buffer as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    return wb;
  };
  const write = async (wb: Workbook) => (await wb.xlsx.writeBuffer()) as unknown as Buffer;

  /** The real generated v4 template, minus the sensor_capability example (a proposed
   * sensor blocks apply until reviewed — QIMP5 — which is not what these tests are
   * about), then changed one thing at a time. */
  const v4Workbook = async (mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const wb = await loadWorkbook(await templates.build(new Date('2026-10-05T00:00:00Z')));
    wb.removeWorksheet(wb.getWorksheet('sensor_capability')!.id);
    mutate?.(wb);
    return write(wb);
  };
  const setCell = (wb: Workbook, sheet: string, column: string, value: unknown, row = 2) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === sheet)!;
    wb.getWorksheet(sheet)!.getRow(row).getCell(schema.columns.findIndex((c) => c.name === column) + 1).value =
      value as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  /** A workbook exactly as the v3 template wrote it: no v4 sheet, no v4 column. */
  const v3Workbook = async (): Promise<Buffer> => {
    const wb = new Workbook();
    for (const schema of [META_SHEET, ...CONTENT_SHEETS]) {
      if (schema.since || schema.sheet === 'sensor_capability') continue;
      const cols = schema.columns.filter((c) => !c.since);
      const sheet = wb.addWorksheet(schema.sheet);
      sheet.addRow(cols.map((c) => c.name));
      const example = { ...schema.example, ...(schema === META_SHEET ? { template_version: 'v3', generated_at: 'x' } : {}) };
      sheet.addRow(cols.map((c) => example[c.name] ?? ''));
    }
    return write(wb);
  };

  const stage = async (buffer: Buffer) => {
    const parsed = await parser.parse(buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };
  const rowsOf = (batchId: string, sheet: string) =>
    ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet } });

  // ============================================================ 3. the migration
  describe('the jsonb conversion, against Development\'s nine class versions', () => {
    const seedDevelopment = async () => {
      for (const r of DEVELOPMENT.rows) {
        await owner.query(
          `INSERT INTO equipment_class_profile (slug, version, status, name, category, expected_signals, failure_modes)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [r.slug, r.version, r.status, r.name, r.category, JSON.stringify(r.expected_signals), JSON.stringify(r.failure_modes)],
        );
      }
    };

    afterEach(async () => {
      // Whatever a test did, leave the chain fully applied for the next one.
      await owner.query(`DELETE FROM equipment_class_profile WHERE slug = 'malformed-class'`).catch(() => undefined);
      await owner.runMigrations({ transaction: 'all' });
    });

    it('converts every entry of all nine versions, row per entry — seeded before migrating', async () => {
      await truncate();
      await undoMigrationNamed(owner, MIGRATION);
      await seedDevelopment();
      await owner.runMigrations({ transaction: 'all' });

      const counts: { slug: string; version: number; n: number }[] = await owner.query(`
        SELECT p.slug, p.version, count(fm.id)::int AS n
          FROM equipment_class_profile p
          LEFT JOIN equipment_class_failure_mode fm ON fm.class_slug = p.slug AND fm.class_version = p.version
         GROUP BY p.slug, p.version ORDER BY p.slug, p.version`);
      // eslint-disable-next-line no-console
      console.log('QREC0a conversion — failure mode rows per class version:', counts);

      expect(counts).toHaveLength(9);
      for (const r of DEVELOPMENT.rows) {
        expect(counts.find((c) => c.slug === r.slug && c.version === r.version)!.n).toBe(r.failure_modes.length);
      }
      const [{ total }] = await owner.query(`SELECT count(*)::int AS total FROM equipment_class_failure_mode`);
      expect(total).toBe(32);
      // Converted entries never had a severity, and NULL is what "nobody said" looks like.
      const [{ withSeverity }] = await owner.query(
        `SELECT count(*)::int AS "withSeverity" FROM equipment_class_failure_mode WHERE severity IS NOT NULL`,
      );
      expect(withSeverity).toBe(0);
      const [{ recs }] = await owner.query(`SELECT count(*)::int AS recs FROM equipment_class_recommendation`);
      expect(recs).toBe(0);

      // The deprecated jsonb is kept, untouched — the way back if a row is wrong.
      const [{ jsonbTotal }] = await owner.query(
        `SELECT sum(jsonb_array_length(failure_modes))::int AS "jsonbTotal" FROM equipment_class_profile`,
      );
      expect(jsonbTotal).toBe(32);
    }, 60_000);

    it('keeps content already published even where it now breaks a publish rule', async () => {
      // diesel-generator v1 in Development names oil_pressure_kpa, which it does not
      // declare. Published content is immutable; the conversion carries it as it is
      // and the rule applies to the next publish, not retroactively.
      const [row] = await owner.query(
        `SELECT signals FROM equipment_class_failure_mode WHERE class_slug = 'diesel-generator' AND code = 'overheat'`,
      );
      expect(row.signals).toEqual(['coolant_temp_c', 'oil_pressure_kpa']);
    });

    it('refuses to commit when the count does not match, naming the class version', async () => {
      await truncate();
      await undoMigrationNamed(owner, MIGRATION);
      await seedDevelopment();
      // A bare string is not an object; the INSERT cannot turn it into a row.
      await owner.query(
        `INSERT INTO equipment_class_profile (slug, version, status, name, failure_modes)
           VALUES ('malformed-class', 1, 'published', 'Malformed', '[{"code": "ok", "name": "Ok"}, "overheat"]'::jsonb)`,
      );

      await expect(owner.runMigrations({ transaction: 'all' })).rejects.toThrow(
        /count mismatch — malformed-class v1: 2 in jsonb, 1 converted/,
      );
      // Nothing was converted — the whole migration rolled back, not just the bad class.
      const [{ exists }] = await owner.query(
        `SELECT to_regclass('equipment_class_failure_mode') IS NOT NULL AS exists`,
      );
      expect(exists).toBe(false);
    }, 60_000);

    it('has a down path, named by its own migration, that leaves none of its additions behind', async () => {
      await truncate();
      await undoMigrationNamed(owner, MIGRATION);
      const tables: { table_name: string }[] = await owner.query(`
        SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('equipment_class_failure_mode', 'equipment_class_recommendation',
                              'client_equipment_class_failure_mode', 'client_equipment_class_recommendation')`);
      expect(tables).toEqual([]);
      const columns: { column_name: string }[] = await owner.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'equipment_class_sensor_requirement'
           AND column_name IN ('forecast_enabled', 'forecast_horizon_hours')`);
      expect(columns).toEqual([]);
    }, 60_000);
  });

  // ============================================================ refusals at publish
  describe('publish', () => {
    beforeEach(truncate);

    it('1. a recommendation naming a failure mode the class version lacks is refused, naming both', async () => {
      // At validate: the row is refused with its number, the action and the code.
      await createClass([overheat]);
      const batchId = await stage(await v4Workbook((wb) => {
        setCell(wb, 'recommendation', 'failure_mode_code', 'bearing_seizure');
      }));
      const [rec] = await rowsOf(batchId, 'recommendation');
      expect(rec.status).toBe('invalid');
      expect(rec.message).toMatch(/Check coolant level.*names failure mode "bearing_seizure"/);

      // At the database: the same thing written directly is refused by the foreign
      // key, so no path — this one, or one not yet written — can store it.
      await expect(ds.getRepository(EquipmentClassRecommendation).save(
        ds.getRepository(EquipmentClassRecommendation).create({
          classSlug: CLASS, classVersion: 1, failureModeCode: 'bearing_seizure', action: 'x', urgency: 'monitor',
        }),
      )).rejects.toThrow(/fk_class_recommendation_failure_mode/);
    });

    it('2. a failure mode naming a signal the class does not declare is refused, naming the signal', async () => {
      await createClass([{ ...overheat, signals: ['coolant_temp_c', 'exhaust_temp_c'] }]);
      await expect(authoring.publishClass(scope, CLASS))
        .rejects.toThrow(/failure mode "overheat" names signal "exhaust_temp_c", which the class does not declare/);
      const draft = await ds.getRepository(EquipmentClassProfile).findOneByOrFail({ slug: CLASS });
      expect(draft.status).toBe('draft');
    });

    it('4. a display_unit that is not the compiled unit is refused, saying no conversion exists', async () => {
      await createClass();
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS, classVersion: 1, formulaKey: 'margin', kind: 'empirical',
        expression: '105 - coolant_temp_c', displayUnit: 'kPa',
      }));
      await expect(authoring.publishClass(scope, CLASS))
        .rejects.toThrow(/declared display_unit "kPa" does not match.*No unit conversion exists/);
    });

    it('5. an aggregation_window outside QCE2\'s vocabulary is refused — at validate, and by the database', async () => {
      const batchId = await stage(await v4Workbook((wb) => setCell(wb, 'formula', 'aggregation_window', 'quarterly')));
      const [formula] = await rowsOf(batchId, 'formula');
      expect(formula.status).toBe('invalid');
      expect(formula.message).toMatch(/"quarterly" is not a valid aggregation_window/);

      await createClass();
      await expect(ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS, classVersion: 1, formulaKey: 'margin', kind: 'empirical',
        expression: '105 - coolant_temp_c', aggregationWindow: 'quarterly' as any,
      }))).rejects.toThrow(/ck_class_formula_aggregation_window/);
    });

    it('6. chart_type "line" on a scalar is refused; "number" on a series is allowed', async () => {
      await createClass();
      const formulas = ds.getRepository(EquipmentClassFormula);
      await formulas.save(formulas.create({
        classSlug: CLASS, classVersion: 1, formulaKey: 'mean_temp', kind: 'empirical',
        expression: 'avg(coolant_temp_c)', chartType: 'line',
      }));
      await expect(authoring.publishClass(scope, CLASS))
        .rejects.toThrow(/"mean_temp": chart_type "line" plots a value over time, but this formula is scalar/);

      await formulas.update({ classSlug: CLASS, formulaKey: 'mean_temp' }, {
        expression: 'coolant_temp_c', chartType: 'number',
      });
      const published = await authoring.publishClass(scope, CLASS);
      expect(published.status).toBe('published');
      const row = await formulas.findOneByOrFail({ classSlug: CLASS, formulaKey: 'mean_temp' });
      expect(row.resultKind).toBe('series');
      expect(row.chartType).toBe('number');
    });

    it('7. forecast_horizon_hours without forecast_enabled is refused — at validate, and by the database', async () => {
      const batchId = await stage(await v4Workbook((wb) => setCell(wb, 'signal', 'forecast_enabled', 'FALSE')));
      const [signal] = await rowsOf(batchId, 'signal');
      expect(signal.status).toBe('invalid');
      expect(signal.message).toMatch(/signal row 2: "forecast_horizon_hours" is set but "forecast_enabled" is not/);

      await createClass();
      await expect(ds.getRepository(EquipmentClassSensorRequirement).save(
        ds.getRepository(EquipmentClassSensorRequirement).create({
          classSlug: CLASS, classVersion: 1, measurementRole: 'coolant_temp_c',
          forecastEnabled: false, forecastHorizonHours: 24,
        }),
      )).rejects.toThrow(/ck_sensor_requirement_forecast_horizon/);
    });

    it('a forecast or staleness setting on a row that writes no requirement is refused, naming the row', async () => {
      const batchId = await stage(await v4Workbook((wb) => setCell(wb, 'signal', 'criticality', '')));
      const [signal] = await rowsOf(batchId, 'signal');
      expect(signal.status).toBe('invalid');
      expect(signal.message).toMatch(
        /signal row 2: "stale_after_seconds", "forecast_enabled", "forecast_horizon_hours" are set, but "criticality" is blank/,
      );
    });
  });

  // ============================================================ template v4 / v3
  describe('the template', () => {
    beforeEach(async () => {
      await truncate();
    });

    it('8. a v3 workbook loads unchanged, gets the defaults, and the diff names what it does not use', async () => {
      const batchId = await stage(await v3Workbook());
      const result = await diff.buildDiff(batchId);
      expect(result.rejectedRows).toEqual([]);
      expect(result.templateVersionNote).toMatch(/template v3; it loads with defaults/);
      for (const unused of [
        'recommendation sheet', 'signal.stale_after_seconds', 'signal.forecast_enabled',
        'signal.forecast_horizon_hours', 'failure_mode.severity', 'formula.display_unit', 'formula.chart_type',
      ]) {
        expect(result.templateVersionNote).toContain(unused);
      }

      const summary = await applier.apply(batchId, 'deepak');
      // Exactly the keys a v3 apply always reported — nothing new appears in its summary.
      expect(Object.keys(summary.classes['diesel-generator'].created).sort()).toEqual(
        ['default_threshold', 'expected_signal', 'failure_mode', 'formula', 'sensor_requirement'],
      );
      const req = await ds.getRepository(EquipmentClassSensorRequirement).findOneByOrFail({ classSlug: 'diesel-generator' });
      expect(req.forecastEnabled).toBe(false);
      expect(req.forecastHorizonHours).toBeNull();
      expect(req.staleAfterSeconds).toBeNull();
      const mode = await ds.getRepository(EquipmentClassFailureMode).findOneByOrFail({ classSlug: 'diesel-generator' });
      expect(mode.severity).toBeNull();
      const formula = await ds.getRepository(EquipmentClassFormula).findOneByOrFail({ classSlug: 'diesel-generator' });
      expect(formula.chartType).toBe('none');
      expect(formula.aggregationWindow).toBe('shift');
      expect(formula.displayUnit).toBeNull();
    });

    it('refuses a workbook that says v3 but carries a v4 column', async () => {
      const wb = await loadWorkbook(await v3Workbook());
      const sheet = wb.getWorksheet('signal')!;
      sheet.getRow(1).getCell(sheet.columnCount + 1).value = 'forecast_enabled';
      await expect(parser.parse(await write(wb), 'wb.xlsx', 'deepak')).rejects.toThrow(CatalogImportRefusal);
      await expect(parser.parse(await write(wb), 'wb.xlsx', 'deepak'))
        .rejects.toThrow(/"forecast_enabled" in sheet "signal" is a v4 column, but this workbook declares template_version "v3"/);
    });

    it('9. a v4 workbook with both new sheets applies, and the rows land in both tables', async () => {
      const batchId = await stage(await v4Workbook());
      const result = await diff.buildDiff(batchId);
      expect(result.rejectedRows).toEqual([]);
      expect(result.templateVersionNote).toBeNull();

      const summary = await applier.apply(batchId, 'deepak');
      expect(summary.classes['diesel-generator'].created).toMatchObject({ failure_mode: 1, recommendation: 1 });

      const [mode] = await ds.getRepository(EquipmentClassFailureMode).findBy({ classSlug: 'diesel-generator' });
      expect(mode).toMatchObject({ code: 'overheat', severity: 'high', source: 'excel-import', importBatchId: batchId });
      const [rec] = await ds.getRepository(EquipmentClassRecommendation).findBy({ classSlug: 'diesel-generator' });
      expect(rec).toMatchObject({
        failureModeCode: 'overheat', urgency: 'next_shift', estimatedHours: 1, classVersion: mode.classVersion,
      });

      const req = await ds.getRepository(EquipmentClassSensorRequirement).findOneByOrFail({ classSlug: 'diesel-generator' });
      expect(req).toMatchObject({ staleAfterSeconds: 300, forecastEnabled: true, forecastHorizonHours: 24 });
      const formula = await ds.getRepository(EquipmentClassFormula).findOneByOrFail({ classSlug: 'diesel-generator' });
      expect(formula).toMatchObject({
        displayUnit: 'degC', targetValue: 10, targetDirection: 'higher_better', comparisonBasis: 'target',
        aggregationWindow: 'shift', chartType: 'line',
      });

      // The deprecated jsonb is still written alongside.
      const cls = await ds.getRepository(EquipmentClassProfile).findOneByOrFail({ slug: 'diesel-generator' });
      expect(cls.failureModes.map((f) => f.code)).toEqual(['overheat']);

      // Re-uploading identical content changes nothing, rows included.
      const again = await stage(await v4Workbook());
      expect((await applier.apply(again, 'deepak')).classes['diesel-generator'].action).toBe('unchanged');
      expect(await ds.getRepository(EquipmentClassFailureMode).count()).toBe(1);
    });

    it('refuses an apply that would leave an inherited recommendation pointing at a dropped failure mode', async () => {
      await applier.apply(await stage(await v4Workbook()), 'deepak');
      // Replaces the failure modes and supplies no recommendation sheet, so the
      // existing recommendation for "overheat" would be inherited with nothing to name.
      const batchId = await stage(await v4Workbook((wb) => {
        wb.removeWorksheet(wb.getWorksheet('recommendation')!.id);
        setCell(wb, 'failure_mode', 'code', 'coolant_loss');
      }));
      await expect(applier.apply(batchId, 'deepak'))
        .rejects.toThrow(/names failure mode "overheat", which this class version does not have/);
      expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(1);
    });
  });

  // ============================================================ versions and grants
  describe('versions and copies', () => {
    beforeEach(truncate);

    const addRecommendation = (version = 1) => ds.getRepository(EquipmentClassRecommendation).save(
      ds.getRepository(EquipmentClassRecommendation).create({
        classSlug: CLASS, classVersion: version, failureModeCode: 'overheat',
        action: 'Clear the radiator', urgency: 'immediate', estimatedHours: 0.5, requiredParts: [{ part: 'coolant' }],
      }),
    );

    it('10. copy-on-grant carries failure modes and recommendations to the tenant copy, and only to it', async () => {
      await createClass([overheat]);
      await addRecommendation();
      await authoring.publishClass(scope, CLASS);

      const result = await copies.copyForTenant('acme', CLASS, 'deepak');
      expect(result).toMatchObject({ failureModesCopied: 1, recommendationsCopied: 1 });

      const [mode] = await withTenantId(ds, 'acme', (m) =>
        m.getRepository(ClientEquipmentClassFailureMode).findBy({ tenantId: 'acme' }));
      expect(mode).toMatchObject({ clientEquipmentClassSlug: CLASS, code: 'overheat', templateVersion: 1 });
      const [rec] = await withTenantId(ds, 'acme', (m) =>
        m.getRepository(ClientEquipmentClassRecommendation).findBy({ tenantId: 'acme' }));
      expect(rec).toMatchObject({
        failureModeCode: 'overheat', urgency: 'immediate', estimatedHours: 0.5, requiredParts: [{ part: 'coolant' }],
      });

      const seenByGlobex = await withTenantId(ds, 'globex', (m) =>
        m.getRepository(ClientEquipmentClassFailureMode).count());
      expect(seenByGlobex).toBe(0);
    });

    it('a fork carries the version\'s failure modes and recommendations forward', async () => {
      await createClass([overheat]);
      await addRecommendation();
      await authoring.publishClass(scope, CLASS);

      await authoring.editClass(scope, CLASS, { description: 'v2' });
      expect(await ds.getRepository(EquipmentClassFailureMode).countBy({ classSlug: CLASS, classVersion: 2 })).toBe(1);
      expect(await ds.getRepository(EquipmentClassRecommendation).countBy({ classSlug: CLASS, classVersion: 2 })).toBe(1);
    });

    it('a published version\'s failure modes cannot be edited or removed — the database refuses', async () => {
      await createClass([overheat]);
      await authoring.publishClass(scope, CLASS);

      await expect(ds.getRepository(EquipmentClassFailureMode).update({ classSlug: CLASS }, { name: 'Changed' }))
        .rejects.toThrow(/only a draft may change \(ck_class_content_draft_only\)/);
      await expect(ds.getRepository(EquipmentClassFailureMode).delete({ classSlug: CLASS }))
        .rejects.toThrow(/ck_class_content_draft_only/);
    });

    it('removing a draft\'s failure mode that a recommendation names is refused, naming both', async () => {
      await createClass([overheat]);
      await addRecommendation();
      await expect(authoring.editClass(scope, CLASS, { failureModes: [] }))
        .rejects.toThrow(/recommendation "Clear the radiator" points at failure mode "overheat"/);
    });

    it('an edit that does not mention severity keeps the one already held', async () => {
      await createClass([{ ...overheat, severity: 'critical' } as any]);
      await authoring.editClass(scope, CLASS, { failureModes: [{ ...overheat, name: 'Overheating (renamed)' }] });
      const mode = await ds.getRepository(EquipmentClassFailureMode).findOneByOrFail({ classSlug: CLASS });
      expect(mode).toMatchObject({ name: 'Overheating (renamed)', severity: 'critical' });
    });

    it('11. the inventory lists both new tables as copy, and the audit passes with them in the schema', async () => {
      const live = await findClassReferencingTables(ds.manager);
      expect(live).toEqual(expect.arrayContaining(['equipment_class_failure_mode', 'equipment_class_recommendation']));
      expect(auditClassContentTables(live, CLASS_CONTENT_INVENTORY)).toEqual([]);
      for (const table of ['equipment_class_failure_mode', 'equipment_class_recommendation']) {
        expect(CLASS_CONTENT_INVENTORY.find((e) => e.table === table)?.disposition).toBe('copy');
      }
    });
  });

});
