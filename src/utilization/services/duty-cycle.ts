import { WindowReading } from '../../alert/services/alert-rules';
import { SIGNALS } from '../../common/signals';

/**
 * What a machine was doing with its shift, from status samples alone (task P4-05).
 *
 * Utilization is the first thing anybody asks the platform that is not a prediction:
 * how much of the day did this machine work, how much did it sit running and burn
 * fuel doing nothing, and how much was it off. Things Alive's fleet already reports
 * every signal the question needs — `ignition_status`, `engine_running_status`,
 * `utilization_status`, `engine_runtime` — so this is an aggregation, not a model,
 * and it works on the first shift a machine reports rather than the tenth.
 *
 * The whole difficulty is that telemetry is sampled and duty cycle is continuous.
 * Turning a scatter of samples into hours means deciding how long one sample is
 * allowed to speak for, and the obvious answer — "until the next one" — is the one
 * that produces the platform's worst possible lie. A logger that reports `running`
 * and then goes off the network for six hours would contribute six hours of
 * productive time to the customer's report, invented out of a single sample and
 * indistinguishable on the screen from six hours that were actually worked.
 *
 * So a sample speaks for a bounded interval and no longer, and the time past that
 * bound is `unknown` rather than assumed. `unknown` is a first-class bucket here for
 * the same reason `runningStatusFor` has a third answer: a machine that said nothing
 * has not said it was idle, and a report that cannot tell those apart is a report
 * that quietly turns outages into productivity.
 *
 * The bound itself is derived from how often this machine actually reports, because
 * the fleet is not uniform — a logger sampling every thirty seconds and one sampling
 * every five minutes want different answers, and a single constant would either
 * shred the first into unknown or let the second paper over real gaps.
 */

/**
 * Five states, and two of them are admissions.
 *
 * `running-unclassified` is the machine that reported its engine on and nothing about
 * whether it was working. Folding it into `idle` would invent idling that may not
 * have happened; folding it into `productive` would bill a customer's report for work
 * nobody observed. It is its own bucket so the ratio below can be computed over the
 * time that was actually classified, and so a fleet that reports no load signal shows
 * up as a commissioning gap rather than as a fleet that never works.
 */
export type DutyState = 'productive' | 'idle' | 'running-unclassified' | 'off' | 'unknown';

/** The signals this reads. Anything else in the window is ignored, not an error. */
export const DUTY_SIGNALS: readonly string[] = [
  SIGNALS.engineRunningStatus,
  SIGNALS.ignitionStatus,
  SIGNALS.utilizationStatus,
  SIGNALS.engineLoad,
  SIGNALS.torque,
  SIGNALS.engineRuntime,
];

/** Percent of rated load at or above which a running engine counts as working. */
export const DEFAULT_LOAD_THRESHOLD = 20;

/** Carry bounds. A sample may never speak for less than a minute or more than 15. */
export const MIN_CARRY_SECONDS = 60;
export const MAX_CARRY_SECONDS = 900;

/** How many reporting intervals a sample may cover before the rest becomes unknown. */
export const CARRY_FACTOR = 3;

/** Used when the window holds too few samples to measure a cadence from. */
export const DEFAULT_CARRY_SECONDS = 300;

export interface DutyCycleOptions {
  loadThreshold?: number;
  /** Override the derived carry, for a fleet whose cadence is known out of band. */
  carrySeconds?: number;
}

export interface DutyCycle {
  windowStart: Date;
  windowEnd: Date;
  /** Wall-clock length of the shift window. The five buckets sum to exactly this. */
  totalSeconds: number;

  productiveSeconds: number;
  idleSeconds: number;
  runningUnclassifiedSeconds: number;
  offSeconds: number;
  /** Time no sample was entitled to describe: gaps, outages, and the head of the shift. */
  unknownSeconds: number;

  /** productive + idle + running-unclassified. */
  engineOnSeconds: number;
  /** How long one sample was allowed to speak for, in the end. */
  carrySeconds: number;
  /** Observed fraction of the window, 0..1. Everything below is computed over this. */
  coverage: number;

  /**
   * Engine-on over *observed* time, not over the shift.
   *
   * Dividing by the whole window would mean a machine that worked flat out through
   * the half of the shift its logger was online scored 50%, which reads as an idle
   * machine rather than a connectivity problem. `coverage` is reported beside this so
   * a caller can refuse to trust a thin row; burying the thinness inside the number
   * would make it unrecoverable.
   */
  utilizationRate: number | null;
  /** Productive over classified running time. Null when nothing was classified. */
  productiveRate: number | null;
  idleRate: number | null;

  /**
   * The hour meter's own account of the same window.
   *
   * Deliberately not converted. `engine_runtime` arrives in whatever unit the logger
   * was configured with, and guessing hours when it meant seconds would produce a
   * service prediction wrong by a factor of 3600 that still looks like a number.
   */
  runtimeDelta: number | null;
  runtimeUnit: string | null;
  /** The meter ran backwards: a replaced logger or a reset counter, not negative work. */
  runtimeCounterReset: boolean;

