import { ExcludedRange } from '../catalog/formula/baseline-operators';
import { MIN_COVERAGE_RATIO } from '../kpi/services/kpi-evaluator.service';

/**
 * The numbers QML1 runs on, each one named once (D46 records who decided each).
 *
 * Cadence (Q3) is a platform constant, not a column: D40 §4 says four-hourly, and a
 * per-class cadence is added when a class needs a different one, not before.
 */
export const FORECAST_CADENCE_MS = 4 * 60 * 60 * 1000;
/** Q4: a quarter of the cadence, so hitting it and tripping D41's first trigger are one event. */
export const FORECAST_BUDGET_RATIO = 0.25;
/** Q5: hourly steps, so 512 context points are about 21 days and 24 steps are a day. */
export const FORECAST_STEP_SECONDS = 3600;
/** D20: a band learned from fewer days than this is not a band. */
export const BASELINE_DAYS = 14;
/** Q11: the band is the 2.5th–97.5th percentile of clean residuals (95%). */
export const BAND_QUANTILES = { lo: 0.025, hi: 0.975 } as const;
/** Q9: residuals, daily samples and the rollup are kept for D14's hot window. */
export const FORECAST_RETENTION_DAYS = 90;
/** Below this many clean residuals at one lead time the interval is the pooled band. */
export const MIN_RESIDUALS_PER_LEAD = 20;
/** Q6: the same floor the KPI evaluator applies, reused rather than restated. */
export const MIN_INPUT_COVERAGE = MIN_COVERAGE_RATIO;
/** Beside SHIFT_PASS_LOCK_KEY (8_742_310_001): its own lock, so neither pass waits on the other (D40 §1). */
export const FORECAST_PASS_LOCK_KEY = 8_742_310_002;

export type ContextOutcome =
  | { ok: true; values: number[]; coverage: number; imputed: number }
  | { ok: false; reason: 'insufficient_coverage' | 'gap_at_edge'; coverage: number };

/**
 * The model's input from the hourly buckets (Q6). TTM needs every step filled. Below
 * the coverage floor it is refused; above it, gaps strictly between two real buckets
 * are filled by a straight line between them, and only those. A gap at either end has
 * nothing on one side to draw from, so filling it would be inventing a trend — refused.
 * The count of filled steps goes on the forecast row, so it is visible, never hidden.
 */
export function buildContext(buckets: Map<number, number>, fromMs: number, steps: number, stepMs: number): ContextOutcome {
  const raw: (number | null)[] = [];
  for (let i = 0; i < steps; i++) raw.push(buckets.get(fromMs + i * stepMs) ?? null);
  const present = raw.filter((v) => v !== null).length;
  const coverage = present / steps;
  if (coverage < MIN_INPUT_COVERAGE) return { ok: false, reason: 'insufficient_coverage', coverage };
  if (raw[0] === null || raw[steps - 1] === null) return { ok: false, reason: 'gap_at_edge', coverage };

  const values = raw.slice() as number[];
  let imputed = 0;
  let last = 0;
  for (let i = 1; i < steps; i++) {
    if (raw[i] === null) continue;
    for (let j = last + 1; j < i; j++) {
      values[j] = raw[last]! + ((raw[i]! - raw[last]!) * (j - last)) / (i - last);
      imputed += 1;
    }
    last = i;
  }
  return { ok: true, values, coverage, imputed };
}

/** Linear-interpolated quantile of an ascending list. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) throw new Error('quantile of nothing');
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface ResidualPoint {
  stepAt: Date;
  lead: number;
  residual: number;
  /** Null: the machine has no shift schedule, so operating cannot be told from parked. */
  operating: boolean | null;
}

export type Band =
  | {
    established: true;
    lo: number; hi: number; n: number; cleanDays: number;
    learnedFrom: string; learnedTo: string;
    byLead: Map<number, { lo: number; hi: number; n: number }>;
  }
  | { established: false; reason: 'baseline_not_established' | 'no_shift_schedule'; cleanDays: number };

/**
 * The residual band (D20). Learned only from clean residuals: none inside an alert or an
 * open work order on the machine (the same exclusion the KPI baseline uses), and none from
 * an hour the machine was not operating (Q12, the QFIX-BASELINE rule — a parked machine's
 * residuals are a second population). Fewer than 14 days with a clean residual and there is
 * no band: `baseline_not_established`, which nothing may show as normal. A machine with no
 * shift schedule cannot tell operating from parked, so it never learns one either; the
 * reason says so rather than leaving it looking young.
 */
export function learnBand(residuals: ResidualPoint[], excluded: ExcludedRange[]): Band {
  if (residuals.length && residuals.every((r) => r.operating === null)) {
    return { established: false, reason: 'no_shift_schedule', cleanDays: 0 };
  }
  const clean = residuals.filter((r) =>
    r.operating === true && !excluded.some((x) => r.stepAt >= x.start && r.stepAt < x.end));
  const days = new Set(clean.map((r) => r.stepAt.toISOString().slice(0, 10)));
  if (days.size < BASELINE_DAYS) return { established: false, reason: 'baseline_not_established', cleanDays: days.size };

  const sorted = clean.map((r) => r.residual).sort((a, b) => a - b);
  const byLeadValues = new Map<number, number[]>();
  for (const r of clean) byLeadValues.set(r.lead, [...(byLeadValues.get(r.lead) ?? []), r.residual]);
  const byLead = new Map<number, { lo: number; hi: number; n: number }>();
  for (const [lead, values] of byLeadValues) {
    if (values.length < MIN_RESIDUALS_PER_LEAD) continue;
    values.sort((a, b) => a - b);
    byLead.set(lead, { lo: quantile(values, BAND_QUANTILES.lo), hi: quantile(values, BAND_QUANTILES.hi), n: values.length });
  }
  const times = clean.map((r) => r.stepAt.getTime());
  return {
    established: true,
    lo: quantile(sorted, BAND_QUANTILES.lo), hi: quantile(sorted, BAND_QUANTILES.hi), n: sorted.length,
    cleanDays: days.size,
    learnedFrom: new Date(Math.min(...times)).toISOString(), learnedTo: new Date(Math.max(...times)).toISOString(),
    byLead,
  };
}

/** The interval for one forecast step: residual quantiles at that lead, else pooled (Q7). */
export function intervalAt(band: Band, lead: number, v: number): { lo: number | null; hi: number | null } {
  if (!band.established) return { lo: null, hi: null };
  const at = band.byLead.get(lead) ?? band;
  return { lo: v + at.lo, hi: v + at.hi };
}
