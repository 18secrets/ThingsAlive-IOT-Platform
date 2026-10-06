import {
  alertExcludedRanges, baselineAvg, baselineSd, BaselineValue, deltaRatio, ExcludedRange, Reading, zscore,
} from './baseline-operators';

/** Everything an aggregate executor needs: the series restricted to the
 * evaluation window, and (for the baseline family) the full history available
 * before it plus the dirty-window ranges to exclude — see `baseline-operators.ts`. */
export interface ExecContext {
  windowFrom: Date;
  windowTo: Date;
  /** Readings available before `windowTo`, unbounded on the early side — the
   * baseline operators need lookback the display window itself does not cover. */
  history: Reading[];
  excludedRanges: ExcludedRange[];
}

export type ExecValue =
  | { ok: true; value: number }
  | { ok: false; reason: 'no_readings' | 'undefined_result' | 'baseline_not_established' };

export interface ExecutorEntry {
  /** `args[i]` is a resolved series (window-bounded readings) for a `'series'`
   * argKind, a plain number for `'scalar'`, and `args[i]` is skipped entirely for
   * `'duration'` — durations are read straight off the plan node's own `hours`
   * field, which the four callers below do themselves. */
  run: (seriesArgs: Reading[][], scalarArgs: number[], durationHours: number[], ctx: ExecContext) => ExecValue;
}

const NO_READINGS: ExecValue = { ok: false, reason: 'no_readings' };
const UNDEFINED_RESULT: ExecValue = { ok: false, reason: 'undefined_result' };

const windowed = (series: Reading[], from: Date, to: Date): Reading[] =>
  series.filter((r) => r.at >= from && r.at <= to);

function reduceUnary(name: string, fn: (values: number[]) => number): ExecutorEntry {
  return {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (!rows.length) return NO_READINGS;
      return { ok: true, value: fn(rows.map((r) => r.value)) };
    },
  };
}

function toExec(result: BaselineValue): ExecValue {
  if (result.established === false) return { ok: false, reason: result.reason };
  if (!Number.isFinite(result.value)) return UNDEFINED_RESULT;
  return { ok: true, value: result.value };
}

/**
 * One executor per operator in `OPERATOR_REGISTRY` — a closed registry, same
 * reason the compiler's own table is closed (task QCE2). `test/executor-
 * registry.spec.ts` asserts the key sets match exactly, so an operator added to
 * one without the other fails the build rather than silently returning nothing
 * at runtime.
 */
export const EXECUTOR_REGISTRY: Readonly<Record<string, ExecutorEntry>> = Object.freeze({
  avg: reduceUnary('avg', (vs) => vs.reduce((a, b) => a + b, 0) / vs.length),
  min: reduceUnary('min', (vs) => Math.min(...vs)),
  max: reduceUnary('max', (vs) => Math.max(...vs)),
  first: {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      return rows.length ? { ok: true, value: rows[0].value } : NO_READINGS;
    },
  },
  last: {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      return rows.length ? { ok: true, value: rows[rows.length - 1].value } : NO_READINGS;
    },
  },
  sum: reduceUnary('sum', (vs) => vs.reduce((a, b) => a + b, 0)),
  // Last reading minus first, in window order — the series' own unit, same as
  // the compiler's unitRule for it.
  delta: {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (!rows.length) return NO_READINGS;
      return { ok: true, value: rows[rows.length - 1].value - rows[0].value };
    },
  },
  count: {
    run: ([series], _s, _d, ctx) => ({ ok: true, value: windowed(series, ctx.windowFrom, ctx.windowTo).length }),
  },
  // Trapezoidal over consecutive readings, hours since source_timestamp is the
  // series' native unit — matches `unitRule: multiplyByHour`.
  integrate: {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (rows.length < 2) return NO_READINGS;
      let total = 0;
      for (let i = 1; i < rows.length; i += 1) {
        const hours = (rows[i].at.getTime() - rows[i - 1].at.getTime()) / 3_600_000;
        total += ((rows[i].value + rows[i - 1].value) / 2) * hours;
      }
      return { ok: true, value: total };
    },
  },
  // Net change over elapsed hours — matches `unitRule: divideByHour`.
  rate: {
    run: ([series], _s, _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (rows.length < 2) return NO_READINGS;
      const hours = (rows[rows.length - 1].at.getTime() - rows[0].at.getTime()) / 3_600_000;
      if (hours === 0) return UNDEFINED_RESULT;
      return { ok: true, value: (rows[rows.length - 1].value - rows[0].value) / hours };
    },
  },
  fraction_within: {
    run: ([series], [lo, hi], _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (!rows.length) return NO_READINGS;
      const within = rows.filter((r) => r.value >= lo && r.value <= hi).length;
      return { ok: true, value: within / rows.length };
    },
  },

  // ----------------------------------------------------------- baseline family (QCE4)
  // Evaluated once, at the window's latest instant — not as a per-point rolling
  // series. A true rolling series (one baseline per raw reading) needs a
  // materialised read path; QCE2 explicitly scopes that out ("caching or
  // materialising results"), so `resultKind: 'series'` here means "a live value
  // for a time-varying quantity", not "one point per reading". Reported as a
  // scoping decision, not a silent narrowing.
  baseline_avg: {
    run: ([series], _s, [hours], ctx) =>
      toExec(baselineAvg(series, ctx.windowTo, hours, ctx.excludedRanges)),
  },
  baseline_sd: {
    run: ([series], _s, [hours], ctx) =>
      toExec(baselineSd(series, ctx.windowTo, hours, ctx.excludedRanges)),
  },
  zscore: {
    run: ([series], _s, [hours], ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      const current = rows.length ? rows[rows.length - 1].value : null;
      if (current === null) return NO_READINGS;
      return toExec(zscore(current, series, ctx.windowTo, hours, ctx.excludedRanges));
    },
  },
  delta_ratio: {
    run: ([series], _s, [w1, w2], ctx) =>
      toExec(deltaRatio(series, ctx.windowTo, w1, w2, ctx.excludedRanges)),
  },

  // ------------------------------------------------------------------------ QCE5
  // No readings is `no_readings`, unlike `count`'s 0: "nothing exceeded" is a claim
  // about readings, and zero exceedances of nothing is not evidence of anything.
  count_exceeding: {
    run: ([series], [threshold], _d, ctx) => {
      const rows = windowed(series, ctx.windowFrom, ctx.windowTo);
      if (!rows.length) return NO_READINGS;
      return { ok: true, value: rows.filter((r) => r.value > threshold).length };
    },
  },
});

export function lookupExecutor(name: string): ExecutorEntry | undefined {
  return EXECUTOR_REGISTRY[name];
}

/** Dirty-window exclusion ranges for one (tenant, signal) over a history span —
 * thin wrapper so the evaluator does not need to know `baseline-operators.ts`'s
 * two builder shapes itself. Work-order ranges are machine-wide (no `signal`
 * column on `work_order`; see that module's own comment) so they are passed in
 * already merged with the alert ranges for this signal. */
export { alertExcludedRanges };
