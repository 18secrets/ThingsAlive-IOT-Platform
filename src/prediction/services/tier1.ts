import { Severity } from '../../common/severity';

/**
 * The Tier 1 scorer, ported from the browser (task P1-14).
 *
 * The rules are the ones the existing platform runs in `riskLogic.ts`: a z-score
 * against a rolling baseline, a warning band at 1.5σ and a critical band at 2.5σ,
 * a composite risk score, five severity bands, and a high-priority flag when three
 * or more signals are abnormal at once.
 *
 * It is a pure function over explicit inputs — no database, no clock, no scope. That
 * is what lets the parity suite (P1-15) run it against recorded fixtures and compare
 * outputs field by field, which is the only way to know a port is faithful. Scoring
 * that reaches for its own data cannot be compared to anything.
 *
 * One caveat, stated here rather than discovered later: the browser source is not
 * reachable from the workspace this was written in, so the band thresholds and the
 * three-signal rule come from the platform documentation and the composite formula
 * below is a reconstruction. Everything else is a rule with a number attached;
 * `compositeRisk` is the one place a faithful port has to be confirmed rather than
 * read. It is isolated for exactly that reason.
 */

export const DEFAULT_WARNING_SIGMA = 1.5;
export const DEFAULT_CRITICAL_SIGMA = 2.5;

/**
 * Below this, a baseline's standard deviation is not a description of normal, it is
 * an artefact of having looked three times. Thirty is the conventional floor and is
 * a parameter rather than a constant so a scenario can raise it.
 */
export const DEFAULT_MINIMUM_SAMPLES = 30;

export type SignalState = 'normal' | 'warning' | 'critical' | 'unscored';

export type UnscoredReason =
  | 'no-reading'
  | 'no-baseline'
  | 'too-few-samples'
  | 'no-variance';

export interface SignalObservation {
  signal: string;
  value: number;
  at: Date;
}

export interface SignalBaseline {
  signal: string;
  mean: number;
  stddev: number;
  sampleCount: number;
}

export interface SignalVerdict {
  signal: string;
  state: SignalState;
  /** Null whenever the signal is unscored — never zero, which would read as normal. */
  z: number | null;
  value: number | null;
  mean: number | null;
  stddev: number | null;
  reason?: UnscoredReason;
}

/**
 * How much of the picture was actually available.
 *
 * This exists because "nothing is wrong" and "we could not tell" produce the same
 * severity, and they are not the same answer. A machine whose sensors all went quiet
 * scores `none` on every signal and would otherwise be indistinguishable on a screen
 * from a healthy one — which is the failure mode a monitoring platform can least
 * afford, because it is silent and looks like success.
 */
export type Confidence = 'full' | 'partial' | 'none';

export interface Tier1Input {
  requiredSignals: string[];
  observations: SignalObservation[];
  baselines: SignalBaseline[];
  warningSigma?: number;
  criticalSigma?: number;
  minimumSamples?: number;
}

export interface Tier1Outcome {
  severity: Severity;
  /** 0–100. Zero means "scored, and nothing is out of band" — not "unknown". */
  riskScore: number;
  abnormalCount: number;
  highPriority: boolean;
  confidence: Confidence;
  scoredCount: number;
  unscoredCount: number;
  signals: SignalVerdict[];
}

/** Abnormal means at or beyond the warning band — the flag counts signals, not severity. */
const isAbnormal = (v: SignalVerdict): boolean => v.state === 'warning' || v.state === 'critical';

/**
 * The composite, and the one number a parity run has to confirm.
 *
 * Each scored signal contributes its distance into the abnormal range, normalised so
 * that a signal sitting exactly on the critical threshold contributes 1. The score
 * then weights the worst signal heavily and the average lightly: a single signal at
 * 3σ is a real problem and should not be diluted by four quiet ones, but four signals
 * drifting together is worse than one, and a pure maximum cannot say so.
 */
export function compositeRisk(contributions: number[]): number {
  if (contributions.length === 0) return 0;
  const worst = Math.max(...contributions);
  const mean = contributions.reduce((a, b) => a + b, 0) / contributions.length;
  return Math.round(Math.min(100, 100 * (0.7 * worst + 0.3 * mean)));
}

/** Five bands. A signal at or past critical forces the top band regardless of the composite. */
function band(risk: number, anyCritical: boolean, abnormalCount: number): Severity {
  if (anyCritical || risk >= 85) return Severity.Critical;
  if (abnormalCount === 0) return Severity.None;
  if (risk >= 60) return Severity.High;
  if (risk >= 40) return Severity.Medium;
  return Severity.Low;
}

export function scoreTier1(input: Tier1Input): Tier1Outcome {
  const warningSigma = input.warningSigma ?? DEFAULT_WARNING_SIGMA;
  const criticalSigma = input.criticalSigma ?? DEFAULT_CRITICAL_SIGMA;
  const minimumSamples = input.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES;

  const observed = new Map(input.observations.map((o) => [o.signal, o]));
  const based = new Map(input.baselines.map((b) => [b.signal, b]));

  const contributions: number[] = [];
  const signals: SignalVerdict[] = input.requiredSignals.map((signal) => {
    const o = observed.get(signal);
    const b = based.get(signal);

    const unscored = (reason: UnscoredReason): SignalVerdict => ({
      signal, state: 'unscored', z: null, reason,
      value: o?.value ?? null, mean: b?.mean ?? null, stddev: b?.stddev ?? null,
    });

    if (!o) return unscored('no-reading');
    if (!b) return unscored('no-baseline');
    if (b.sampleCount < minimumSamples) return unscored('too-few-samples');

    // A standard deviation of zero is not a calm signal, it is an undefined z-score —
    // and more often than not, a sensor reporting the same number because it has
    // stopped reading. Calling it normal would hide precisely the fault this platform
    // exists to catch, so it is reported as unscored with its own reason.
    if (!(b.stddev > 0)) return unscored('no-variance');

    const z = (o.value - b.mean) / b.stddev;
    const magnitude = Math.abs(z);
    const state: SignalState =
      magnitude >= criticalSigma ? 'critical' : magnitude >= warningSigma ? 'warning' : 'normal';

    contributions.push(Math.min(1, magnitude / criticalSigma));
    return { signal, state, z, value: o.value, mean: b.mean, stddev: b.stddev };
  });

  const scoredCount = signals.filter((s) => s.state !== 'unscored').length;
  const unscoredCount = signals.length - scoredCount;
  const abnormalCount = signals.filter(isAbnormal).length;
  const anyCritical = signals.some((s) => s.state === 'critical');

  const confidence: Confidence =
    scoredCount === 0 ? 'none' : unscoredCount === 0 ? 'full' : 'partial';

  // Nothing could be scored, so there is no evidence either way. Reporting a risk of
  // zero here would be an assertion the data does not support; the severity is None
  // and `confidence` is what stops that reading as "healthy".
  const riskScore = confidence === 'none' ? 0 : compositeRisk(contributions);

  return {
    severity: confidence === 'none' ? Severity.None : band(riskScore, anyCritical, abnormalCount),
    riskScore,
    abnormalCount,
    // Three signals abnormal at once is the platform's existing escalation rule. It
    // stays a flag rather than a severity bump: severity says how bad, this says how
    // broad, and collapsing them loses the distinction the operator acts on.
    highPriority: abnormalCount >= 3,
    confidence,
    scoredCount,
    unscoredCount,
    signals,
  };
}
