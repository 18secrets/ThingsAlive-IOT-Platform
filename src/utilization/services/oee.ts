import { carryFor } from './duty-cycle';
import { Interval } from './availability';

/**
 * OEE as three divisions chained (task QOEE1): each factor divides the slice the one
 * above it handed down, so no minute is counted twice and
 *
 *   OEE = Availability × Performance × Quality = productive ÷ scheduled × quality
 *
 * falls out without a separate calculation. Nothing here reads a database; the service
 * gathers the inputs and this does the arithmetic, so a test can pin every number.
 */

export interface Sample {
  at: number;
  value: number;
}

export interface DetectedBreakdown {
  start: number;
  end: number;
  /** Still idle at the evaluation instant, inside a shift. Its minutes count to `end`. */
  open: boolean;
  detectedFrom: {
    runningSignal: string; runningValue: number;
    availabilitySignal: string; availabilityValue: number;
  };
}

const MINUTE = 60_000;

/** The latest sample at or before `t`, while it may still speak for `t` — the duty
 * cycle's own carry rule, so a logger that went quiet is unknown, not idle. */
function valueAt(samples: Sample[], t: number, carryMs: number): Sample | undefined {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0 || t - samples[found].at >= carryMs) return undefined;
  return samples[found];
}

/**
 * Breakdowns: during a scheduled shift, the running signal at or below its idle bound
 * **and** the availability signal present (above 0), for at least `thresholdMinutes`.
 *
 * Idle with no fuel is not a breakdown — it is waiting on a refuel, a different problem.
 * A stoppage is clipped to the shift: the part outside it is not scheduled time and
 * never counts, so a run that crosses a shift boundary is judged on its scheduled part.
 * Deterministic: the same samples, schedule and instant always give the same runs.
 */
export function detectBreakdowns(input: {
  running: { signal: string; samples: Sample[]; idleBound: number };
  availability: { signal: string; samples: Sample[] };
  scheduled: Interval[];
  thresholdMinutes: number;
  until: number;
}): DetectedBreakdown[] {
  const { running, availability, scheduled, thresholdMinutes, until } = input;
  if (!scheduled.length || !running.samples.length || !availability.samples.length) return [];
  const r = [...running.samples].sort((a, b) => a.at - b.at);
  const f = [...availability.samples].sort((a, b) => a.at - b.at);
  const carryMs = carryFor([...r, ...f].map((s) => s.at)) * 1000;

  const from = scheduled[0].start;
  const points = new Set<number>([until]);
  for (const s of [...r, ...f]) { points.add(s.at); points.add(s.at + carryMs); }
  for (const i of scheduled) { points.add(i.start); points.add(i.end); }
  const breakpoints = [...points].filter((t) => t >= from && t <= until).sort((a, b) => a - b);

  const inShift = (t: number) => scheduled.some((i) => t >= i.start && t < i.end);
  const runs: DetectedBreakdown[] = [];
  let current: DetectedBreakdown | null = null;
  for (let k = 0; k + 1 < breakpoints.length; k += 1) {
    const a = breakpoints[k];
    const b = breakpoints[k + 1];
    const rv = valueAt(r, a, carryMs);
    const fv = valueAt(f, a, carryMs);
    const idleWithFuel = inShift(a) && rv !== undefined && rv.value <= running.idleBound
      && fv !== undefined && fv.value > 0;
    if (idleWithFuel && current && current.end === a) {
      current.end = b;
    } else if (idleWithFuel) {
      current = {
        start: a, end: b, open: false,
        detectedFrom: {
          runningSignal: running.signal, runningValue: rv!.value,
          availabilitySignal: availability.signal, availabilityValue: fv!.value,
        },
      };
      runs.push(current);
    } else {
      current = null;
    }
  }
  // Open only when it reaches the instant asked about with the shift still running: a
  // run that ends at the shift's own end closed when the shift did.
  const stillInShift = scheduled.some((i) => until > i.start && until < i.end);
  return runs
    .filter((run) => run.end - run.start >= thresholdMinutes * MINUTE)
    .map((run) => ({ ...run, open: run.end === until && stillInShift }));
}