  /** Status samples actually used, and which signals were present. */
  samples: number;
  signalsPresent: string[];
}

interface Sample {
  at: number;
  signal: string;
  value: number;
  unit: string | null;
}

const seconds = (ms: number): number => ms / 1000;

/**
 * Classify one instant from whatever the machine had last said about itself.
 *
 * The order is a preference between sources, not a set of alternatives that happen to
 * agree. `utilization_status` is the fleet's own dedicated answer and wins outright;
 * load and torque are inferences from how hard it was working and are only consulted
 * when the machine did not say. Reading them in the other order would let a
 * threshold argument overrule the machine's own report.
 */
export function classify(
  snapshot: Map<string, number>, loadThreshold: number,
): DutyState {
  const running = snapshot.get(SIGNALS.engineRunningStatus);
  const ignition = snapshot.get(SIGNALS.ignitionStatus);

  // Ignition is the fallback, not a second opinion: a fleet that reports running
  // status is answered by it, and one that reports only ignition is still answerable.
  const engineOn = running !== undefined ? running !== 0
    : ignition !== undefined ? ignition !== 0
    : undefined;

  if (engineOn === undefined) return 'unknown';
  if (!engineOn) return 'off';

  const utilization = snapshot.get(SIGNALS.utilizationStatus);
  if (utilization !== undefined) return utilization !== 0 ? 'productive' : 'idle';

  const load = snapshot.get(SIGNALS.engineLoad);
  if (load !== undefined) return load >= loadThreshold ? 'productive' : 'idle';

  const torque = snapshot.get(SIGNALS.torque);
  if (torque !== undefined) return torque > 0 ? 'productive' : 'idle';

  return 'running-unclassified';
}

/**
 * How long a sample may speak for, measured from how often this machine reports.
 *
 * The median rather than the mean, because one overnight gap would drag a mean up
 * until the gap justified itself — which is precisely the reasoning this function
 * exists to prevent. Three intervals is the tolerance: a machine reporting every
 * minute can miss two and still be described, and the third missing minute becomes
 * unknown rather than assumed.
 */
export function carryFor(sampleTimes: number[], options: DutyCycleOptions = {}): number {
  if (options.carrySeconds !== undefined) return options.carrySeconds;

  const distinct = [...new Set(sampleTimes)].sort((a, b) => a - b);
  if (distinct.length < 2) return DEFAULT_CARRY_SECONDS;

  const gaps: number[] = [];
  for (let i = 1; i < distinct.length; i += 1) gaps.push(seconds(distinct[i] - distinct[i - 1]));
  gaps.sort((a, b) => a - b);
  const median = gaps.length % 2
    ? gaps[(gaps.length - 1) / 2]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

  const carry = median * CARRY_FACTOR;
  return Math.min(MAX_CARRY_SECONDS, Math.max(MIN_CARRY_SECONDS, carry));
}

export function computeDutyCycle(
  readings: WindowReading[],
  windowStart: Date,
  windowEnd: Date,
  options: DutyCycleOptions = {},
): DutyCycle {
  const loadThreshold = options.loadThreshold ?? DEFAULT_LOAD_THRESHOLD;
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const totalSeconds = Math.max(0, seconds(endMs - startMs));

  const wanted = new Set(DUTY_SIGNALS);
  const samples: Sample[] = readings
    .filter((r) => wanted.has(r.signal) && Number.isFinite(r.value))
    .map((r) => ({
      at: new Date(r.sourceTimestamp).getTime(),
      signal: r.signal,
      value: r.value,
      unit: r.unit ?? null,
    }))
    .filter((s) => Number.isFinite(s.at) && s.at >= startMs && s.at <= endMs)
    .sort((a, b) => a.at - b.at);

  const runtime = runtimeDeltaOf(samples);

  // The hour meter says how much, never when, so it takes no part in the timeline.
  const status = samples.filter((s) => s.signal !== SIGNALS.engineRuntime);

  const buckets: Record<DutyState, number> = {
    productive: 0, idle: 0, 'running-unclassified': 0, off: 0, unknown: 0,
  };

  const carrySeconds = carryFor(status.map((s) => s.at), options);
  const carryMs = carrySeconds * 1000;

  if (totalSeconds === 0 || status.length === 0) {
    buckets.unknown = totalSeconds;
    return assemble(
      windowStart, windowEnd, totalSeconds, buckets, carrySeconds,
      status.length, presentSignals(samples), runtime,
    );
  }

  // One breakpoint per distinct sample time, plus the far end of the window. Between
  // two breakpoints nothing the machine said can change, so the state is constant and
  // the interval can be attributed whole.
  const breakpoints = [...new Set(status.map((s) => s.at))].sort((a, b) => a - b);

  // The head of the shift, before the machine had said anything. Honest rather than
  // backfilled: a reading describes the moment it was taken and the moments shortly
  // after, and extrapolating it backwards would be a second assumption dressed as
  // symmetry with the first.
  buckets.unknown += seconds(breakpoints[0] - startMs);

  const latest = new Map<string, Sample>();
  let cursor = 0;

  for (let i = 0; i < breakpoints.length; i += 1) {
    const at = breakpoints[i];
    while (cursor < status.length && status[cursor].at <= at) {
      latest.set(status[cursor].signal, status[cursor]);
      cursor += 1;
    }

    const until = i + 1 < breakpoints.length ? breakpoints[i + 1] : endMs;

    // A sample's authority expires; the interval it cannot cover is unknown, and the
    // per-signal expiry is what makes a fleet reporting six signals at six cadences
    // degrade one signal at a time instead of all at once.
    //
    // Half-open: a sample speaks for [t, t + carry) and not for the instant it
    // expires. The closed version of this test is a real bug rather than a
    // pedantry — a sample expiring exactly on a breakpoint would be counted into
    // the classification and then cap the interval at zero length, so the time
    // went to `unknown` while a perfectly fresh signal was describing it.
    const snapshot = new Map<string, number>();
    for (const [signal, sample] of latest) {
      if (at - sample.at < carryMs) snapshot.set(signal, sample.value);
    }

    const state = classify(snapshot, loadThreshold);

    // The state holds only as far as the oldest contributing sample's authority
    // reaches. Past that the machine has stopped describing itself, whether or not a
    // later breakpoint exists.
    const authorityEnds = state === 'unknown' ? at : contributingExpiry(latest, snapshot, carryMs);
    const describedUntil = Math.min(until, Math.max(at, authorityEnds));

    buckets[state] += seconds(describedUntil - at);
    if (describedUntil < until) buckets.unknown += seconds(until - describedUntil);
  }

  return assemble(
    windowStart, windowEnd, totalSeconds, buckets, carrySeconds,
    status.length, presentSignals(samples), runtime,
  );
}

