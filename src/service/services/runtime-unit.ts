/**
 * What unit the hour meter is counting in, worked out rather than asked (task P4-07).
 *
 * `engine_runtime` arrives as a number with no reliable unit. Loggers are configured
 * per deployment and the same fleet can carry three conventions, so the honest options
 * looked like waiting for an answer from Things Alive or guessing — and guessing hours
 * when the meter meant seconds produces a service prediction wrong by a factor of 3600
 * that still looks like a plausible number on a screen.
 *
 * There is a third option, and it only exists because P4-05 shipped first. Every
 * `utilization_shift` row carries both the meter's delta across the window and the
 * engine-on seconds measured independently from the status signals. Those two describe
 * the same hours in different units, so their ratio *is* the unit:
 *
 *     engine on for 4 hours, meter advanced 4.0    → hours
 *     engine on for 4 hours, meter advanced 240    → minutes
 *     engine on for 4 hours, meter advanced 14400  → seconds
 *
 * The duty cycle calibrates the meter. Nobody has to know the answer in advance, and
 * the answer comes with the evidence that produced it.
 *
 * Three things keep this from being a clever way to be confidently wrong. Only shifts
 * with high coverage are used, because the ratio is meaningless when half the window
 * was unobserved and the meter counted through it anyway. The median is taken rather
 * than the mean, so one machine serviced mid-shift cannot drag the answer. And a ratio
 * that does not land near a known unit returns `unknown` instead of the nearest one —
 * a meter that counts something else entirely, or a mis-mapped signal, is a real
 * possibility and "closest guess" is the wrong response to it.
 */

export type RuntimeUnit = 'hours' | 'minutes' | 'seconds';

/** Seconds per unit — the number that converts a meter reading into real time. */
export const SECONDS_PER_UNIT: Record<RuntimeUnit, number> = {
  hours: 3600,
  minutes: 60,
  seconds: 1,
};

/**
 * A window must be this well observed before its ratio is worth anything.
 *
 * The meter counts through an outage; the status signals do not. So a shift with 50%
 * coverage reports roughly half the engine-on seconds it should against a full meter
 * delta, and its ratio is inflated by an arbitrary amount. High coverage is not a
 * quality preference here — it is what makes the two numbers comparable at all.
 */
export const MIN_COVERAGE = 0.9;

/** Below this the meter's delta is too small for its rounding to be ignorable. */
export const MIN_ENGINE_ON_SECONDS = 1800;

/** How far a ratio may sit from a unit's true value and still be called that unit. */
export const RATIO_TOLERANCE = 0.25;

/** Fewer windows than this and the answer is an anecdote. */
export const MIN_WINDOWS = 5;

/** Windows agreeing on the unit, as a fraction, before the answer is 'high'. */
export const HIGH_AGREEMENT = 0.9;

export interface CalibrationWindow {
  engineOnSeconds: number;
  coverage: number;
  runtimeDelta: number | null;
  runtimeCounterReset: boolean;
  /** Carried through so a caller can point at the evidence. */
  externalId?: string;
  localDate?: string;
}

export interface Calibration {
  unit: RuntimeUnit | null;
  confidence: 'high' | 'low' | 'none';
  /**
   * Why there is no unit, when there is none. Distinct reasons because they want
   * different people: not enough data is a matter of waiting, and a ratio matching
   * nothing is a mapping problem somebody has to look at.
   */
  reason?: 'no-usable-windows' | 'too-few-windows' | 'no-unit-matches' | 'disagreement';
  /** Windows that survived the filters and produced a ratio. */
  usable: number;
  /** Windows offered in, including the ones discarded. */
  considered: number;
  /** Meter units per second, median across usable windows. */
  medianRatio: number | null;
  /** Fraction of usable windows agreeing with the chosen unit. */
  agreement: number | null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Which unit a ratio of meter-units-per-second is, or none of them.
 *
 * Tolerance is relative rather than absolute: a quarter either side of 1/3600 and a
 * quarter either side of 1 are wildly different absolute distances, and an absolute
 * tolerance would make the hours case unreachable and the seconds case indiscriminate.
 */
export function unitForRatio(ratio: number, tolerance = RATIO_TOLERANCE): RuntimeUnit | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  for (const unit of Object.keys(SECONDS_PER_UNIT) as RuntimeUnit[]) {
    const expected = 1 / SECONDS_PER_UNIT[unit];
    if (Math.abs(ratio - expected) / expected <= tolerance) return unit;
  }
  return null;
}