/** Total length of `a` minus whatever of it `b` covers. Both merged, sorted. */
export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    let pieces: Interval[] = [{ ...x }];
    for (const y of b) {
      pieces = pieces.flatMap((p) => {
        if (y.end <= p.start || y.start >= p.end) return [p];
        const keep: Interval[] = [];
        if (y.start > p.start) keep.push({ start: p.start, end: y.start });
        if (y.end < p.end) keep.push({ start: y.end, end: p.end });
        return keep;
      });
    }
    out.push(...pieces);
  }
  return out;
}

export const minutesIn = (intervals: Interval[]): number =>
  intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / MINUTE;

export function overlapMinutes(i: Interval, window: Interval): number {
  return Math.max(0, Math.min(i.end, window.end) - Math.max(i.start, window.start)) / MINUTE;
}

/**
 * Fuel actually burned inside `intervals`, from a rate signal in units per hour: each
 * sample speaks for the time until the next one, bounded by the duty cycle's carry, and
 * no further. A gap is not fuel — it is unknown, and is left out rather than invented.
 */
export function fuelBurned(rate: Sample[], intervals: Interval[]): number {
  if (!rate.length) return 0;
  const samples = [...rate].sort((a, b) => a.at - b.at);
  const carryMs = carryFor(samples.map((s) => s.at)) * 1000;
  let litres = 0;
  for (let k = 0; k < samples.length; k += 1) {
    const span = {
      start: samples[k].at,
      end: Math.min(samples[k].at + carryMs, k + 1 < samples.length ? samples[k + 1].at : Infinity),
    };
    for (const i of intervals) litres += samples[k].value * overlapMinutes(span, i) / 60;
  }
  return litres;
}

export type Readiness = 'ready' | 'not_configured' | 'blocked' | 'not_available';

export interface FactorState {
  value: number | null;
  readiness: Readiness;
  reason?: string;
}

const round = (x: number, places = 4) => Math.round(x * 10 ** places) / 10 ** places;

/** `1 − breakdown ÷ available`, floored at 0. Breakdowns exceeding the available minutes
 * mean the detector disagrees with Availability — that is said, not clamped away. */
export function performanceOf(breakdownMinutes: number, availableMinutes: number): FactorState & { warning?: string } {
  if (availableMinutes <= 0) return { value: null, readiness: 'blocked', reason: 'undefined_result' };
  const raw = 1 - breakdownMinutes / availableMinutes;
  if (raw < 0) {
    return {
      value: 0, readiness: 'ready',
      warning: `breakdown_exceeds_available: ${round(breakdownMinutes, 1)} breakdown minutes against `
        + `${round(availableMinutes, 1)} available — the detector and Availability disagree.`,
    };
  }
  return { value: round(raw), readiness: 'ready' };
}

/** `min(1, nominal for the productive hours ÷ actual)`. Capped: beating a nominal that
 * was the OEM's guess earns nothing, so 4 L/h against 6 is 100%, not 150%. */
export function qualityOf(nominalPerHour: number, productiveMinutes: number, actualFuel: number): FactorState & {
  nominalFuel: number | null; wasteFraction: number | null; wasteLitres: number | null;
} {
  const nominalFuel = nominalPerHour * productiveMinutes / 60;
  if (!(actualFuel > 0)) {
    return {
      value: null, readiness: 'blocked', reason: 'undefined_result',
      nominalFuel: round(nominalFuel, 3), wasteFraction: null, wasteLitres: null,
    };
  }
  const quality = Math.min(1, nominalFuel / actualFuel);
  return {
    value: round(quality), readiness: 'ready',
    nominalFuel: round(nominalFuel, 3),
    wasteFraction: round(1 - quality),
    wasteLitres: round(Math.max(0, actualFuel - nominalFuel), 3),
  };
}

/** OEE is null when any factor is: a two-factor OEE is a different metric with the same
 * name. It carries the first blocking factor's reason, in the chain's own order. */
export function oeeOf(factors: FactorState[]): FactorState {
  const blocking = factors.find((f) => f.value === null);
  if (blocking) return { value: null, readiness: blocking.readiness, reason: blocking.reason };
  return { value: round(factors.reduce((p, f) => p * (f.value as number), 1)), readiness: 'ready' };
}
