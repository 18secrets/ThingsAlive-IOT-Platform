import { divideByHour, DIMENSIONLESS, multiplyByHour, Unit } from './units';

export type ArgKind = 'series' | 'scalar' | 'duration';

export interface OperatorEntry {
  name: string;
  /** One entry per argument, in order — its length is the function's arity. Every
   * function in this table takes its primary argument as a series: this is an
   * aggregation registry, not a general function library. `'duration'` is a window
   * argument — a literal like `90d`/`24h`, never a `@param` or computed value (task
   * QCE4): a baseline window is part of the formula's shape, not a tenant setting. */
  argKinds: ArgKind[];
  /** `avg`/`min`/`sum`/etc. reduce a whole series to one scalar. The baseline
   * operators (task QCE4) do not: `baseline_avg(series, window)` is itself a
   * trailing, time-indexed value — still a series, same as the signal it reads. */
  resultKind: 'scalar' | 'series';
  unitRule: (argUnits: Unit[]) => Unit;
}

/**
 * The closed vocabulary (task QCE1) — adding a function here is a deploy, and that
 * is deliberate (the FPGA principle: operators are code, compositions are rows).
 * Both the parser (to know an identifier-then-`(` is a call at all) and the
 * compiler (arity, argument kinds, unit) read this single table; neither hard-codes
 * a function name.
 */
export const OPERATOR_REGISTRY: Readonly<Record<string, OperatorEntry>> = Object.freeze({
  avg: unaryAggregate('avg'),
  min: unaryAggregate('min'),
  max: unaryAggregate('max'),
  first: unaryAggregate('first'),
  last: unaryAggregate('last'),
  sum: unaryAggregate('sum'),
  delta: unaryAggregate('delta'),
  count: {
    name: 'count', argKinds: ['series'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
  integrate: {
    name: 'integrate', argKinds: ['series'], resultKind: 'scalar',
    unitRule: ([u]) => multiplyByHour(u),
  },
  rate: {
    name: 'rate', argKinds: ['series'], resultKind: 'scalar',
    unitRule: ([u]) => divideByHour(u),
  },
  fraction_within: {
    name: 'fraction_within', argKinds: ['series', 'scalar', 'scalar'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },

  // --------------------------------------------------------- baseline operators (QCE4)
  // A rolling comparison against the machine's own recent history — the structural
  // gap `itdc-coverage-analysis.md` §3 names: D34 compares a signal to a fixed
  // threshold, and nothing before this could say "versus its last 90 days". Unlike
  // every operator above, these do not reduce a series to a scalar for the whole
  // formula evaluation — `baseline_avg` at time t is the trailing mean up to t, so
  // the result is still itself a series. The current period is excluded from its own
  // baseline (the actual windowing arithmetic is QCE2's job; the shape of that
  // exclusion is in `baseline-operators.ts`, exercised at the plan level here).
  baseline_avg: {
    name: 'baseline_avg', argKinds: ['series', 'duration'], resultKind: 'series',
    unitRule: ([u]) => u,
  },
  baseline_sd: {
    name: 'baseline_sd', argKinds: ['series', 'duration'], resultKind: 'series',
    unitRule: ([u]) => u,
  },
  // Dimensionless even though its argument carries a unit: (current − baseline) /
  // baseline_sd is a ratio of two quantities in the same unit, so the unit cancels.
  // A threshold rule written against a `zscore` must not be unit-checked against the
  // source signal — this is the one place QCE4's own task doc insists the compiler
  // get right.
  zscore: {
    name: 'zscore', argKinds: ['series', 'duration'], resultKind: 'series',
    unitRule: () => DIMENSIONLESS,
  },
  // mean(w1) ÷ mean(w2) — the 7-day-vs-90-day shape. Same cancellation as zscore.
  delta_ratio: {
    name: 'delta_ratio', argKinds: ['series', 'duration', 'duration'], resultKind: 'series',
    unitRule: () => DIMENSIONLESS,
  },

  // ------------------------------------------------------------- QCE5
  // Readings strictly above a threshold — the `>` of a comparison, as a count. What
  // "how many times did coolant run over 105" needs, which `count(x > 105)` cannot say.
  count_exceeding: {
    name: 'count_exceeding', argKinds: ['series', 'scalar'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
});

function unaryAggregate(name: string): OperatorEntry {
  return {
    name, argKinds: ['series'], resultKind: 'scalar',
    // avg/min/max/first/last/sum/delta: the series' own unit, unchanged.
    unitRule: ([u]) => u,
  };
}

export function lookupOperator(name: string): OperatorEntry | undefined {
  return OPERATOR_REGISTRY[name];
}
