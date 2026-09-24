import { divideByHour, DIMENSIONLESS, multiplyByHour, Unit } from './units';

export type ArgKind = 'series' | 'scalar';

export interface OperatorEntry {
  name: string;
  /** One entry per argument, in order — its length is the function's arity. Every
   * function in this table takes its primary argument as a series: this is an
   * aggregation registry, not a general function library. */
  argKinds: ArgKind[];
  /** The result is always a scalar — every one of these reduces a series. */
  resultKind: 'scalar';
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
