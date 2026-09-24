/**
 * A unit system far short of a general one (task QCE1) — enough for the operator
 * table in `operator-registry.ts` and nothing more.
 *
 * A unit is base-unit symbols in numerator and denominator, plus a time exponent.
 * The symbols themselves are opaque strings — this never knows that a "MW" and a
 * "kW" are the same dimension at different scale, and never needs to: a formula
 * either names the same symbol on both sides of `+`/`-`, or it is refused. The time
 * exponent is kept separate from the symbol factors on purpose: it exists only to
 * represent what `integrate` (× hour) and `rate` (÷ hour) do, and every other
 * operator leaves it untouched. Folding "hour" into the general factors would make
 * it look like a signal's own unit could carry one, and no signal in this system
 * does — only an aggregation over time introduces it.
 */
export interface Unit {
  /** Symbol -> net exponent. A symbol with exponent 0 is never stored. */
  readonly factors: Readonly<Record<string, number>>;
  /** Net power of "hour", introduced only by `integrate` (+1) and `rate` (−1). */
  readonly timeExponent: number;
}

export const DIMENSIONLESS: Unit = Object.freeze({ factors: Object.freeze({}), timeExponent: 0 });

function normaliseFactors(factors: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(factors).sort()) {
    if (factors[key] !== 0) out[key] = factors[key];
  }
  return out;
}

function combine(a: Unit, b: Unit, sign: 1 | -1): Unit {
  const factors: Record<string, number> = { ...a.factors };
  for (const [symbol, exp] of Object.entries(b.factors)) {
    factors[symbol] = (factors[symbol] ?? 0) + sign * exp;
  }
  return { factors: normaliseFactors(factors), timeExponent: a.timeExponent + sign * b.timeExponent };
}

export const multiplyUnits = (a: Unit, b: Unit): Unit => combine(a, b, 1);
export const divideUnits = (a: Unit, b: Unit): Unit => combine(a, b, -1);

/** × hour — what `integrate` does to a series' unit (MW → MWh). */
export const multiplyByHour = (u: Unit): Unit => ({ factors: u.factors, timeExponent: u.timeExponent + 1 });
/** ÷ hour — what `rate` does to a series' unit. */
export const divideByHour = (u: Unit): Unit => ({ factors: u.factors, timeExponent: u.timeExponent - 1 });

export function unitsEqual(a: Unit, b: Unit): boolean {
  if (a.timeExponent !== b.timeExponent) return false;
  const aKeys = Object.keys(a.factors);
  const bKeys = Object.keys(b.factors);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a.factors[k] === b.factors[k]);
}

/**
 * Parses a unit string exactly as far as the two conventions this system needs to
 * recognise: `<base>h` for an hour-multiplied unit (`MWh`, `kWh` — the `integrate`
 * shape) and `<base>/h` for an hour-divided one (`L/h`, `%/h` — the `rate` shape).
 * Anything else is one opaque atomic symbol. This is a heuristic, not a grammar: a
 * genuine base unit that happens to end in a bare "h" for some other reason would be
 * misread, and none of the signals this platform knows about do.
 */
export function parseUnitString(raw: string | null | undefined): Unit {
  const s = (raw ?? '').trim();
  if (!s || /^(dimensionless|none|1)$/i.test(s)) return DIMENSIONLESS;

  const rate = /^(.+)\/h(?:r|our)?$/i.exec(s);
  if (rate) {
    const inner = parseUnitString(rate[1]);
    return { factors: inner.factors, timeExponent: inner.timeExponent - 1 };
  }

  const energy = /^(.+[A-Za-z%])h$/.exec(s);
  if (energy) {
    return { factors: normaliseFactors({ [energy[1]]: 1 }), timeExponent: 1 };
  }

  return { factors: normaliseFactors({ [s]: 1 }), timeExponent: 0 };
}

/**
 * Renders a `Unit` back to the same textual convention `parseUnitString` reads, so
 * a compiled `result_unit` and an author's `display_unit` can be compared and
 * reported in the same vocabulary. The `MWh`/`L per h` special cases exist only for
 * the single-symbol, no-denominator shape `integrate`/`rate` actually produce;
 * anything more exotic falls back to an explicit, unambiguous (if inelegant) form.
 */
export function renderUnit(u: Unit): string {
  const numerator = Object.entries(u.factors).filter(([, exp]) => exp > 0).sort(([a], [b]) => a.localeCompare(b));
  const denominator = Object.entries(u.factors).filter(([, exp]) => exp < 0).sort(([a], [b]) => a.localeCompare(b));

  if (!numerator.length && !denominator.length && u.timeExponent === 0) return 'dimensionless';

  if (u.timeExponent === 1 && numerator.length === 1 && numerator[0][1] === 1 && !denominator.length) {
    return `${numerator[0][0]}h`;
  }
  if (u.timeExponent === -1 && !denominator.length) {
    const num = numerator.map(([sym, exp]) => (exp === 1 ? sym : `${sym}^${exp}`)).join('·');
    return `${num || '1'}/h`;
  }

  const renderSide = (side: [string, number][]) =>
    side.map(([sym, exp]) => (Math.abs(exp) === 1 ? sym : `${sym}^${Math.abs(exp)}`)).join('·');
  let out = renderSide(numerator) || '1';
  if (denominator.length) out += `/${renderSide(denominator)}`;
  if (u.timeExponent > 0) out += `·h${u.timeExponent === 1 ? '' : `^${u.timeExponent}`}`;
  if (u.timeExponent < 0) out += `/h${u.timeExponent === -1 ? '' : `^${-u.timeExponent}`}`;
  return out;
}
