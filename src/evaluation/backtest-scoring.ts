/**
 * The arithmetic of the TTM backtest (QEVAL1 §2), apart from the database so the tests
 * can check it against numbers worked by hand.
 *
 * A forecast step is scored only when all three things it is compared on exist: the
 * actual, the persistence origin and the seasonal actual. Scoring the model on steps
 * its baselines could not be scored on would compare two different sets of steps, and
 * the comparison is the whole point (a model is only worth its dependency if it beats
 * them). Every step not scored is counted under the reason it was not.
 */

/** One forecast as stored: the time and value of each step, and its interval if it had one. */
export interface ForecastTrace {
  stepMs: number;
  points: { t: number; v: number; lo: number | null; hi: number | null }[];
}

export type ExclusionReason =
  | 'no_actual' | 'no_persistence_origin' | 'no_seasonal_actual' | 'step_mismatch' | 'empty_forecast';

interface Sums { abs: number; scaled: number }

/** Running totals for one lead time, mergeable across series for the pooled summary. */
export interface LeadAccumulator {
  n: number;
  /** Steps that also had a naive scale, so a scaled error exists for them. */
  nScaled: number;
  model: Sums;
  persistence: Sums;
  seasonal: Sums;
  intervalN: number;
  intervalCovered: number;
}

export interface SeriesScore {
  byLead: Map<number, LeadAccumulator>;
  excluded: Partial<Record<ExclusionReason, number>>;
  /** The series' own one-step naive error; null when it has none (fewer than two
   * consecutive actuals, or a series that never moved). */
  scale: number | null;
  traces: number;
}

const DAY_MS = 86_400_000;

export const emptyLead = (): LeadAccumulator => ({
  n: 0, nScaled: 0, model: { abs: 0, scaled: 0 }, persistence: { abs: 0, scaled: 0 }, seasonal: { abs: 0, scaled: 0 },
  intervalN: 0, intervalCovered: 0,
});

/**
 * MASE's denominator: the mean absolute change between consecutive actuals of this
 * series, over the window evaluated. Dividing by it lets a signal measured in hundreds
 * and one measured in fractions be read on one scale. Taken over the window rather
 * than only before each origin, because the hourly rollup keeps 90 days and an origin
 * near its start has almost no history of its own; the report says so.
 */
export function naiveScale(actuals: Map<number, number>, stepMs: number): number | null {
  let sum = 0;
  let n = 0;
  for (const [t, a] of actuals) {
    const prev = actuals.get(t - stepMs);
    if (prev === undefined) continue;
    sum += Math.abs(a - prev);
    n += 1;
  }
  if (!n || sum === 0) return null;
  return sum / n;
}

/**
 * The seasonal baseline for a step `lead` steps after the origin: the actual one or more
 * whole days earlier, as many days as it takes to land at or before the origin. Plain
 * "same hour yesterday" would read an actual from after the forecast was made for every
 * lead past 24 hours, which is not a forecast anyone could have made.
 */
export function seasonalAt(t: number, lead: number, stepMs: number, seasonMs = DAY_MS): number {
  return t - Math.ceil((lead * stepMs) / seasonMs) * seasonMs;
}

export function scoreSeries(
  actuals: Map<number, number>, traces: ForecastTrace[], expectedStepMs: number,
): SeriesScore {
  const score: SeriesScore = { byLead: new Map(), excluded: {}, scale: naiveScale(actuals, expectedStepMs), traces: traces.length };
  const exclude = (why: ExclusionReason, k = 1) => { score.excluded[why] = (score.excluded[why] ?? 0) + k; };

  for (const trace of traces) {
    if (!trace.points.length) { exclude('empty_forecast'); continue; }
    // The step comes from the rows (§2: read it, do not assume it). Actuals are hourly
    // buckets; a forecast at any other step has nothing to be compared with.
    if (trace.stepMs !== expectedStepMs) { exclude('step_mismatch', trace.points.length); continue; }
    const origin = actuals.get(trace.points[0].t - trace.stepMs);
    for (const [i, p] of trace.points.entries()) {
      const lead = i + 1;
      const actual = actuals.get(p.t);
      if (actual === undefined) { exclude('no_actual'); continue; }
      if (origin === undefined) { exclude('no_persistence_origin'); continue; }
      const seasonal = actuals.get(seasonalAt(p.t, lead, trace.stepMs));
      if (seasonal === undefined) { exclude('no_seasonal_actual'); continue; }

      const acc = score.byLead.get(lead) ?? emptyLead();
      score.byLead.set(lead, acc);
      const errs = { model: Math.abs(actual - p.v), persistence: Math.abs(actual - origin), seasonal: Math.abs(actual - seasonal) };
      acc.n += 1;
      for (const k of ['model', 'persistence', 'seasonal'] as const) acc[k].abs += errs[k];
      if (score.scale !== null) {
        acc.nScaled += 1;
        for (const k of ['model', 'persistence', 'seasonal'] as const) acc[k].scaled += errs[k] / score.scale;
      }
      if (p.lo !== null && p.hi !== null) {
        acc.intervalN += 1;
        if (actual >= p.lo && actual <= p.hi) acc.intervalCovered += 1;
      }
    }
  }
  return score;
}

export function mergeInto(target: Map<number, LeadAccumulator>, source: Map<number, LeadAccumulator>): void {
  for (const [lead, s] of source) {
    const t = target.get(lead) ?? emptyLead();
    target.set(lead, t);
    t.n += s.n;
    t.nScaled += s.nScaled;
    for (const k of ['model', 'persistence', 'seasonal'] as const) {
      t[k].abs += s[k].abs;
      t[k].scaled += s[k].scaled;
    }
    t.intervalN += s.intervalN;
    t.intervalCovered += s.intervalCovered;
  }
}

/** A metric over nothing is null with the reason, never 0 (QEVAL1 §1). */
export type Metric = number | null;

export interface LeadMetrics {
  lead: number;
  n: number;
  model: { mae: Metric; maeScaled: Metric };
  persistence: { mae: Metric; maeScaled: Metric };
  seasonal: { mae: Metric; maeScaled: Metric };
  interval: { n: number; covered: number; coverage: Metric; reason: string | null };
  scaledReason: string | null;
}

export function leadMetrics(byLead: Map<number, LeadAccumulator>): LeadMetrics[] {
  return [...byLead.entries()].sort(([a], [b]) => a - b).map(([lead, a]) => {
    const pair = (s: Sums) => ({
      mae: a.n ? s.abs / a.n : null,
      maeScaled: a.nScaled ? s.scaled / a.nScaled : null,
    });
    return {
      lead, n: a.n,
      model: pair(a.model), persistence: pair(a.persistence), seasonal: pair(a.seasonal),
      // The daily sample is written without its interval (QML1 keeps lo/hi null there), so
      // coverage has nothing to count until a sample carries one; it says so.
      interval: {
        n: a.intervalN, covered: a.intervalCovered,
        coverage: a.intervalN ? a.intervalCovered / a.intervalN : null,
        reason: a.intervalN ? null : 'no_interval_on_forecast',
      },
      scaledReason: a.nScaled === a.n ? null : `${a.n - a.nScaled} of ${a.n} steps had no naive scale`,
    };
  });
}

export function sumExclusions(
  into: Partial<Record<ExclusionReason, number>>, from: Partial<Record<ExclusionReason, number>>,
): void {
  for (const [k, v] of Object.entries(from) as [ExclusionReason, number][]) into[k] = (into[k] ?? 0) + v;
}
