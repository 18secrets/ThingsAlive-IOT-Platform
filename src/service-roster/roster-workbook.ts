import { Workbook } from 'exceljs';

/**
 * The roster workbook (U5): one row per engineer per region.
 *
 * Columns are found by header text, as in the fleet workbook: the first thing anybody
 * does with a template is reorder it. A region's name and sites are read from whichever
 * of its rows carry them, so a sheet can name them once and leave them blank below.
 */
export const ROSTER_SHEET = 'Roster';

export const ROSTER_COLUMNS = {
  regionCode: 'Region code',
  regionName: 'Region name',
  siteCodes: 'Site codes',
  engineerEmail: 'Engineer email',
  rank: 'Rank',
} as const;

export type RosterField = keyof typeof ROSTER_COLUMNS;

export interface RosterRow {
  /** As Excel numbers it, header included. */
  row: number;
  values: Record<RosterField, string>;
}

/** Far above any real roster; a sheet larger than this is a mistake, not a roster. */
export const MAX_ROSTER_ROWS = 1000;

/** The file as a whole is unreadable. A bad row is a row error, not this. */
export class RosterWorkbookRefusal extends Error {}

export async function parseRosterWorkbook(buffer: Buffer): Promise<RosterRow[]> {
  const workbook = new Workbook();
  try {
    // exceljs's typings shadow the global Buffer; same cast as the fleet workbook.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new RosterWorkbookRefusal('This file is not an Excel workbook (.xlsx).');
  }
  const sheet = workbook.getWorksheet(ROSTER_SHEET);
  if (!sheet) throw new RosterWorkbookRefusal(`The workbook has no "${ROSTER_SHEET}" sheet. Start from the template.`);

  const indexByField = new Map<RosterField, number>();
  sheet.getRow(1).eachCell((cell, col) => {
    const text = cellText(cell.value).toLowerCase();
    for (const [field, title] of Object.entries(ROSTER_COLUMNS) as [RosterField, string][]) {
      if (text === title.toLowerCase()) indexByField.set(field, col);
    }
  });
  const missing = (['regionCode'] as RosterField[]).filter((f) => !indexByField.has(f));
  if (missing.length) {
    throw new RosterWorkbookRefusal(`The "${ROSTER_SHEET}" sheet has no "${ROSTER_COLUMNS.regionCode}" column.`);
  }

  const rows: RosterRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {} as Record<RosterField, string>;
    for (const field of Object.keys(ROSTER_COLUMNS) as RosterField[]) {
      const col = indexByField.get(field);
      values[field] = col ? cellText(row.getCell(col).value) : '';
    }
    if (Object.values(values).every((v) => v === '')) return;
    rows.push({ row: rowNumber, values });
  });
  if (rows.length > MAX_ROSTER_ROWS) {
    throw new RosterWorkbookRefusal(`The sheet has ${rows.length} rows; one upload takes at most ${MAX_ROSTER_ROWS}.`);
  }
  return rows;
}

/** The empty roster, with a read-me and one example region to copy the shape from. */
export async function buildRosterTemplate(): Promise<Buffer> {
  const workbook = new Workbook();
  const readMe = workbook.addWorksheet('Read me');
  [
    'Service roster: who a job on a machine goes to.',
    '',
    `${ROSTER_SHEET}: one row per engineer per region.`,
    '  Region code    letters, digits, - and _ (e.g. PUNE-W). Required on every row.',
    '  Region name    once per region is enough.',
    '  Site codes     the sites in the region, comma-separated, as on the Sites page. Once per region is enough.',
    '                 A site can be in one region only.',
    '  Engineer email a user of this account. Rank 1 gets the job; 2 and below cover when 1 is suspended.',
    '  Rank           1, 2, 3 ... Left blank, the engineer takes the next rank in that region.',
    '',
    'Uploading replaces the whole roster: a region not in the file is removed.',
    'Check first with "Check file" — nothing is written until every row is valid.',
    'Delete the example rows before uploading.',
  ].forEach((line) => readMe.addRow([line]));
  readMe.getColumn(1).width = 110;

  const sheet = workbook.addWorksheet(ROSTER_SHEET);
  sheet.addRow(Object.values(ROSTER_COLUMNS));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(['PUNE-W', 'Pune West', 'SITE-01, SITE-02', 'engineer.one@example.com', 1]);
  sheet.addRow(['PUNE-W', '', '', 'engineer.two@example.com', 2]);
  [14, 24, 30, 34, 8].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  // exceljs returns its own Buffer type; it is a Node Buffer at runtime.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
    // An email typed into Excel becomes a hyperlink cell: { text, hyperlink }.
    if ('text' in v) return cellText(v.text);
  }
  return String(value).trim();
}
