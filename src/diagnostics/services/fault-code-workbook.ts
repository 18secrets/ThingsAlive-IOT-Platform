import { Workbook } from 'exceljs';
import type { FaultCodeType } from '../entities/fault-code-type-grant.entity';

/**
 * The fault code workbook (fault code library, step 3): one row per code, one sheet per
 * upload, one kind of code per file.
 *
 * Columns are found by header text, as in the roster and fleet workbooks: the first thing
 * anybody does with a template is reorder it. A blank cell leaves that field as it is —
 * never "clear it" — so a sheet holding only the columns somebody meant to change cannot
 * wipe the rest of a code's text.
 */
export const CODES_SHEET = 'Codes';

/** API field → header, for each kind. The key columns come first. */
export const COLUMNS: Record<FaultCodeType, Record<string, string>> = {
  'motor-pump': {
    code: 'Code', description: 'Fault', symptom: 'Symptom', causes: 'Likely causes', remedies: 'What to do',
    detection: 'How detected', foundBy: 'Found by', severity: 'Severity', lamp: 'Lamp',
  },
  'vehicle-j1939': {
    spn: 'SPN', fmi: 'FMI', description: 'Fault', causes: 'Likely causes', remedies: 'What to do', severity: 'Severity', lamp: 'Lamp',
  },
  'vehicle-obd2': {
    code: 'Code', description: 'Fault', causes: 'Likely causes', remedies: 'What to do', severity: 'Severity', lamp: 'Lamp',
  },
};

/** Far above any real code list; a larger sheet is a mistake, not a library. */
export const MAX_CODE_ROWS = 2000;

export interface CodeRow {
  /** As Excel numbers it, header included. */
  row: number;
  /** Each column's text, blank as ''. */
  values: Record<string, string>;
}

/** The file as a whole is unreadable. A bad row is a row error, not this. */
export class CodeWorkbookRefusal extends Error {}

export async function parseCodeWorkbook(type: FaultCodeType, buffer: Buffer): Promise<CodeRow[]> {
  const workbook = new Workbook();
  try {
    // exceljs's typings shadow the global Buffer; same cast as the roster workbook.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new CodeWorkbookRefusal('This file is not an Excel workbook (.xlsx).');
  }
  const sheet = workbook.getWorksheet(CODES_SHEET);
  if (!sheet) throw new CodeWorkbookRefusal(`The workbook has no "${CODES_SHEET}" sheet. Start from the template.`);

  const columns = COLUMNS[type];
  const indexByField = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => {
    const text = cellText(cell.value).toLowerCase();
    for (const [field, title] of Object.entries(columns)) if (text === title.toLowerCase()) indexByField.set(field, col);
  });
  const keys = type === 'vehicle-j1939' ? ['spn', 'fmi'] : ['code'];
  const missing = keys.filter((k) => !indexByField.has(k));
  if (missing.length) {
    throw new CodeWorkbookRefusal(
      `The "${CODES_SHEET}" sheet has no ${missing.map((k) => `"${columns[k]}"`).join(' or ')} column. Is this the template for this kind of code?`,
    );
  }

  const rows: CodeRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    for (const field of Object.keys(columns)) {
      const col = indexByField.get(field);
      values[field] = col ? cellText(row.getCell(col).value) : '';
    }
    if (Object.values(values).every((v) => v === '')) return;
    rows.push({ row: rowNumber, values });
  });
  if (rows.length > MAX_CODE_ROWS) {
    throw new CodeWorkbookRefusal(`The sheet has ${rows.length} rows; one upload takes at most ${MAX_CODE_ROWS}.`);
  }
  return rows;
}

/**
 * One example row per kind, in the sheet's own words: real codes from the hardware
 * team's reference and the J1939 / OBD-II standards, to copy the shape from.
 */
export const EXAMPLE_ROW: Record<FaultCodeType, Record<string, string>> = {
  'motor-pump': {
    code: 'P103', description: 'Voltage fluctuation', symptom: 'Speed varies, repeated trips',
    causes: 'Unstable grid, loose neutral', remedies: 'Fit a stabiliser; check the neutral connection at the board',
    detection: 'Voltage varies strongly while logging', foundBy: 'Logger', severity: 'Warning', lamp: 'Amber warning',
  },
  'vehicle-j1939': {
    spn: '110', fmi: '0', description: 'Engine coolant temperature high', causes: 'Low coolant, blocked radiator, failed thermostat',
    remedies: 'Stop the engine; check coolant level and radiator', severity: 'Critical', lamp: 'Red stop',
  },
  'vehicle-obd2': {
    code: 'P0217', description: 'Engine overheat condition', causes: 'Low coolant, failed fan or thermostat',
    remedies: 'Stop the engine; check coolant and cooling fan', severity: 'Critical', lamp: 'Check engine',
  },
};

/**
 * The template: one example row to copy the shape from — not the library's codes. A
 * template full of codes reads as a backup to edit, and one stray change in it is a
 * change to the library (17 Nov). With it, a read-me naming every column and its values.
 */
export async function buildCodeTemplate(type: FaultCodeType): Promise<Buffer> {
  const columns = COLUMNS[type];
  const workbook = new Workbook();
  const readMe = workbook.addWorksheet('Read me');
  const key = type === 'vehicle-j1939'
    ? '  SPN, FMI       the J1939 code: whole numbers, FMI from 0 to 31. Together they name the code.'
    : type === 'vehicle-obd2'
      ? '  Code           an OBD-II code: a letter (P, C, B or U) and four characters, e.g. P0101.'
      : '  Code           P and three digits, e.g. P103. The first digit names the area of the pump set.';
  [
    `Fault codes: ${type}. One row per code.`,
    '',
    `${CODES_SHEET} sheet:`,
    key,
    '  Fault          the fault, as the card title reads it. Required for a new code.',
    ...(type === 'motor-pump' ? [
      '  Symptom        what the technician sees or hears at the pump.',
      '  How detected   the logger\'s rule, or the technician\'s test.',
      '  Found by       Logger or Technician.',
    ] : []),
    '  Likely causes, What to do   free text.',
    '  Severity       Critical, Warning, Medium, Low or Info.',
    '  Lamp           Red stop, Amber warning, Protect, Check engine or No lamp.',
    '',
    'The row in the sheet is an example: replace it with your codes, or delete it, before uploading.',
    'One row per code. A row for a code already in the library changes it; a new code is added.',
    'A blank cell leaves that field as it is. A code missing from the sheet is left alone, never deleted.',
    ...(type === 'motor-pump' ? [] : ['Codes from 1.0 are not in the sheet and cannot be changed here: they are edited in 1.0.']),
    'Check the file first: nothing is written until every row is valid.',
  ].forEach((line) => readMe.addRow([line]));
  readMe.getColumn(1).width = 110;

  const sheet = workbook.addWorksheet(CODES_SHEET);
  const fields = Object.keys(columns);
  sheet.addRow(fields.map((f) => columns[f]));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(fields.map((f) => EXAMPLE_ROW[type][f] ?? ''));
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF64748B' } };
  fields.forEach((f, i) => { sheet.getColumn(i + 1).width = ['spn', 'fmi', 'code', 'severity', 'lamp', 'foundBy'].includes(f) ? 14 : 40; });
  // exceljs returns its own Buffer type; it is a Node Buffer at runtime.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((r) => r.text).join('').trim();
    if (value instanceof Date) return value.toISOString();
  }
  return String(value).trim();
}
