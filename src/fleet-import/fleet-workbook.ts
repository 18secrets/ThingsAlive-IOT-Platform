import { Workbook, Worksheet } from 'exceljs';

/**
 * The fleet workbook: equipment and the loggers fitted to it, one row each.
 *
 * Columns are found by header text, not by position. A customer's own spreadsheet is
 * where these rows usually come from, and the first thing anyone does with a template
 * is reorder it; a parser that reads column C as "Name" would then import serial
 * numbers as names without a single error.
 */
export const EQUIPMENT_SHEET = 'Equipment';
export const DEVICES_SHEET = 'Devices';

export const EQUIPMENT_COLUMNS = {
  code: 'Code',
  name: 'Name',
  site: 'Site code',
  classSlug: 'Class slug',
  manufacturer: 'Manufacturer',
  modelNumber: 'Model number',
  serialNumber: 'Serial number',
  description: 'Description',
  commissionedAt: 'Commissioned (YYYY-MM-DD)',
  serviceIntervalHours: 'Service interval (hours)',
} as const;

export const DEVICE_COLUMNS = {
  imei: 'IMEI',
  equipmentCode: 'Equipment code',
  sourceSystem: 'Source system',
} as const;

const REQUIRED_EQUIPMENT: (keyof typeof EQUIPMENT_COLUMNS)[] = ['code', 'name'];
const REQUIRED_DEVICE: (keyof typeof DEVICE_COLUMNS)[] = ['imei', 'equipmentCode'];

/**
 * The same ceiling as `POST /inventory/register`. A fleet larger than this is a
 * migration, and a migration wants a job with progress and a resume point rather than
 * one request that times out with half of it written.
 */
export const MAX_ROWS_PER_SHEET = 500;

export type EquipmentField = keyof typeof EQUIPMENT_COLUMNS;
export type DeviceField = keyof typeof DEVICE_COLUMNS;

export interface WorkbookRow<F extends string> {
  /** As the person sees it in Excel, header included, so "row 7" means row 7. */
  row: number;
  values: Record<F, string>;
}

export interface ParsedFleetWorkbook {
  equipment: WorkbookRow<EquipmentField>[];
  devices: WorkbookRow<DeviceField>[];
}

/** The workbook as a whole is unreadable. A bad row is not this; it is a row error. */
export class FleetWorkbookRefusal extends Error {}

export async function parseFleetWorkbook(buffer: Buffer): Promise<ParsedFleetWorkbook> {
  const workbook = new Workbook();
  try {
    // exceljs's typings shadow the global Buffer with a non-generic one; same cast as
    // WorkbookParserService.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new FleetWorkbookRefusal('This file is not an Excel workbook (.xlsx).');
  }

  const equipmentSheet = workbook.getWorksheet(EQUIPMENT_SHEET);
  const devicesSheet = workbook.getWorksheet(DEVICES_SHEET);
  if (!equipmentSheet && !devicesSheet) {
    throw new FleetWorkbookRefusal(
      `The workbook has neither an "${EQUIPMENT_SHEET}" nor a "${DEVICES_SHEET}" sheet. Start from the template.`,
    );
  }
  return {
    equipment: equipmentSheet ? readSheet(equipmentSheet, EQUIPMENT_COLUMNS, REQUIRED_EQUIPMENT) : [],
    devices: devicesSheet ? readSheet(devicesSheet, DEVICE_COLUMNS, REQUIRED_DEVICE) : [],
  };
}

function readSheet<F extends string>(
  sheet: Worksheet, columns: Record<F, string>, required: F[],
): WorkbookRow<F>[] {
  const header = sheet.getRow(1);
  const indexByField = new Map<F, number>();
  header.eachCell((cell, col) => {
    const text = cellToString(cell.value).toLowerCase();
    for (const [field, title] of Object.entries(columns) as [F, string][]) {
      if (text === title.toLowerCase()) indexByField.set(field, col);
    }
  });
  const missing = required.filter((f) => !indexByField.has(f));
  if (missing.length) {
    throw new FleetWorkbookRefusal(
      `The "${sheet.name}" sheet has no ${missing.map((f) => `"${columns[f]}"`).join(' or ')} column.`,
    );
  }

  const rows: WorkbookRow<F>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {} as Record<F, string>;
    for (const field of Object.keys(columns) as F[]) {
      const col = indexByField.get(field);
      values[field] = col ? cellToString(row.getCell(col).value) : '';
    }
    // A row someone cleared rather than deleted still exists to exceljs. Empty is not
    // an error; it is nothing.
    if (Object.values(values).every((v) => v === '')) return;
    rows.push({ row: rowNumber, values });
  });
  if (rows.length > MAX_ROWS_PER_SHEET) {
    throw new FleetWorkbookRefusal(
      `The "${sheet.name}" sheet has ${rows.length} rows; one upload takes at most ${MAX_ROWS_PER_SHEET}. Split it.`,
    );
  }
  return rows;
}

/** An empty template with both sheets, their headers and a short read-me. */
export async function buildFleetTemplate(): Promise<Buffer> {
  const workbook = new Workbook();
  const readMe = workbook.addWorksheet('Read me');
  [
    'Fleet import: equipment, and the loggers fitted to it.',
    '',
    `${EQUIPMENT_SHEET}: one row per machine. Code and Name are required. Code is letters, digits, dots,`,
    'hyphens or underscores, and becomes part of the machine\'s identity: it is not changed later.',
    'Site code must be a site already set up in this account.',
    '',
    `${DEVICES_SHEET}: one row per logger. The logger must already be assigned to this account.`,
    'Equipment code is a machine in this workbook or already in the register. Leave Source system',
    'empty for machines created in 2.0; give it for machines adopted from IoT Platform 1.0.',
    '',
    'Uploading only adds. A machine or logger that already exists differently is listed as a conflict',
    'and left as it is. Uploading the same workbook twice changes nothing the second time.',
  ].forEach((line) => readMe.addRow([line]));
  readMe.getColumn(1).width = 100;

  for (const [name, columns] of [[EQUIPMENT_SHEET, EQUIPMENT_COLUMNS], [DEVICES_SHEET, DEVICE_COLUMNS]] as const) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(Object.values(columns));
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((c) => { c.width = 24; });
  }
  // Same exceljs Buffer mismatch as the load above.
  return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

/** Whatever exceljs hands back for a cell, as a trimmed string. Dates become YYYY-MM-DD. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return cellToString(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
    }
    if ('text' in v) return String(v.text).trim();
  }
  return String(value).trim();
}
