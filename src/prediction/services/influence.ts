import { Confidence } from './tier1';

/**
 * Scoring a machine against physics instead of against its own past (task P4-02).
 *
 * The problem this solves is the cold start, and Things Alive named the way out of it.
 * A statistical baseline asks "is this reading unusual for this machine", which cannot
 * be answered until the machine has a past — thirty days and thirty samples before the
 * first prediction, on a platform bought for predictions. Worse, it is answering a
 * weaker question than anybody wants. Oil temperature climbing is not abnormal; oil
 * temperature climbing **while the load did not** is abnormal, and that is visible in
 * a single shift.
 *
 * So a scenario can carry an influence model: the signals that are *expected* to drive
 * the target, with the coefficients that say how much. Expected value is computed from
 * them, and what is scored is the residual — how far the machine is from where physics
 * says it should be. No history is required, because the model is engineering
 * knowledge about the class of machine rather than a summary of this one's past.
 *
 * Worked through with the example Things Alive gave. Load rises, oil temperature rises
 * with it: expected, residual near zero, nothing said. Oil temperature rises while
 * load is flat: the residual is the whole rise, and it is flagged on the first shift.
 * The second case is the one that ends in a coolant problem and a breakdown, and a
 * baseline scorer would have called both of them the same thing.
 *
 * This is the deterministic half of the intelligence layer. The learned half comes
 * later (P4-01); this is the half whose coefficients somebody can read, argue with and
 * correct, which is also why it is the half safe to ship first.
 */
export interface InfluenceTerm {
  /** The signal that drives the target. */
  signal: string;
  /** Units of target per unit of this signal. Oil degC per percent of load. */
  coefficient: number;
}

export interface InfluenceModel {
  /** The signal being predicted, e.g. oil_temperature. */
  target: string;
  /** Expected target when every influence reads zero. */
  intercept: number;
  terms: InfluenceTerm[];
  /** Residual above which the machine is off its expected curve. */
  warnAbove: number;
  criticalAbove: number;
  /**
   * How far apart two readings may be and still describe the same moment.
   *
   * Signals arrive on their own schedules, so a target and its influences are almost
   * never stamped identically. Pairing them needs a tolerance, and the tolerance is a
   * property of the fleet's reporting interval rather than something to hard-code.
   */
  alignmentSeconds?: number;
  /**
   * Ignore samples outside these ranges.
   *
   * A linear model of a machine is true over the range it was fitted for. Oil
   * temperature against load says nothing useful while the engine is warming up, and
   * extrapolating a straight line into a region nobody characterised produces a
   * confident number about a regime the model has never seen.
   */
  validWhen?: { signal: string; min?: number; max?: number }[];
}

export interface Sample {
  signal: string;
  value: number;
  at: number;
}

export interface Residual {
  at: number;
  actual: number;
  expected: number;
  /** actual - expected. Positive means hotter, faster or higher than it should be. */
  residual: number;
  influences: Record<string, number>;
}

export interface InfluenceOutcome {
  scored: boolean;
  /** Why nothing was scored, when nothing was. */
  reason?: 'no-model' | 'no-target' | 'no-influences' | 'out-of-range';
  confidence: Confidence;
  residuals: Residual[];
  worst?: Residual;
  severityLevel?: 'none' | 'warning' | 'critical';
  /** How far past the warning threshold, as a fraction. Feeds the composite risk. */
  exceedance?: number;
}

export const DEFAULT_ALIGNMENT_SECONDS = 300;

/**
 * The influence readings nearest in time to this target reading.
 *
 * Nearest rather than last-known, because a stale value is worse than a missing one
 * here: pairing a target from mid-shift with an influence from three hours earlier
 * produces a residual that is entirely an artefact of the gap, and it looks exactly
 * like a fault.
 */
