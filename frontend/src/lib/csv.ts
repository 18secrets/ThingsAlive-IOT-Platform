/**
 * CSV download of what a list is showing — the rows the viewer already has, after
 * their filters, so an export never reaches past what the server let them read.
 *
 * A cell starting with = + - @ (or a tab/CR) is prefixed with a quote: Excel and
 * Sheets otherwise run it as a formula, and a machine name or alert note is text
 * someone else typed. A UTF-8 BOM leads the file so Excel reads ₹, °C and the
 * Indian-language names as UTF-8 rather than the system code page.
 */
export type CsvCell = string | number | boolean | null | undefined;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(name: string, headers: string[], rows: CsvCell[][]): void {
  const blob = new Blob(['﻿', toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
