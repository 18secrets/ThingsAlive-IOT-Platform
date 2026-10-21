import { DataSource, In } from 'typeorm';
import { Workbook } from 'exceljs';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { AlertRuleTemplate } from '../src/catalog/entities/alert-rule-template.entity';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../src/catalog/services/catalog-authoring.service';
import { NamedFormulaService } from '../src/catalog/services/named-formula.service';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
const CLASS_SLUG = 'diesel-generator';

/**
 * The Excel `formula` sheet's bind mode, end to end (task QCE3 §3-§6) — a row that
 * names a published named formula and a set of `role=signal` bindings instead of
 * writing its own expression. Every negative case starts from the real generated
 * template, exactly like catalog-import-validate.spec.ts, plus one added formula
 * row — a rejection is proven against a workbook otherwise valid, one deliberate
 * change away.
 */
describeDb('named formula binding: the Excel formula sheet', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let applier: CatalogImportApplyService;
  let authoring: CatalogAuthoringService;
  let namedFormulas: NamedFormulaService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    applier = new CatalogImportApplyService(ds);
    authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
      ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias),
      ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    namedFormulas = new NamedFormulaService(ds.getRepository(NamedFormula));
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    // named_formula is deliberately not truncated — the seven real seeded formulas
    // (task QCE3 §7) are what these tests bind against, the same way a real author
    // would.
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    // The template's own sensor_capability example names this sensor — seeded so
    // the plain template (test 11, and every test's untouched sensor_capability
    // row) validates cleanly, same baseline catalog-import-validate.spec.ts uses.
    await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe' }));
  });

  const workbookBuffer = async (mutate?: (wb: Workbook) => void) => {
    const base = await templates.build(new Date('2026-09-22T00:00:00.000Z'));
    if (!mutate) return base;
    const wb = new Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(base as any);
    mutate(wb);
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };

  const addRow = (wb: Workbook, sheetName: string, values: Record<string, unknown>) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === sheetName)!;
    wb.getWorksheet(sheetName)!.addRow(schema.columns.map((c) => values[c.name] ?? ''));
  };

  const parseAndValidate = async (buffer: Buffer, filename = 'wb.xlsx') => {
    const parsed = await parser.parse(buffer, filename, 'deepak');
    await validator.validate(parsed.id);
    return parsed;
  };

  const rowsFor = (batchId: string, sheet: string) =>
    ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet }, order: { rowNumber: 'ASC' } });

  const bindRow = (over: Record<string, unknown> = {}) => ({
    class_slug: CLASS_SLUG, formula_key: 'temp_rise', kind: 'empirical',
    named_formula: 'temperature_rise', named_formula_version: 1,
    bindings: 'outlet_temp=coolant_temp_c; inlet_temp=coolant_temp_c',
    ...over,
  });

  describe('4. the five structural refusal codes, each on its own condition', () => {
    it('formula_mode_conflict: both expression and named_formula filled', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        ...bindRow(), expression: 'coolant_temp_c',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/formula_mode_conflict/);
    });

    it('formula_mode_missing: neither filled', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        class_slug: CLASS_SLUG, formula_key: 'temp_rise', kind: 'empirical',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/formula_mode_missing/);
    });

    it('named_formula_not_found: an unknown slug', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        ...bindRow(), named_formula: 'does-not-exist', named_formula_version: '',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/named_formula_not_found/);
    });

    it('named_formula_not_found: a real slug that is only a draft', async () => {
      const draft = ds.getRepository(NamedFormula).create({
        slug: 'draft-only', version: 1, name: 'Draft Only', expression: 'x',
        inputs: [{ role: 'x', dimension: 'degC' }], status: 'draft',
      });
      await ds.getRepository(NamedFormula).save(draft);
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        ...bindRow(), named_formula: 'draft-only', named_formula_version: 1, bindings: 'x=coolant_temp_c',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/named_formula_not_found/);
    });

    it('unknown_role: a binding names a role the named formula does not declare', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        ...bindRow(), bindings: 'outlet_temp=coolant_temp_c; inlet_temp=coolant_temp_c; bogus_role=coolant_temp_c',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/unknown_role/);
      expect(row.message).toMatch(/bogus_role/);
    });

    it('unbound_role: a declared role is missing from bindings, and is named', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
        ...bindRow(), bindings: 'outlet_temp=coolant_temp_c',
      }));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/unbound_role/);
      expect(row.message).toMatch(/inlet_temp/);
    });

    it('a structurally valid bind-mode row validates cleanly', async () => {
      const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', bindRow()));
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('valid');
    });
  });

  it('5. a dimensionally incompatible binding refuses the class publish', async () => {
    const buffer = await workbookBuffer((wb) => {
      addRow(wb, 'signal', {
        class_slug: CLASS_SLUG, signal: 'oil_pressure_kpa', unit: 'kPa', required: 'FALSE',
      });
      addRow(wb, 'formula', bindRow({ bindings: 'outlet_temp=coolant_temp_c; inlet_temp=oil_pressure_kpa' }));
    });
    const { id } = await parseAndValidate(buffer);
    await applier.apply(id, 'deepak');
    await expect(authoring.publishClass(scope, CLASS_SLUG)).rejects.toThrow(/inlet_temp.*degC.*oil_pressure_kpa.*kPa/s);
  });

  it('6. suspicious_binding refuses the publish, and acknowledgeWarnings lets it through', async () => {
    // A signal of its own, deliberately not the template's default coolant_temp_c —
    // that one already carries a genuine "temperature" capability from the
    // template's own sensor_capability example row, which would make a second,
    // disagreeing capability merely ambiguous rather than purely wrong.
    const buffer = await workbookBuffer((wb) => {
      addRow(wb, 'signal', { class_slug: CLASS_SLUG, signal: 'exhaust_temp_c', unit: 'degC', required: 'FALSE' });
      addRow(wb, 'formula', bindRow({
        bindings: 'outlet_temp=exhaust_temp_c; inlet_temp=exhaust_temp_c',
      }));
    });
    const { id } = await parseAndValidate(buffer);
    await applier.apply(id, 'deepak');

    // temperature_rise's roles expect parameter_key "temperature" (§7 seed). A
    // capability that says this signal measures something else is the suspicious
    // case — not absence, which §4 explicitly is not evidence.
    const sensor = await ds.getRepository(Sensor).findOneOrFail({ where: { sensorName: 'Coolant Temp Probe' } });
    await ds.getRepository(SensorRoleCapability).save(ds.getRepository(SensorRoleCapability).create({
      sensorId: sensor.id, measurementRole: 'exhaust_temp_c', parameterKey: 'pressure',
    }));

    await expect(authoring.publishClass(scope, CLASS_SLUG)).rejects.toThrow(/suspicious_binding/);
    const published = await authoring.publishClass(scope, CLASS_SLUG, true);
    expect(published.status).toBe('published');
  });

  it('7. a bound formula and the equivalent hand-written expression compile to an identical plan', async () => {
    const bound = await workbookBuffer((wb) => addRow(wb, 'formula', bindRow()));
    const { id: boundId } = await parseAndValidate(bound);
    await applier.apply(boundId, 'deepak');
    const boundClass = await authoring.publishClass(scope, CLASS_SLUG);
    const boundFormula = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
      where: { classSlug: CLASS_SLUG, classVersion: boundClass.version, formulaKey: 'temp_rise' },
    });

    // No delete — platform content is never deleted, published or not (ta_app has
    // no DELETE grant on equipment_class_profile). Applying the hand-written
    // version to the same class mints v2 naturally, the same as any other
    // re-upload that changes a class's content.
    const handWritten = await workbookBuffer((wb) => addRow(wb, 'formula', {
      class_slug: CLASS_SLUG, formula_key: 'temp_rise', kind: 'empirical',
      expression: 'coolant_temp_c - coolant_temp_c', output_unit: 'degC',
    }));
    const { id: handId } = await parseAndValidate(handWritten);
    await applier.apply(handId, 'deepak');
    const handClass = await authoring.publishClass(scope, CLASS_SLUG);
    const handFormula = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
      where: { classSlug: CLASS_SLUG, classVersion: handClass.version, formulaKey: 'temp_rise' },
    });

    expect(boundFormula.compiledPlan).toEqual(handFormula.compiledPlan);
  });

  it('8. publishing v2 of a named formula leaves an already-published class untouched', async () => {
    await namedFormulas.create(scope, 'test-named-8', {
      name: 'Test Named 8', expression: 'raw', inputs: [{ role: 'raw', dimension: 'degC' }],
    } as any);
    await namedFormulas.publish(scope, 'test-named-8', 1);

    const buffer = await workbookBuffer((wb) => addRow(wb, 'formula', {
      class_slug: CLASS_SLUG, formula_key: 'v8_formula', kind: 'empirical',
      named_formula: 'test-named-8', named_formula_version: 1, bindings: 'raw=coolant_temp_c',
    }));
    const { id } = await parseAndValidate(buffer);
    await applier.apply(id, 'deepak');
    const publishedClass = await authoring.publishClass(scope, CLASS_SLUG);
    const before = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
      where: { classSlug: CLASS_SLUG, classVersion: publishedClass.version, formulaKey: 'v8_formula' },
    });
    expect(before.namedFormulaVersion).toBe(1);

    // v2: a different expression entirely, still over the same role.
    await namedFormulas.create(scope, 'test-named-8', {
      name: 'Test Named 8', expression: 'raw * 2', inputs: [{ role: 'raw', dimension: 'degC' }],
    } as any);
    await namedFormulas.publish(scope, 'test-named-8', 2);

    const after = await ds.getRepository(EquipmentClassFormula).findOneOrFail({
      where: { classSlug: CLASS_SLUG, classVersion: publishedClass.version, formulaKey: 'v8_formula' },
    });
    expect(after.namedFormulaVersion).toBe(1);
    expect(after.compiledPlan).toEqual(before.compiledPlan);
  });

  it('10. all seven seeded formulas are published with a compiled plan, from the migration alone', async () => {
    const SEEDED_SLUGS = [
      'specific_fuel_consumption', 'fuel_per_hour', 'load_factor', 'temperature_rise',
      'pressure_differential', 'duty_cycle', 'co2_from_fuel',
    ];
    const rows = await ds.getRepository(NamedFormula).find({ where: { slug: In(SEEDED_SLUGS) } });
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.status).toBe('published');
      expect(r.compiledPlan).not.toBeNull();
    }
  });

  it('11. a workbook with no named_formula column loads unchanged', async () => {
    const buffer = await workbookBuffer(); // the plain template, no mutation at all
    const result = await parser.parse(buffer, 'plain.xlsx', 'deepak');
    expect(result.status).toBe('parsed');
    expect(result.invalidRowCount).toBe(0);
    await validator.validate(result.id);
    const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: result.id } });
    expect(rows.every((r) => r.status === 'valid')).toBe(true);
  });
});
