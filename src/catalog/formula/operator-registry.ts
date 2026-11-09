import { divideByHour, DIMENSIONLESS, multiplyByHour, Unit } from './units';

/** `'state'` (task QCAT1): a quoted categorical state, resolved to its code at publish.
 * `'zone'` (task QGEO2): a quoted geofence zone code, resolved per machine at evaluation —
 * zones belong to the account and apply per machine, so publish cannot know them. */
export type ArgKind = 'series' | 'scalar' | 'duration' | 'state' | 'zone' | 'curve_column';

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
  /** Reads the machine's site boundary (task QGEO1); the evaluator supplies it, and a
   * machine with none is `not_configured` rather than "inside". */
  needsSiteBoundary?: boolean;
  /** Reads one of the machine's geofence zones by code (task QGEO2); a code that does not
   * apply to the machine is `not_configured`, never "outside". */
  needsZone?: boolean;
  /** Reads the duty curve of the machine's model (D58); a machine whose model has none,
   * or which names no model, is `not_configured`. */
  needsCurve?: boolean;
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
  // The average of a rate while the machine is operating (fuel test report FU-4): litres
  // over running hours, not the mean of every reading in the window. `avg` of a fuel rate
  // moved with how long the machine stood parked inside the window and disagreed with
  // Production's litres ÷ hours. Operating is Availability's definition: inside a shift,
  // engine on. Same unit as its argument.
  avg_while_operating: {
    name: 'avg_while_operating', argKinds: ['series'], resultKind: 'scalar',
    unitRule: ([u]) => u,
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

  // ------------------------------------------------------------- QCAT1
  // Categorical signals: the series carries state codes, and each of these reads it
  // as a step function — a reading's state holds until the next one. Time, not
  // samples: a machine that reports more often while working must not look busier.
  fraction_in_state: {
    name: 'fraction_in_state', argKinds: ['series', 'state'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
  transitions: {
    name: 'transitions', argKinds: ['series', 'state', 'state'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
  dwell_in_state: {
    name: 'dwell_in_state', argKinds: ['series', 'state'], resultKind: 'scalar',
    unitRule: () => multiplyByHour(DIMENSIONLESS),
  },

  // -------------------------------------------------------------- QGEO1
  // (latitude, longitude) against the machine's own site boundary.
  outside_site: {
    name: 'outside_site', argKinds: ['series', 'series'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS, needsSiteBoundary: true,
  },
  fraction_outside_site: {
    name: 'fraction_outside_site', argKinds: ['series', 'series'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS, needsSiteBoundary: true,
  },

  // -------------------------------------------------------------- QGEO2
  // (latitude, longitude, 'ZONE') against one of the machine's geofence zones, by code.
  outside_zone: {
    name: 'outside_zone', argKinds: ['series', 'series', 'zone'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS, needsZone: true,
  },
  fraction_in_zone: {
    name: 'fraction_in_zone', argKinds: ['series', 'series', 'zone'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS, needsZone: true,
  },
  time_in_zone: {
    name: 'time_in_zone', argKinds: ['series', 'series', 'zone'], resultKind: 'scalar',
    unitRule: () => multiplyByHour(DIMENSIONLESS), needsZone: true,
  },

  // ----------------------------------------------------------- QSCAL1
  // Scalar functions over values a formula has already reduced. They are what pump and
  // motor physics needs once every threshold is a ratio to a rated value: "running" is
  // two comparisons that must both hold, a speed estimate is clamped at synchronous
  // speed, a health score is deductions capped at their band. Every argument is a
  // scalar, never a series: apply `avg`/`last`/... to a signal first. A series here
  // would have to be combined point by point, and two signals' readings do not share
  // timestamps (the same reason a reducer's series argument must be a signal by name).
  //
  // `min`/`max` were already the series reducers, so the two-value forms are
  // `least`/`greatest` (SQL's spelling), not an arity overload of the same name. One
  // name meaning two things would read differently depending on whether a comma follows.
  //
  // Unit rules here are the simple case only. Literal polymorphism (`least(x, 100)`) and
  // the "condition must be dimensionless" check need to know which argument was a bare
  // literal, which a unit list cannot say, so the compiler applies those by name.
  abs: {
    name: 'abs', argKinds: ['scalar'], resultKind: 'scalar',
    unitRule: ([u]) => u,
  },
  least: {
    name: 'least', argKinds: ['scalar', 'scalar'], resultKind: 'scalar',
    unitRule: ([u]) => u,
  },
  greatest: {
    name: 'greatest', argKinds: ['scalar', 'scalar'], resultKind: 'scalar',
    unitRule: ([u]) => u,
  },
  clamp: {
    name: 'clamp', argKinds: ['scalar', 'scalar', 'scalar'], resultKind: 'scalar',
    unitRule: ([u]) => u,
  },
  // Conditions are dimensionless and true when non-zero, which is what a comparison
  // (1 or 0) already produces. Two-argument forms nest for more conditions.
  and: {
    name: 'and', argKinds: ['scalar', 'scalar'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
  or: {
    name: 'or', argKinds: ['scalar', 'scalar'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS,
  },
  if: {
    name: 'if', argKinds: ['scalar', 'scalar', 'scalar'], resultKind: 'scalar',
    unitRule: ([, u]) => u,
  },

  // ------------------------------------------------------------- D58
  // `curve_at('flow_lpm', 'input_kw', avg(input_power))`: one column of the machine's
  // model's duty curve, read at a value of another, linearly between printed points.
  // The result carries the read column's unit, and the value must carry the other's;
  // the compiler applies both, since they depend on which columns were named.
  curve_at: {
    name: 'curve_at', argKinds: ['curve_column', 'curve_column', 'scalar'], resultKind: 'scalar',
    unitRule: () => DIMENSIONLESS, needsCurve: true,
  },
});

/** The duty curve's columns (D58): a code the executor indexes by, and a fixed unit. */
export const CURVE_COLUMNS: Readonly<Record<string, { code: number; unit: string }>> = Object.freeze({
  head_m: { code: 0, unit: 'm' },
  flow_lpm: { code: 1, unit: 'L/min' },
  input_kw: { code: 2, unit: 'kW' },
});

/** The QSCAL1 functions: every argument is a value the formula already holds, so a
 * series argument gets a refusal that says how to reduce it, not just "wrong kind". */
export const SCALAR_FUNCTION_NAMES: ReadonlySet<string> = new Set(
  ['abs', 'least', 'greatest', 'clamp', 'and', 'or', 'if'],
);

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
