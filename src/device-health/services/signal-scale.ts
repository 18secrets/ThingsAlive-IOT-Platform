/**
 * What scale `gsm_signal_strength` is reported on (task P4-08).
 *
 * The same shape of problem as the hour meter's unit, and worse in one respect: getting
 * the meter's unit wrong makes a number too big, while getting this wrong *inverts the
 * verdict*. Modems report signal in at least three conventions, and two of them run in
 * opposite directions:
 *
 *   - dBm, roughly -113 (unusable) to -51 (excellent). Negative, and higher is better.
 *   - CSQ, 0 to 31, with 99 meaning "not known". Positive, higher is better.
 *   - Percent, 0 to 100. Positive, higher is better.
 *
 * A naive "low means poor" is right for CSQ and percent and right for dBm too — but
 * only if the thresholds are on the right scale. A CSQ of 8 is poor; a dBm of 8 is
 * impossible; a percent of 8 is poor. Band a dBm reading against CSQ thresholds and
 * every device in the fleet reads as catastrophic, for ever, and the alert gets muted.
 *
 * So the scale is inferred from the values themselves rather than configured, and when
 * the values do not clearly indicate one, nothing is inferred. Unlike the meter unit
 * this cannot be cross-checked against an independent measurement — there is no second
 * opinion on radio signal — so the inference leans on the ranges being disjoint where
 * it matters, and declines where they are not.
 */

export type SignalScale = 'dbm' | 'csq' | 'percent';
export type SignalBand = 'excellent' | 'good' | 'fair' | 'poor';

/**
 * CSQ's "unknown" sentinel. Reported by a modem that cannot measure, and it is not a
 * strength of 99 — including it would turn an unmeasurable link into a perfect one.
 */
export const CSQ_UNKNOWN = 99;

/** Thresholds per scale, as the floor of each band. Ordered worst to best. */
const BANDS: Record<SignalScale, [SignalBand, number][]> = {
  // -85 and better is comfortable; below -100 a link drops under load even when it
  // shows connected, which is exactly the state that produces half-covered shifts.
  dbm: [['poor', -Infinity], ['fair', -100], ['good', -85], ['excellent', -70]],
  csq: [['poor', -Infinity], ['fair', 10], ['good', 15], ['excellent', 20]],
  percent: [['poor', -Infinity], ['fair', 30], ['good', 50], ['excellent', 70]],
};

export interface ScaleInference {
  scale: SignalScale | null;
  reason?: 'no-values' | 'ambiguous' | 'out-of-range';
  /** Values that took part, after the sentinel and non-finite ones were dropped. */
  usable: number;
  min: number | null;
  max: number | null;
}

/**
 * Infer the scale from the range of values seen.
 *
 * Negative settles it outright: nothing else here goes below zero. Above 31 rules out
 * CSQ and leaves percent. The genuinely ambiguous case is a positive range entirely
 * within 0..31, which is a valid CSQ *and* a valid — if poor — percent, and there is
 * no way to tell from the numbers. That case refuses rather than picking: a fleet
 * sitting at CSQ 20 is healthy and the same values read as percent are poor, and
 * choosing wrong would either invent a fleet-wide fault or hide a real one.
 */
export function inferSignalScale(values: number[]): ScaleInference {
  const usable = values.filter((v) => Number.isFinite(v) && v !== CSQ_UNKNOWN);
  if (usable.length === 0) {
    return { scale: null, reason: 'no-values', usable: 0, min: null, max: null };
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const base = { usable: usable.length, min, max };

  // Negative values are dBm and nothing else.
  if (min < 0) {
    // A "dBm" of -400 is not a weak signal, it is a broken mapping, and banding it
    // would report an unusable link where the real fault is a wrong column.
    if (min < -150 || max > 0) return { scale: null, reason: 'out-of-range', ...base };
    return { scale: 'dbm', ...base };
  }

  if (max > 100) return { scale: null, reason: 'out-of-range', ...base };
  // Above CSQ's ceiling, so percent is the only reading left.
  if (max > 31) return { scale: 'percent', ...base };

  // 0..31 is a valid CSQ and a valid (poor) percent, and the numbers cannot say which.
  return { scale: null, reason: 'ambiguous', ...base };
}

export function bandFor(value: number, scale: SignalScale): SignalBand {
  let band: SignalBand = 'poor';
  for (const [name, floor] of BANDS[scale]) {
    if (value >= floor) band = name;
  }
  return band;
}

/** Worst first, so a comparison can ask "is this at or below fair". */
export const BAND_ORDER: SignalBand[] = ['poor', 'fair', 'good', 'excellent'];

export function atOrBelow(band: SignalBand, floor: SignalBand): boolean {
  return BAND_ORDER.indexOf(band) <= BAND_ORDER.indexOf(floor);
}

export interface SignalSummary {
  scale: SignalScale | null;
  scaleReason?: ScaleInference['reason'];
  /** The typical value, and the worst — a link is judged by its bad moments. */
  median: number | null;
  worst: number | null;
  band: SignalBand | null;
  worstBand: SignalBand | null;
  samples: number;
  /** Samples where the modem said it could not measure. */
  unknownSamples: number;
}

export function summariseSignal(values: number[]): SignalSummary {
  const unknownSamples = values.filter((v) => v === CSQ_UNKNOWN).length;
  const inference = inferSignalScale(values);
  const usable = values.filter((v) => Number.isFinite(v) && v !== CSQ_UNKNOWN);

  if (!inference.scale || usable.length === 0) {
    return {
      scale: null, scaleReason: inference.reason, median: null, worst: null,
      band: null, worstBand: null, samples: usable.length, unknownSamples,
    };
  }

  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  // Worst is the minimum on every scale here, because all three run the same way:
  // higher is better. That is true of dBm too — -70 beats -100.
  const worst = sorted[0];

  return {
    scale: inference.scale,
    median,
    worst,
    band: bandFor(median, inference.scale),
    worstBand: bandFor(worst, inference.scale),
    samples: usable.length,
    unknownSamples,
  };
}