/** The moment the last of the samples behind this classification stops speaking. */
function contributingExpiry(
  latest: Map<string, Sample>, snapshot: Map<string, number>, carryMs: number,
): number {
  let expiry = Number.POSITIVE_INFINITY;
  for (const signal of snapshot.keys()) {
    const sample = latest.get(signal);
    if (sample) expiry = Math.min(expiry, sample.at + carryMs);
  }
  return expiry;
}

function presentSignals(samples: Sample[]): string[] {
  return [...new Set(samples.map((s) => s.signal))].sort();
}

/**
 * The hour meter across the window: last minus first.
 *
 * A meter that ran backwards did not un-work. It was replaced, reset, or the logger
 * was moved to another machine, and reporting a negative delta would let that flow
 * straight into a service prediction as time credited back to the interval.
 */
function runtimeDeltaOf(
  samples: Sample[],
): { delta: number | null; unit: string | null; reset: boolean } {
  const meter = samples.filter((s) => s.signal === SIGNALS.engineRuntime);
  if (meter.length < 2) {
    return { delta: null, unit: meter[0]?.unit ?? null, reset: false };
  }
  const first = meter[0];
  const last = meter[meter.length - 1];
  const delta = last.value - first.value;
  if (delta < 0) return { delta: null, unit: last.unit, reset: true };
  return { delta, unit: last.unit, reset: false };
}

function assemble(
  windowStart: Date,
  windowEnd: Date,
  totalSeconds: number,
  buckets: Record<DutyState, number>,
  carrySeconds: number,
  samples: number,
  signalsPresent: string[],
  runtime: { delta: number | null; unit: string | null; reset: boolean },
): DutyCycle {
  const round = (n: number) => Math.round(n * 1000) / 1000;

  const productiveSeconds = round(buckets.productive);
  const idleSeconds = round(buckets.idle);
  const runningUnclassifiedSeconds = round(buckets['running-unclassified']);
  const offSeconds = round(buckets.off);
  const engineOnSeconds = round(productiveSeconds + idleSeconds + runningUnclassifiedSeconds);

  // Unknown absorbs the rounding, so the five buckets sum to the window exactly. A
  // report whose parts do not add up to the shift invites the reader to work out
  // which number is wrong, and the answer would be "none of them, it is rounding".
  const unknownSeconds = round(
    Math.max(0, totalSeconds - engineOnSeconds - offSeconds),
  );

  const observed = round(engineOnSeconds + offSeconds);
  const classifiedRunning = productiveSeconds + idleSeconds;

  return {
    windowStart,
    windowEnd,
    totalSeconds: round(totalSeconds),
    productiveSeconds,
    idleSeconds,
    runningUnclassifiedSeconds,
    offSeconds,
    unknownSeconds,
    engineOnSeconds,
    carrySeconds: round(carrySeconds),
    coverage: totalSeconds > 0 ? round(observed / totalSeconds) : 0,
    utilizationRate: observed > 0 ? round(engineOnSeconds / observed) : null,
    productiveRate: classifiedRunning > 0 ? round(productiveSeconds / classifiedRunning) : null,
    idleRate: classifiedRunning > 0 ? round(idleSeconds / classifiedRunning) : null,
    runtimeDelta: runtime.delta,
    runtimeUnit: runtime.unit,
    runtimeCounterReset: runtime.reset,
    samples,
    signalsPresent,
  };
}
