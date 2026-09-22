import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS, TEMPLATE_VERSION } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The workbook template and parser (task QIMP1).
 *
 * This slice never touches a catalog table — the assertion that matters most here is
 * the negative one: whatever else a test proves, `equipment_class_profile` stays
 * empty. Every negative case starts from the real generated template and changes one
 * thing, so a refusal is proven against a workbook the parser would otherwise accept,
 * not against something already wrong in five other ways.
 */
describeDb('catalog import: workbook template and parser', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "catalog_import_row", "catalog_import_batch" RESTART IDENTITY CASCADE`);
  });

  const GENERATED_AT = new Date('2026-09-22T00:00:00.000Z');

  // exceljs's own typings shadow the global `Buffer` with a legacy, non-generic
  // definition incompatible with @types/node's — the same mismatch worked around in
  // workbook-parser.service.ts and catalog-template.service.ts.
  const loadWorkbook = (wb: Workbook, buffer: Buffer) => wb.xlsx.load(buffer as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  const writeWorkbook = async (wb: Workbook): Promise<Buffer> =>
    (await wb.xlsx.writeBuffer()) as unknown as Buffer;

  const workbookBuffer = async (mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const base = await templates.build(GENERATED_AT);
    if (!mutate) return base;
    const wb = new Workbook();
    await loadWorkbook(wb, base);
    mutate(wb);
    return writeWorkbook(wb);
  };

  // ExcelJS does not preserve `worksheet.columns` key metadata across a save/reload
  // round trip, so a key-based `addRow(object)` on a re-loaded workbook silently
  // inserts nothing. Every mutation here goes through the template's own known column
  // order instead, which a save/reload cannot lose.
  const addRow = (wb: Workbook, sheetName: string, values: Record<string, unknown>) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === sheetName)!;
    wb.getWorksheet(sheetName)!.addRow(schema.columns.map((c) => values[c.name] ?? ''));
  };

  it('generates a template the parser accepts as-is, one row per content sheet', async () => {
    const buffer = await workbookBuffer();
    const result = await parser.parse(buffer, 'template.xlsx', 'deepak');

    expect(result.status).toBe('parsed');
    expect(result.invalidRowCount).toBe(0);
    expect(result.countsBySheet).toEqual({
      equipment_class: 1, expected_signal: 1, failure_mode: 1, sensor_requirement: 1,
      sensor_capability: 1, default_threshold: 1, formula: 1,
    });
  });

  it('parses extra rows to the expected counts per sheet', async () => {
    const buffer = await workbookBuffer((wb) => {
      addRow(wb, 'equipment_class', {
        slug: 'concrete-pump', name: 'Concrete Pump', description: '', category: 'fluid',
        service_interval_hours: 500,
      });
      addRow(wb, 'expected_signal', {
        class_slug: 'concrete-pump', signal: 'boom_angle_deg', unit: 'deg',
        required: 'FALSE', description: '',
      });
    });

    const result = await parser.parse(buffer, 'more-rows.xlsx', 'deepak');
    expect(result.countsBySheet.equipment_class).toBe(2);
    expect(result.countsBySheet.expected_signal).toBe(2);

    const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: result.id } });
    // 7 example rows from the template, plus the 2 just added.
    expect(rows).toHaveLength(9);
  });

  it('splits a comma-separated multi-value cell and parses the boolean column', async () => {
    const result = await parser.parse(await workbookBuffer(), 'template.xlsx', 'deepak');

    const failureMode = await ds.getRepository(CatalogImportRow).findOneOrFail({
      where: { batchId: result.id, sheet: 'failure_mode' },
    });
    expect(failureMode.payload.signals).toEqual(['coolant_temp_c', 'oil_pressure_kpa']);

    const expectedSignal = await ds.getRepository(CatalogImportRow).findOneOrFail({
      where: { batchId: result.id, sheet: 'expected_signal' },
    });
    expect(expectedSignal.payload.required).toBe(true);
  });

  it('refuses a workbook with no _meta sheet', async () => {
    const buffer = await workbookBuffer((wb) => wb.removeWorksheet('_meta'));
    await expect(parser.parse(buffer, 'no-meta.xlsx', 'deepak'))
      .rejects.toThrow(/no "_meta" sheet/);
  });

  it('refuses an unknown template_version', async () => {
    const buffer = await workbookBuffer((wb) => {
      wb.getWorksheet('_meta')!.getRow(2).getCell(1).value = 'v0-ancient';
    });
    await expect(parser.parse(buffer, 'old-version.xlsx', 'deepak'))
      .rejects.toThrow(/unknown template_version/i);
  });

  it('refuses an unknown column, and names it', async () => {
    const buffer = await workbookBuffer((wb) => {
      wb.getWorksheet('equipment_class')!.getRow(1).getCell(6).value = 'made_up_column';
    });
    await expect(parser.parse(buffer, 'bad-column.xlsx', 'deepak'))
      .rejects.toThrow(/unknown column "made_up_column"/i);
  });

  it('refuses a required column missing from the header, rather than rejecting every row', async () => {
    const buffer = await workbookBuffer((wb) => {
      // "slug" is required for equipment_class. Blanking its header cell removes it
      // from the sheet the same way deleting the column in Excel would.
      wb.getWorksheet('equipment_class')!.getRow(1).getCell(1).value = null;
    });
    await expect(parser.parse(buffer, 'missing-required-column.xlsx', 'deepak'))
      .rejects.toThrow(/missing required column "slug"/i);
  });

  it('tolerates an optional column missing from the header', async () => {
    const buffer = await workbookBuffer((wb) => {
      // "description" is optional for equipment_class.
      wb.getWorksheet('equipment_class')!.getRow(1).getCell(3).value = null;
    });
    const result = await parser.parse(buffer, 'missing-optional-column.xlsx', 'deepak');
    expect(result.status).toBe('parsed');
    expect(result.countsBySheet.equipment_class).toBe(1);
  });

  it('rejects a row with a blank required cell, naming sheet, row and column', async () => {
    const buffer = await workbookBuffer((wb) => {
      addRow(wb, 'equipment_class', {
        slug: '', name: 'No Slug', description: '', category: '', service_interval_hours: '',
      });
    });

    const result = await parser.parse(buffer, 'blank-cell.xlsx', 'deepak');
    const rows = await ds.getRepository(CatalogImportRow).find({
      where: { batchId: result.id, sheet: 'equipment_class' },
    });
    const bad = rows.find((r) => r.rowNumber === 3);

    expect(bad?.status).toBe('invalid');
    expect(bad?.message).toMatch(/equipment_class row 3/);
    expect(bad?.message).toMatch(/slug/);
    // The row is kept, not dropped.
    expect(rows).toHaveLength(2);
  });

  it('skips a fully blank row rather than rejecting it', async () => {
    const buffer = await workbookBuffer((wb) => {
      addRow(wb, 'equipment_class', {
        slug: '', name: '', description: '', category: '', service_interval_hours: '',
      });
      addRow(wb, 'equipment_class', {
        slug: 'genset-2', name: 'Genset 2', description: '', category: 'power',
        service_interval_hours: 300,
      });
    });

    const result = await parser.parse(buffer, 'blank-row.xlsx', 'deepak');
    // The template's own example row, plus the real addition — the fully blank row in
    // between never became a staged row at all.
    expect(result.countsBySheet.equipment_class).toBe(2);
  });

  it('refuses staging the same workbook twice, by checksum', async () => {
    const buffer = await workbookBuffer();
    await parser.parse(buffer, 'first.xlsx', 'deepak');
    await expect(parser.parse(buffer, 'second.xlsx', 'deepak'))
      .rejects.toThrow(/already been staged/);
  });

  it('writes nothing to any catalog table', async () => {
    await parser.parse(await workbookBuffer(), 'template.xlsx', 'deepak');
    const [{ count }] = await owner.query(`SELECT count(*)::int FROM "equipment_class_profile"`);
    expect(count).toBe(0);
  });

  describe('the template generator', () => {
    it('writes every sheet the parser reads, plus _enums', async () => {
      const wb = new Workbook();
      await loadWorkbook(wb, await templates.build());
      expect(wb.worksheets.map((s) => s.name)).toEqual([
        '_meta', 'equipment_class', 'expected_signal', 'failure_mode', 'sensor_requirement',
        'sensor_capability', 'default_threshold', 'formula', '_enums',
      ]);
    });

    it('pre-fills _meta with the current template_version', async () => {
      const wb = new Workbook();
      await loadWorkbook(wb, await templates.build());
      const meta = wb.getWorksheet('_meta')!;
      // Column order is fixed by the schema: template_version, generated_at, author.
      expect(meta.getRow(2).getCell(1).value).toBe(TEMPLATE_VERSION);
    });

    it('lists every allowed enum value on its own sheet', async () => {
      const wb = new Workbook();
      await loadWorkbook(wb, await templates.build());
      const enums = wb.getWorksheet('_enums')!;
      const criticalityRow = enums.getRow(2);
      expect(criticalityRow.getCell(1).value).toBe('sensor_requirement.criticality');
      expect(criticalityRow.getCell(2).value).toBe('required, recommended, optional');
    });

    it('lists default_threshold.severity, reused from AlertRule.severity — and no comparator vocabulary, because alert_rule has none', async () => {
      const wb = new Workbook();
      await loadWorkbook(wb, await templates.build());
      const enums = wb.getWorksheet('_enums')!;
      const fields: unknown[] = [];
      enums.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        fields.push(row.getCell(1).value);
      });
      expect(fields).toContain('default_threshold.severity');
      expect(fields).not.toContain('default_threshold.comparator');

      const severityRow = enums.getRows(1, enums.rowCount)!
        .find((row) => row.getCell(1).value === 'default_threshold.severity')!;
      expect(severityRow.getCell(2).value).toBe('none, low, medium, high, critical');
    });
  });
});
