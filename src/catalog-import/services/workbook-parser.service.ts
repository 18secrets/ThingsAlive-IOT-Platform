import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Workbook, Worksheet } from 'exceljs';
import { DataSource } from 'typeorm';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow, CatalogImportRowStatus } from '../entities/catalog-import-row.entity';
import { CONTENT_SHEETS, META_SHEET, SheetSchema, TEMPLATE_VERSION } from '../template-schema';

/** A whole-workbook refusal: the file never resolves to a batch or any staged row. */
export class CatalogImportRefusal extends Error {}

export interface ParsedBatchSummary {
  id: string;
  status: string;
  countsBySheet: Record<string, number>;
  invalidRowCount: number;
}

interface StagedRow {
  sheet: string;
  rowNumber: number;
  entityKind: string;
  payload: Record<string, unknown>;
  status: CatalogImportRowStatus;
  message: string | null;
}

/**
 * Turns an uploaded workbook into staged rows, and nothing else (task QIMP1).
 *
 * A workbook that does not match the template's shape is refused whole — never parsed
 * leniently — because a template that changed shape and was read with the old column
 * meanings would succeed silently, which is the worst failure available here. Once the
 * shape is right, individual rows are staged even when a row itself is unusable: every
 * row is kept, including the rejected ones, so an import never half-loads a class with
 * nobody able to say which half.
 */
@Injectable()
export class WorkbookParserService {
  constructor(private readonly ds: DataSource) {}

  async parse(buffer: Buffer, filename: string, uploadedBy: string): Promise<ParsedBatchSummary> {
    const checksum = createHash('sha256').update(buffer).digest('hex');

    const existing = await this.ds.getRepository(CatalogImportBatch).findOne({
      where: { checksumSha256: checksum },
    });
    if (existing) {
      throw new CatalogImportRefusal(
        `This workbook has already been staged (batch ${existing.id}, filename "${existing.filename}").`,
      );
    }

    const workbook = new Workbook();
    // Same exceljs/@types-node Buffer mismatch as CatalogTemplateService.build().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);

    const templateVersion = this.readMeta(workbook);
    const staged = this.readContentSheets(workbook);

    return this.ds.transaction(async (m) => {
      const batchRepo = m.getRepository(CatalogImportBatch);
      const batch = await batchRepo.save(batchRepo.create({
        filename, checksumSha256: checksum, templateVersion, uploadedBy, status: 'parsed',
      }));

      const rowRepo = m.getRepository(CatalogImportRow);
      if (staged.length) {
        await rowRepo.save(staged.map((r) => rowRepo.create({ ...r, batchId: batch.id })));
      }

      const countsBySheet: Record<string, number> = {};
      let invalidRowCount = 0;
      for (const r of staged) {
        countsBySheet[r.sheet] = (countsBySheet[r.sheet] ?? 0) + 1;
        if (r.status === 'invalid') invalidRowCount += 1;
      }

      return { id: batch.id, status: batch.status, countsBySheet, invalidRowCount };
    });
  }

  private readMeta(workbook: Workbook): string {
    const sheet = workbook.getWorksheet(META_SHEET.sheet);
    if (!sheet) {
      throw new CatalogImportRefusal('Workbook has no "_meta" sheet.');
    }
    const colIndexByName = this.readHeader(sheet, META_SHEET);
    const dataRow = sheet.getRow(2);
    const idx = colIndexByName.get('template_version');
    const templateVersion = idx ? cellToString(dataRow.getCell(idx).value) : '';
    if (templateVersion !== TEMPLATE_VERSION) {
      throw new CatalogImportRefusal(
        `Unknown template_version "${templateVersion || '(blank)'}". This importer reads "${TEMPLATE_VERSION}".`,
      );
    }
    return templateVersion;
  }

  private readContentSheets(workbook: Workbook): StagedRow[] {
    const staged: StagedRow[] = [];

    for (const schema of CONTENT_SHEETS) {
      const sheet = workbook.getWorksheet(schema.sheet);
      if (!sheet) continue; // a sheet with nothing to say for it is not an error

      const colIndexByName = this.readHeader(sheet, schema);
      const lastRowNumber = sheet.lastRow?.number ?? 1;

      for (let rowNumber = 2; rowNumber <= lastRowNumber; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const cells = new Map<string, string>();
        let allBlank = true;
        for (const col of schema.columns) {
          const idx = colIndexByName.get(col.name);
          const value = idx ? cellToString(row.getCell(idx).value) : '';
          if (value !== '') allBlank = false;
          cells.set(col.name, value);
        }
        if (allBlank) continue; // blank rows are skipped, not rejected

        const missing: string[] = [];
        const payload: Record<string, unknown> = {};
        for (const col of schema.columns) {
          const value = cells.get(col.name) ?? '';
          if (col.requiredCell && value === '') missing.push(col.name);
          if (col.multiValue) {
            payload[col.name] = value === '' ? [] : value.split(',').map((s) => s.trim()).filter(Boolean);
          } else if (col.boolean) {
            payload[col.name] = /^true$/i.test(value);
          } else {
            payload[col.name] = value;
          }
        }

        staged.push({
          sheet: schema.sheet,
          rowNumber,
          entityKind: schema.entityKind,
          payload,
          status: missing.length ? 'invalid' : 'parsed',
          message: missing.length
            ? `${schema.sheet} row ${rowNumber}: missing required value for "${missing.join('", "')}"`
            : null,
        });
      }
    }

    return staged;
  }

  /**
   * Header row must match the template's columns by name.
   *
   * An unknown column refuses the whole file and says which one, the same way
   * `additionalProperties: false` refuses an unrecognised field in the HTTP contracts.
   * A *missing* required column is the same failure by omission rather than addition —
   * without this, an absent required column falls through to the per-row blank-cell
   * check and produces one identical rejection per row instead of one sentence naming
   * the column nobody put in the header. A missing optional column is fine; its cells
   * simply read as blank.
   */
  private readHeader(sheet: Worksheet, schema: Pick<SheetSchema, 'sheet' | 'columns'>): Map<string, number> {
    const known = new Set(schema.columns.map((c) => c.name));
    const colIndexByName = new Map<string, number>();
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const name = cellToString(cell.value);
      if (!name) return;
      if (!known.has(name)) {
        throw new CatalogImportRefusal(`Unknown column "${name}" in sheet "${schema.sheet}".`);
      }
      colIndexByName.set(name, colNumber);
    });

    for (const col of schema.columns) {
      if (col.requiredCell && !colIndexByName.has(col.name)) {
        throw new CatalogImportRefusal(`Missing required column "${col.name}" in sheet "${schema.sheet}".`);
      }
    }

    return colIndexByName;
  }
}

/** Normalises whatever exceljs hands back for a cell into a trimmed string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return cellToString(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
    }
    if (value instanceof Date) return value.toISOString();
    if ('text' in v) return String(v.text).trim();
  }
  return String(value).trim();
}