export function calibrateRuntimeUnit(windows: CalibrationWindow[]): Calibration {
  const considered = windows.length;

  const ratios: { ratio: number; unit: RuntimeUnit | null }[] = [];
  for (const w of windows) {
    // A reset meter's delta was already refused upstream, but a caller assembling
    // these from somewhere else could hand one over; it is not a measurement.
    if (w.runtimeCounterReset) continue;
    if (w.runtimeDelta === null || !Number.isFinite(w.runtimeDelta) || w.runtimeDelta <= 0) continue;
    if (w.coverage < MIN_COVERAGE) continue;
    if (w.engineOnSeconds < MIN_ENGINE_ON_SECONDS) continue;

    const ratio = w.runtimeDelta / w.engineOnSeconds;
    ratios.push({ ratio, unit: unitForRatio(ratio) });
  }

  const empty = { usable: ratios.length, considered, medianRatio: null, agreement: null };
  if (ratios.length === 0) {
    return { unit: null, confidence: 'none', reason: 'no-usable-windows', ...empty };
  }

  const overallMedian = median(ratios.map((r) => r.ratio));

  if (ratios.length < MIN_WINDOWS) {
    // A ratio from three windows may well be right. It is not something to convert a
    // customer's maintenance schedule with, so it is reported and not acted on.
    return {
      unit: null, confidence: 'none', reason: 'too-few-windows',
      usable: ratios.length, considered, medianRatio: overallMedian, agreement: null,
    };
  }

  /*
   * The unit is chosen by the mode, not by the median of the ratios.
   *
   * This was a median and the difference is not cosmetic. A fleet split between two
   * conventions — half the loggers in hours, half in minutes — has a median that sits
   * between the two and matches neither, so the old code diagnosed it as `no-unit-
   * matches` and sent somebody to hunt a mis-mapped signal that was not there. The
   * median of a bimodal distribution is not a compromise; it is a number describing
   * no machine in the fleet. Counting which unit each window votes for tells the two
   * failures apart: nobody matching anything is a mapping problem, and two groups
   * matching different things is a configuration split.
   */
  const votes = new Map<RuntimeUnit, number>();
  for (const r of ratios) {
    if (r.unit) votes.set(r.unit, (votes.get(r.unit) ?? 0) + 1);
  }

  if (votes.size === 0) {
    // The meter is counting something, and it is not time in any unit expected here.
    // A mis-mapped signal looks exactly like this, and picking the nearest unit would
    // bury the evidence of it under a plausible number.
    return {
      unit: null, confidence: 'none', reason: 'no-unit-matches',
      usable: ratios.length, considered, medianRatio: overallMedian, agreement: null,
    };
  }

  const [unit, count] = [...votes].sort((a, b) => b[1] - a[1])[0];
  const agreement = count / ratios.length;

  // A strict majority, so an even split between two conventions is a refusal rather
  // than a coin toss decided by iteration order.
  if (agreement <= 0.5) {
    return {
      unit: null, confidence: 'none', reason: 'disagreement',
      usable: ratios.length, considered, medianRatio: overallMedian, agreement,
    };
  }

  return {
    unit,
    confidence: agreement >= HIGH_AGREEMENT ? 'high' : 'low',
    usable: ratios.length,
    considered,
    // The median across the windows that agree, so the reported ratio describes the
    // unit that was actually chosen rather than being dragged by the dissenters.
    medianRatio: median(ratios.filter((r) => r.unit === unit).map((r) => r.ratio)),
    agreement,
  };
}

/** Meter units to seconds, once the unit is known. */
export function meterToSeconds(delta: number, unit: RuntimeUnit): number {
  return delta * SECONDS_PER_UNIT[unit];
}

/** Meter units to hours, which is what a service interval is written in. */
export function meterToHours(delta: number, unit: RuntimeUnit): number {
  return meterToSeconds(delta, unit) / 3600;
}
