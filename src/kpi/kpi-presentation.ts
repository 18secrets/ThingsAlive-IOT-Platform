import { KpiEnvelope } from './types';

/** No value leaves the API with more decimals than this, whatever a formula declares. */
export const MAX_DISPLAY_DECIMALS = 2;

/**
 * The decimals a formula's `display_format` asks for (`number:N`), capped at two. A
 * format that is missing or not `number:N` gets the cap: a value nobody chose a
 * precision for is still not shown as 62.48535053145343.
 */
export function displayDecimals(displayFormat?: string | null): number {
  const m = /^number:(\d+)$/.exec(displayFormat ?? '');
  return m ? Math.min(MAX_DISPLAY_DECIMALS, Number(m[1])) : MAX_DISPLAY_DECIMALS;
}

/**
 * Half away from zero, as a person rounds: -0.465 → -0.47, not -0.46. Shifted by the
 * exponent rather than multiplied, because 1.005 × 100 is 100.49999… in binary and
 * would show a value somebody reads as 1.005 as 1.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const abs = String(Math.abs(value));
  // Already in exponent form (1e-7, 1.23e+21): far below or above two decimals' reach.
  const r = abs.includes('e')
    ? Math.sign(value) * Math.round(Math.abs(value) * 10 ** decimals) / 10 ** decimals
    : Math.sign(value) * Number(`${Math.round(Number(`${abs}e${decimals}`))}e-${decimals}`);
  return Object.is(r, -0) ? 0 : r;
}

/**
 * An envelope as it is shown: the value, or each point of a series, rounded to the
 * formula's display precision. Applied where a KPI leaves the API (the KPI routes and
 * the page's KPI widgets) and nowhere inside: a ratio, a site aggregate or an alert
 * computed from a rounded KPI would carry the rounding into its own answer. Coverage
 * is a count and a ratio of counts, left as it is.
 */
export function presentEnvelope<T extends KpiEnvelope>(envelope: T, displayFormat?: string | null): T {
  const d = displayDecimals(displayFormat);
  const { value } = envelope;
  if (typeof value === 'number') return { ...envelope, value: roundTo(value, d) };
  if (Array.isArray(value)) {
    return { ...envelope, value: value.map((p) => ({ ...p, v: p.v === null ? null : roundTo(p.v, d) })) };
  }
  return envelope;
}
