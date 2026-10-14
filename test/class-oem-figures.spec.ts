import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { CatalogImportRefusal, WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS, CONTENT_SHEETS, META_SHEET, TEMPLATE_VERSION } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ClassOemFigures1759800000000';
const OEM_COLUMNS = [
  'nominal_fuel_per_hour', 'nominal_fuel_unit', 'idle_breakdown_threshold_minutes',
  'running_signal', 'running_idle_bound', 'availability_signal',
];

/**
 * The OEM figures OEE needs, on the library class (task QCLASS-OEM).
 *
 * QOEE1 stopped at its precondition: the library had no place for a nominal fuel
 * consumption, a breakdown threshold, or the two signals the detector reads. This is
 * the place; the values are the library team's. Every refusal is proven by attempting
 * the forbidden thing — through the import, and straight at the database.
 */
describeDb('class OEM figures: the library holds what OEE needs', () => {
  let owner: DataSource;
  let ds: DataSource;
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
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(() => owner.query(
    `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "equipment_class_recommendation",
      "equipment_class_failure_mode", "equipment_class_formula", "equipment_class_sensor_requirement",
      "equipment_class_profile", "sensor" RESTART IDENTITY CASCADE`,
  ));

  // ------------------------------------------------------------------ workbooks
  const loadWorkbook = async (buffer: Buffer) => {
    const wb = new Workbook();
    await wb.xlsx.load(buffer as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    return wb;
  };
  const write = async (wb: Workbook) => (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  const setCell = (wb: Workbook, sheet: string, column: string, value: unknown, row = 2) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === sheet)!;
    wb.getWorksheet(sheet)!.getRow(row).getCell(schema.columns.findIndex((c) => c.name === column) + 1).value =
      value as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  /** A second and third declared signal for the example class: the running indicator
   * and fuel level the detector reads. */
  const addSignal = (wb: Workbook, signal: string, unit: string, row: number) => {
    setCell(wb, 'signal', 'class_slug', 'diesel-generator', row);
    setCell(wb, 'signal', 'signal', signal, row);
    setCell(wb, 'signal', 'unit', unit, row);
    setCell(wb, 'signal', 'required', 'FALSE', row);
  };
  /** The generated template — the current version — with the OEE signals declared. */
  const v5Workbook = async (oem: Record<string, unknown> = {}): Promise<Buffer> => {
    const wb = await loadWorkbook(await templates.build(new Date('2026-10-14T00:00:00Z')));
    wb.removeWorksheet(wb.getWorksheet('sensor_capability')!.id);
    addSignal(wb, 'engine_running_status', 'state', 3);
    addSignal(wb, 'fuel_level', 'percent', 4);
    for (const [column, value] of Object.entries(oem)) setCell(wb, 'equipment_class', column, value);
    return write(wb);
  };
  /** A workbook exactly as template v4 wrote it: no v5 column, stamped v4. With
   * `keepSignals`, it still declares the two signals the figures name. */
  const v4Workbook = async (name = 'Diesel Generator', keepSignals = true): Promise<Buffer> => {
    const wb = new Workbook();
    for (const schema of [META_SHEET, ...CONTENT_SHEETS]) {
      if ((schema.since && schema.since !== 'v4') || schema.sheet === 'sensor_capability') continue;
      const cols = schema.columns.filter((c) => !c.since || c.since === 'v4');
      const sheet = wb.addWorksheet(schema.sheet);
      sheet.addRow(cols.map((c) => c.name));
      const example: Record<string, unknown> = {
        ...schema.example,
        ...(schema === META_SHEET ? { template_version: 'v4', generated_at: 'x' } : {}),
        ...(schema.sheet === 'equipment_class' ? { name } : {}),
      };
      sheet.addRow(cols.map((c) => example[c.name] ?? ''));
    }
    if (keepSignals) {
      addSignal(wb, 'engine_running_status', 'state', 3);
      addSignal(wb, 'fuel_level', 'percent', 4);
    }
    return write(wb);
  };

  const stage = async (buffer: Buffer) => {
    const parsed = await parser.parse(buffer, 'wb.xlsx', 'deepak');
    await validator.validate(parsed.id);
    return parsed.id;
  };
  const classRow = async (batchId: string) =>
    (await ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'equipment_class' } }))[0];
  const latest = () => owner.getRepository(EquipmentClassProfile).findOneOrFail({
    where: { slug: 'diesel-generator' }, order: { version: 'DESC' },
  });

  const FIGURES = {
    nominal_fuel_per_hour: 18, nominal_fuel_unit: 'L/h', idle_breakdown_threshold_minutes: 45,
    running_signal: 'engine_running_status', running_idle_bound: 0, availability_signal: 'fuel_level',
  };

  // ================================================================== template
  it('the template is v5 and carries the six columns, with the example deliberately blank', async () => {
    expect(TEMPLATE_VERSION).toBe('v5');
    const wb = await loadWorkbook(await templates.build(new Date('2026-10-14T00:00:00Z')));
    const sheet = wb.getWorksheet('equipment_class')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(OEM_COLUMNS));
    for (const column of OEM_COLUMNS) {
      expect(sheet.getRow(2).getCell(header.indexOf(column) + 1).value ?? '').toBe('');
    }
  });

  // ==================================================================== import
  it('a v5 workbook with every figure set applies, and the class carries them', async () => {
    const batchId = await stage(await v5Workbook(FIGURES));
    expect((await classRow(batchId)).status).toBe('valid');
    await applier.apply(batchId, 'deepak');
    expect(await latest()).toMatchObject({
      nominalFuelPerHour: 18, nominalFuelUnit: 'L/h', idleBreakdownThresholdMinutes: 45,
      runningSignal: 'engine_running_status', runningIdleBound: 0, availabilitySignal: 'fuel_level',
    });
  });

  it('left blank, nothing is invented: no nominal, no signals, and the stated 30-minute threshold', async () => {
    await applier.apply(await stage(await v5Workbook()), 'deepak');
    expect(await latest()).toMatchObject({
      nominalFuelPerHour: null, nominalFuelUnit: null, idleBreakdownThresholdMinutes: 30,
      runningSignal: null, runningIdleBound: null, availabilitySignal: null,
    });
  });

  it.each([
    ['a nominal with no unit', { nominal_fuel_per_hour: 18 }, /nominal_fuel_per_hour has no unit/],
    ['a unit with no nominal', { nominal_fuel_unit: 'L/h' }, /nominal_fuel_unit "L\/h" is set with no nominal_fuel_per_hour/],
    ['a nominal of zero', { nominal_fuel_per_hour: 0, nominal_fuel_unit: 'L/h' }, /must be above 0/],
    ['a threshold under five minutes', { idle_breakdown_threshold_minutes: 4 }, /at least 5, not 4/],
    ['a running signal the class does not declare',
      { running_signal: 'engine_rpm', running_idle_bound: 600 }, /running_signal "engine_rpm" is not a signal this class declares/],
    ['an availability signal the class does not declare',
      { availability_signal: 'battery_voltage' }, /availability_signal "battery_voltage" is not a signal this class declares/],
    ['a running signal with no idle bound',
      { running_signal: 'engine_running_status' }, /running_signal and running_idle_bound are set together/],
  ])('refused at import, naming the row: %s', async (_label, figures, message) => {
    const batchId = await stage(await v5Workbook(figures));
    const row = await classRow(batchId);
    expect(row.status).toBe('invalid');
    expect(row.message).toMatch(/^equipment_class row 2: "diesel-generator": /);
    expect(row.message).toMatch(message);
  });

  it('only the figures change: a new version — the comparison is not blind to them', async () => {
    await applier.apply(await stage(await v5Workbook(FIGURES)), 'deepak');
    const same = await diff.buildDiff(await stage(await v5Workbook(FIGURES)));
    expect(same.classes[0].action).toBe('unchanged');
    const changed = await diff.buildDiff(await stage(await v5Workbook({ ...FIGURES, nominal_fuel_per_hour: 20 })));
    expect(changed.classes[0].action).toBe('new_version');
  });

  it('a v4 workbook loads, and leaves the figures it cannot express where they were', async () => {
    await applier.apply(await stage(await v5Workbook(FIGURES)), 'deepak');
    const batchId = await stage(await v4Workbook('Diesel Generator, renamed'));
    const result = await diff.buildDiff(batchId);
    expect(result.templateVersionNote).toContain('equipment_class.nominal_fuel_per_hour');
    await applier.apply(batchId, 'deepak', true);
    const v2 = await latest();
    expect(v2.version).toBe(2);
    expect(v2.name).toBe('Diesel Generator, renamed');
    expect(v2).toMatchObject({ nominalFuelPerHour: 18, nominalFuelUnit: 'L/h', idleBreakdownThresholdMinutes: 45 });
  });

  it('a v4 workbook that drops a signal the inherited figures name is refused on its signal rows', async () => {
    await applier.apply(await stage(await v5Workbook(FIGURES)), 'deepak');
    const batchId = await stage(await v4Workbook('Diesel Generator', false));
    const [signal] = await ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet: 'signal' } });
    expect(signal.status).toBe('invalid');
    expect(signal.message).toMatch(/keeps its OEM figures from v1/);
    expect(signal.message).toMatch(/running_signal "engine_running_status" is not a signal this class declares/);
  });

  it('a workbook stamped v4 that carries a v5 column is refused whole', async () => {
    const wb = await loadWorkbook(await v4Workbook());
    const sheet = wb.getWorksheet('equipment_class')!;
    sheet.getRow(1).getCell(sheet.columnCount + 1).value = 'nominal_fuel_per_hour';
    await expect(parser.parse(await write(wb), 'wb.xlsx', 'deepak')).rejects.toThrow(CatalogImportRefusal);
    await expect(parser.parse(await write(wb), 'wb.xlsx', 'deepak')).rejects.toThrow(
      /"nominal_fuel_per_hour" in sheet "equipment_class" is a v5 column, but this workbook declares template_version "v4"/,
    );
  });

  it('a v5 workbook carries the v4 sheets without being refused for them', async () => {
    const result = await diff.buildDiff(await stage(await v5Workbook(FIGURES)));
    expect(result.rejectedRows).toEqual([]);
    expect(result.templateVersionNote).toBeNull();
  });

  // ================================================================== database
  describe('the database refuses what the import refuses, whichever door is used', () => {
    const insert = (columns: Record<string, unknown>) => {
      const all = {
        slug: 'direct', version: 1, status: 'draft', name: 'Direct',
        expected_signals: JSON.stringify([
          { signal: 'engine_running_status', unit: 'state', required: true },
          { signal: 'fuel_level', unit: 'percent', required: true },
        ]),
        ...columns,
      };
      const names = Object.keys(all);
      return ds.query(
        `INSERT INTO equipment_class_profile (${names.map((n) => `"${n}"`).join(', ')})
           VALUES (${names.map((n, i) => (n === 'expected_signals' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
        Object.values(all),
      );
    };

    it.each([
      ['a nominal with no unit', { nominal_fuel_per_hour: 18 }, 'ck_class_nominal_fuel_unit'],
      ['a blank unit', { nominal_fuel_per_hour: 18, nominal_fuel_unit: '  ' }, 'ck_class_nominal_fuel_unit'],
      ['a negative nominal', { nominal_fuel_per_hour: -1, nominal_fuel_unit: 'L/h' }, 'ck_class_nominal_fuel_positive'],
      ['a threshold of four minutes', { idle_breakdown_threshold_minutes: 4 }, 'ck_class_idle_breakdown_threshold'],
      ['a running signal with no bound', { running_signal: 'engine_running_status' }, 'ck_class_running_signal_bound'],
      ['an undeclared running signal', { running_signal: 'engine_rpm', running_idle_bound: 600 }, 'ck_class_oee_signals_declared'],
      ['an undeclared availability signal', { availability_signal: 'battery_voltage' }, 'ck_class_oee_signals_declared'],
    ])('refuses %s', async (_label, columns, constraint) => {
      await expect(insert(columns)).rejects.toThrow(constraint);
    });

    it('accepts a complete set, and refuses dropping a signal the figures still name', async () => {
      await insert({
        nominal_fuel_per_hour: 18, nominal_fuel_unit: 'L/h', idle_breakdown_threshold_minutes: 45,
        running_signal: 'engine_running_status', running_idle_bound: 0, availability_signal: 'fuel_level',
      });
      await expect(ds.query(
        `UPDATE equipment_class_profile SET expected_signals = '[{"signal": "fuel_level", "unit": "percent", "required": true}]'::jsonb
          WHERE slug = 'direct'`,
      )).rejects.toThrow('ck_class_oee_signals_declared');
    });
  });

  // ================================================================= migration
  it(`seeded before it runs (${MIGRATION}): existing classes get no nominal and the 30-minute threshold`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      await owner.query(
        `INSERT INTO equipment_class_profile (slug, version, status, name) VALUES ('pre-existing', 1, 'published', 'Old')`,
      );
      await owner.runMigrations({ transaction: 'all' });
      expect(await owner.query(
        `SELECT nominal_fuel_per_hour, nominal_fuel_unit, idle_breakdown_threshold_minutes, running_signal,
                running_idle_bound, availability_signal
           FROM equipment_class_profile WHERE slug = 'pre-existing'`,
      )).toEqual([{
        nominal_fuel_per_hour: null, nominal_fuel_unit: null, idle_breakdown_threshold_minutes: 30,
        running_signal: null, running_idle_bound: null, availability_signal: null,
      }]);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);

  it(`down path (${MIGRATION}): the six columns and five constraints are gone`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      const [{ n }] = await owner.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'equipment_class_profile' AND column_name = ANY($1)`,
        [OEM_COLUMNS],
      );
      expect(n).toBe(0);
      expect(await owner.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck_class_%' AND conname IN
           ('ck_class_nominal_fuel_positive', 'ck_class_nominal_fuel_unit', 'ck_class_idle_breakdown_threshold',
            'ck_class_running_signal_bound', 'ck_class_oee_signals_declared')`,
      )).toEqual([{ n: 0 }]);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
