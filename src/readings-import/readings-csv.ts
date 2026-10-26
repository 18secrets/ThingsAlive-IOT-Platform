/**
 * The historical-readings CSV, parsed and checked with no database (task QIMPORT-READINGS).
 * Kept apart from the service so the rules can be tested line by line, and so the plan
 * and the apply cannot judge the same file two ways.
 */

export const REQUIRED_COLUMNS = ['timestamp', 'sensor', 'value'] as const;
export const OPTIONAL_COLUMNS = ['unit'] as const;

/** Past this, a file is refused before a row is read: one machine's history fits well inside it. */
export const MAX_ROWS = 500_000;
/** How far ahead of the server clock a reading may be dated: logger clocks drift, not by hours. */
export const FUTURE_SKEW_MS = 5 * 60_000;
/** Line-level refusals listed in full; the rest are counted by reason. */
export const MAX_LISTED_REFUSALS = 200;

export type RefusalReason =
  | 'missing_field' | 'bad_timestamp' | 'timestamp_without_zone' | 'in_the_future' | 'older_than_backfill_limit'
  | 'not_a_number' | 'unknown_sensor' | 'no_binding_at_time' | 'unit_mismatch' | 'duplicate_in_file';

export interface RowRefusal { line: number; reason: RefusalReason; detail: string }

export interface CsvRow { line: number; timestamp: string; sensor: string; value: string; unit: string | null }

export class ReadingsCsvRefusal extends Error {}

/**
 * RFC 4180 as spreadsheets write it: commas, double-quoted fields with "" for a quote,
 * CRLF or LF, an optional byte-order mark. Written here rather than added as a package,
 * because four columns of numbers and names do not need one.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (quoted) throw new ReadingsCsvRefusal('The file ends inside a quoted field: a quote is not closed.');
  return rows;
}

/** Header by name, in any order and any case; a missing required column refuses the file. */
export function readRows(text: string): CsvRow[] {
  // Line numbers as a spreadsheet shows them, header = line 1, counted before blank
  // lines are dropped so a refusal points at the line the person will look at.
  const table = parseCsv(text).map((r, i) => ({ r, line: i + 1 })).filter(({ r }) => r.some((f) => f.trim() !== ''));
  if (!table.length) throw new ReadingsCsvRefusal('The file is empty.');
  const header = table[0].r.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ReadingsCsvRefusal(`Missing column(s): ${missing.join(', ')}. The header must be `
      + `${[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(',')} (unit optional).`);
  }
  if (table.length - 1 > MAX_ROWS) {
    throw new ReadingsCsvRefusal(`${table.length - 1} rows; one upload takes at most ${MAX_ROWS}. Split the file by date.`);
  }
  const at = (name: string) => header.indexOf(name);
  const cell = (r: string[], name: string) => (at(name) >= 0 ? (r[at(name)] ?? '').trim() : '');
  return table.slice(1).map(({ r, line }) => ({
    line, timestamp: cell(r, 'timestamp'), sensor: cell(r, 'sensor'), value: cell(r, 'value'), unit: cell(r, 'unit') || null,
  }));
}

/**
 * An instant, or nothing. A timestamp with no zone is refused, not read as UTC or as the
 * server's zone: either guess shifts a whole history by hours, which moves every reading
 * into or out of a shift and so into or out of every operating-hours baseline.
 */
export function parseInstant(s: string): { at: Date } | { reason: 'bad_timestamp' | 'timestamp_without_zone' } {
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!iso) return { reason: 'bad_timestamp' };
  if (!iso[3]) return { reason: 'timestamp_without_zone' };
  // Date.parse wants the T, an upper-case Z and a colon in the offset; spreadsheets write all three ways.
  const at = new Date(s.replace(' ', 'T').replace(/z$/, 'Z').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(at.getTime()) ? { reason: 'bad_timestamp' } : { at };
}

/** A finite number; '' and 'NaN' are not readings. */
export function parseValue(s: string): number | null {
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Units compared as written, ignoring case and spacing: the platform does not convert here. */
export const sameUnit = (a: string, b: string) => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