function alignAt(
  at: number, bySignal: Map<string, Sample[]>, signals: string[], toleranceMs: number,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const signal of signals) {
    const candidates = bySignal.get(signal);
    if (!candidates?.length) return null;

    let best: Sample | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const gap = Math.abs(candidate.at - at);
      if (gap < bestGap) { best = candidate; bestGap = gap; }
    }
    if (!best || bestGap > toleranceMs) return null;
    out[signal] = best.value;
  }
  return out;
}

function withinValidRange(
  influences: Record<string, number>, actual: number, model: InfluenceModel,
): boolean {
  for (const rule of model.validWhen ?? []) {
    const value = rule.signal === model.target ? actual : influences[rule.signal];
    if (value === undefined) return false;
    if (rule.min !== undefined && value < rule.min) return false;
    if (rule.max !== undefined && value > rule.max) return false;
  }
  return true;
}

/**
 * Score one window against the model.
 *
 * Returns every residual rather than only the verdict, because an alert that says a
 * machine is off its curve and cannot say by how much, at what load, and when, is an
 * alert somebody walks out to and finds nothing obvious.
 */
export function scoreInfluence(model: InfluenceModel | null, samples: Sample[]): InfluenceOutcome {
  if (!model || model.terms.length === 0) {
    return { scored: false, reason: 'no-model', confidence: 'none', residuals: [] };
  }

  const bySignal = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = bySignal.get(sample.signal) ?? [];
    list.push(sample);
    bySignal.set(sample.signal, list);
  }

  const targets = bySignal.get(model.target) ?? [];
  if (targets.length === 0) {
    return { scored: false, reason: 'no-target', confidence: 'none', residuals: [] };
  }

  const influenceSignals = model.terms.map((t) => t.signal);
  const toleranceMs = (model.alignmentSeconds ?? DEFAULT_ALIGNMENT_SECONDS) * 1000;

  const residuals: Residual[] = [];
  let unaligned = 0;
  let outOfRange = 0;

  for (const target of targets) {
    const influences = alignAt(target.at, bySignal, influenceSignals, toleranceMs);
    if (!influences) { unaligned += 1; continue; }
    if (!withinValidRange(influences, target.value, model)) { outOfRange += 1; continue; }

    const expected = model.terms.reduce(
      (sum, term) => sum + term.coefficient * influences[term.signal], model.intercept,
    );
    residuals.push({
      at: target.at, actual: target.value, expected,
      residual: target.value - expected, influences,
    });
  }

  if (residuals.length === 0) {
    return {
      scored: false,
      // Told apart on purpose: nothing to pair against is a fleet not reporting the
      // influences, and out-of-range is a machine running somewhere the model was
      // never fitted for. One is a commissioning question and the other is a
      // modelling one.
      reason: outOfRange > unaligned ? 'out-of-range' : 'no-influences',
      confidence: 'none',
      residuals: [],
    };
  }

  const worst = residuals.reduce((a, b) => (b.residual > a.residual ? b : a));
  const severityLevel = worst.residual >= model.criticalAbove
    ? 'critical'
    : worst.residual >= model.warnAbove ? 'warning' : 'none';

  return {
    scored: true,
    // Partial when a meaningful share of the window could not be paired: the answer
    // stands, and whoever reads it should know it was built from part of the shift.
    confidence: unaligned + outOfRange > residuals.length ? 'partial' : 'full',
    residuals,
    worst,
    severityLevel,
    exceedance: model.warnAbove > 0
      ? Math.max(0, worst.residual - model.warnAbove) / model.warnAbove
      : 0,
  };
}

/** Read an influence model off a scenario's parameters, if it carries one. */
export function influenceModelFrom(
  parameters: { key: string; default: unknown }[] | null | undefined,
  overrides: Record<string, unknown> = {},
): InfluenceModel | null {
  const raw = overrides.influence_model
    ?? parameters?.find((p) => p.key === 'influence_model')?.default;
  if (!raw || typeof raw !== 'object') return null;

  const model = raw as InfluenceModel;
  if (!model.target || !Array.isArray(model.terms) || model.terms.length === 0) return null;
  if (typeof model.warnAbove !== 'number' || typeof model.criticalAbove !== 'number') return null;
  return model;
}
