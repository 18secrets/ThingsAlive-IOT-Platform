import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../src/device-catalog/entities/sensor-role-capability.entity';
import { CatalogImportBatch } from '../src/catalog-import/entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const CLASS_SLUG = 'diesel-generator';

/**
 * Apply: versioned and provenanced (task QIMP3), plus two amendments requested on
 * review — the template has to pass its own importer, and re-uploading identical
 * content must not mint a new version.
 */
describeDb('catalog import: apply', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let diff: CatalogImportDiffService;
  let applier: CatalogImportApplyService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    diff = new CatalogImportDiffService(ds);
    applier = new CatalogImportApplyService(ds);
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe' }));
  });

  const workbookBuffer = async (generatedAt: Date, mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const base = await templates.build(generatedAt);
    if (!mutate) return base;
    const wb = new Workbook();
    // Same exceljs/@types-node Buffer mismatch worked around throughout this feature.
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

  const catalogCounts = async () => ({
    classes: await ds.getRepository(EquipmentClassProfile).count(),
    requirements: await ds.getRepository(EquipmentClassSensorRequirement).count(),
    formulas: await ds.getRepository(EquipmentClassFormula).count(),
    capabilities: await ds.getRepository(SensorRoleCapability).count(),
  });

  it('creates the class, its expected signals, failure modes, requirements, capabilities, thresholds and formulas', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')));
    const summary = await applier.apply(id, 'deepak');

    expect(summary.classes[CLASS_SLUG]).toMatchObject({ action: 'create', version: 1 });

    const cls = await ds.getRepository(EquipmentClassProfile).findOneOrFail({ where: { slug: CLASS_SLUG } });
    expect(cls.version).toBe(1);
    expect(cls.status).toBe('draft');
    expect(cls.expectedSignals).toEqual([
      { signal: 'coolant_temp_c', unit: 'degC', required: true, description: 'Coolant temperature' },
    ]);
    expect(cls.failureModes).toEqual([{
      code: 'overheat', name: 'Overheating', symptom: 'High coolant temperature, reduced power',
      signals: ['coolant_temp_c', 'oil_pressure_kpa'],
    }]);
    expect(cls.defaultThresholds).toEqual({ coolant_temp_c: { max: 105, unit: 'degC', severity: 'critical' } });

    const reqs = await ds.getRepository(EquipmentClassSensorRequirement).find({
      where: { classSlug: CLASS_SLUG, classVersion: 1 },
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      measurementRole: 'coolant_temp_c', componentScope: '', criticality: 'required', minCount: 1,
      canonicalUnit: 'degC', enables: ['data_quality', 'physics_calculation'],
    });

    const formulas = await ds.getRepository(EquipmentClassFormula).find({
      where: { classSlug: CLASS_SLUG, classVersion: 1 },
    });
    expect(formulas).toHaveLength(1);
    expect(formulas[0]).toMatchObject({
      formulaKey: 'coolant_margin_c', kind: 'empirical', inputs: ['coolant_temp_c'], status: 'proposed',
    });

    const caps = await ds.getRepository(SensorRoleCapability).find();
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      measurementRole: 'coolant_temp_c', parameterKey: 'temperature', canonicalUnit: 'degC',
    });
  });

  it('a composite machine writes one expected_signals entry but one sensor_requirement row per component', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z'), (wb) => {
      addRow(wb, 'signal', {
        class_slug: CLASS_SLUG, signal: 'bearing_temp_c', unit: 'degC', required: 'TRUE',
        description: 'Bearing temperature', min: '', max: 90, severity: 'high',
        component_scope: 'left', criticality: 'required', min_count: 1,
      });
      addRow(wb, 'signal', {
        class_slug: CLASS_SLUG, signal: 'bearing_temp_c', unit: 'degC', required: 'TRUE',
        description: 'Bearing temperature', min: '', max: 90, severity: 'high',
        component_scope: 'right', criticality: 'recommended', min_count: 1,
      });
    }));
    await applier.apply(id, 'deepak');

    const cls = await ds.getRepository(EquipmentClassProfile).findOneOrFail({ where: { slug: CLASS_SLUG } });
    expect(cls.expectedSignals.filter((s) => s.signal === 'bearing_temp_c')).toHaveLength(1);
    expect(cls.defaultThresholds.bearing_temp_c).toEqual({ max: 90, unit: 'degC', severity: 'high' });

    const reqs = await ds.getRepository(EquipmentClassSensorRequirement).find({
      where: { classSlug: CLASS_SLUG, classVersion: 1, measurementRole: 'bearing_temp_c' },
    });
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.componentScope).sort()).toEqual(['left', 'right']);
    expect(reqs.map((r) => r.criticality).sort()).toEqual(['recommended', 'required']);
  });

  it('provenance is present on every written row: the batch id and excel-import as source', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')));
    await applier.apply(id, 'deepak');

    const cls = await ds.getRepository(EquipmentClassProfile).findOneOrFail({ where: { slug: CLASS_SLUG } });
    expect(cls.source).toBe('excel-import');
    expect(cls.importBatchId).toBe(id);

    for (const [repo] of [
      [ds.getRepository(EquipmentClassSensorRequirement)],
      [ds.getRepository(EquipmentClassFormula)],
      [ds.getRepository(SensorRoleCapability)],
    ] as const) {
      const rows = await repo.find();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.source).toBe('excel-import');
        expect(row.importBatchId).toBe(id);
      }
    }
  });

  it('applying to an existing published class produces version N+1 and leaves the published version byte-identical', async () => {
    const published = await ds.getRepository(EquipmentClassProfile).save(
      ds.getRepository(EquipmentClassProfile).create({
        slug: CLASS_SLUG, version: 1, name: 'Old Diesel Generator', status: 'published', publishedAt: new Date(),
        expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC', required: true }],
        failureModes: [], defaultThresholds: {}, source: 'manual', importBatchId: null,
      }),
    );
    const before = { ...published };

    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')));
    const summary = await applier.apply(id, 'deepak');
    expect(summary.classes[CLASS_SLUG]).toMatchObject({ action: 'new_version', version: 2 });

    const v1 = await ds.getRepository(EquipmentClassProfile).findOneOrFail({
      where: { slug: CLASS_SLUG, version: 1 },
    });
    expect(v1.name).toBe(before.name);
    expect(v1.status).toBe('published');
    expect(v1.expectedSignals).toEqual(before.expectedSignals);
    expect(v1.source).toBe('manual');
    expect(v1.updatedAt).toEqual(before.updatedAt);

    const v2 = await ds.getRepository(EquipmentClassProfile).findOneOrFail({
      where: { slug: CLASS_SLUG, version: 2 },
    });
    expect(v2.status).toBe('draft');
    expect(v2.source).toBe('excel-import');
  });

  it('refuses a second apply: status must be "validated"', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')));
    await applier.apply(id, 'deepak');
    await expect(applier.apply(id, 'deepak')).rejects.toThrow(/only a validated batch can be applied/);
  });

  it('applies the valid rows and records the rest as skipped, not silently dropped', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z'), (wb) => {
      addRow(wb, 'signal', {
        class_slug: 'ghost-machine', signal: 'x', unit: 'unit', required: 'TRUE',
      });
    }));

    const before = await ds.getRepository(CatalogImportRow).find({ where: { batchId: id } });
    const invalidBefore = before.filter((r) => r.status === 'invalid');
    expect(invalidBefore.length).toBeGreaterThan(0);

    await applier.apply(id, 'deepak');

    const after = await ds.getRepository(CatalogImportRow).find({ where: { batchId: id } });
    for (const row of invalidBefore) {
      const updated = after.find((r) => r.id === row.id)!;
      expect(updated.status).toBe('skipped');
      expect(updated.message).toBe(row.message); // preserved, not overwritten
    }
    expect(after.filter((r) => r.status === 'applied').length).toBeGreaterThan(0);

    // The valid content still landed.
    const cls = await ds.getRepository(EquipmentClassProfile).findOne({ where: { slug: CLASS_SLUG } });
    expect(cls).not.toBeNull();
  });

  it('the workbook `npm run catalog:template` produces passes its own validator with zero rejected rows', async () => {
    // The exact bytes `npm run catalog:template` (src/catalog-import/generate-
    // template.ts) writes to disk — a real generate-then-import round trip, not a
    // hand-built fixture, which would prove nothing about the shipped template. The
    // template failed this exact check once, by accident, before this test existed
    // to make it permanent (see template-schema.ts's formula example history).
    const buffer = await templates.build();
    const { id } = await parseAndValidate(buffer, 'equipment-library-template.xlsx');
    const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: id } });
    expect(rows.filter((r) => r.status === 'invalid')).toHaveLength(0);
  });

  describe('re-uploading identical content', () => {
    it('the diff classifies it as unchanged, and applying creates no new version', async () => {
      const first = await parseAndValidate(
        await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')), 'first.xlsx',
      );
      await applier.apply(first.id, 'deepak');
      const afterFirst = await ds.getRepository(EquipmentClassProfile).findOneOrFail({
        where: { slug: CLASS_SLUG },
      });
      expect(afterFirst.version).toBe(1);

      // A different _meta.generated_at (and so a different checksum, avoiding the
      // "already staged" refusal) — but every content sheet is identical.
      const second = await parseAndValidate(
        await workbookBuffer(new Date('2026-09-23T00:00:00.000Z')), 'second.xlsx',
      );

      const diffResult = await diff.buildDiff(second.id);
      expect(diffResult.classes.find((c) => c.slug === CLASS_SLUG)?.action).toBe('unchanged');

      const summary = await applier.apply(second.id, 'deepak');
      expect(summary.classes[CLASS_SLUG]).toMatchObject({ action: 'unchanged', version: 1 });

      const versions = await ds.getRepository(EquipmentClassProfile).find({ where: { slug: CLASS_SLUG } });
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
    });

    it('a genuinely different row does not classify as unchanged', async () => {
      const first = await parseAndValidate(
        await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')), 'first.xlsx',
      );
      await applier.apply(first.id, 'deepak');

      const second = await parseAndValidate(await workbookBuffer(new Date('2026-09-23T00:00:00.000Z'), (wb) => {
        // signal sheet column order: class_slug, signal, unit, required, description,
        // min, max, severity, component_scope, criticality, min_count, enables, notes.
        wb.getWorksheet('signal')!.getRow(2).getCell(7).value = 110; // max: 105 -> 110
      }), 'second.xlsx');

      const diffResult = await diff.buildDiff(second.id);
      expect(diffResult.classes.find((c) => c.slug === CLASS_SLUG)?.action).toBe('new_version');

      await applier.apply(second.id, 'deepak');
      const versions = await ds.getRepository(EquipmentClassProfile).find({ where: { slug: CLASS_SLUG } });
      expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    });
  });

  it('a failure the database itself refuses rolls back the whole transaction', async () => {
    const { id } = await parseAndValidate(await workbookBuffer(new Date('2026-09-22T00:00:00.000Z')));

    // Not a mock: a second "valid" row sharing the exact natural key
    // (class_slug, signal, component_scope) of the one already staged — its
    // criticality is non-blank, so it resolves into a second
    // equipment_class_sensor_requirement row. Nothing in the application layer would
    // ever produce this — QIMP2's own duplicate check refuses it — so reaching it
    // here means directly forcing a state the validator would reject, to prove the
    // *database's* unique index, not a caught exception, is what unwinds the
    // transaction.
    const existing = await ds.getRepository(CatalogImportRow).findOneOrFail({
      where: { batchId: id, sheet: 'signal' },
    });
    await ds.getRepository(CatalogImportRow).save(ds.getRepository(CatalogImportRow).create({
      batchId: id, sheet: 'signal', rowNumber: 999, entityKind: 'signal',
      payload: { ...existing.payload }, status: 'valid', message: null,
    }));

    const before = await catalogCounts();
    const batchBefore = await ds.getRepository(CatalogImportBatch).findOneOrFail({ where: { id } });

    await expect(applier.apply(id, 'deepak')).rejects.toThrow(/uq_sensor_requirement/);

    expect(await catalogCounts()).toEqual(before);
    const batchAfter = await ds.getRepository(CatalogImportBatch).findOneOrFail({ where: { id } });
    expect(batchAfter.status).toBe(batchBefore.status); // still 'validated', not 'applied'

    const rowsAfter = await ds.getRepository(CatalogImportRow).find({ where: { batchId: id } });
    expect(rowsAfter.every((r) => r.status !== 'applied' && r.status !== 'skipped')).toBe(true);
  });
});
