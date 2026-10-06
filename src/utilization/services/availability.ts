import { WindowReading } from '../../alert/services/alert-rules';
import { ShiftDefinition, windowsEndingBetween } from '../../shift/services/shift-window';
import { computeDutyCycle, DUTY_SIGNALS } from './duty-cycle';
import { SIGNALS } from '../../common/signals';

/**
 * Availability — uptime against the hours the plant scheduled (task QAVAIL1).
 *
 * Not OEE. OEE is availability × performance × quality, and nothing in telemetry
 * reports units produced or good units, so the other two factors have no source. A
 * number labelled OEE that is really availability is one a customer will check
 * against their own, find wrong, and stop trusting everything else on the page for.
 *
 * The definitions are decisions, recorded beside what implements them:
 *
 *  - **Scheduled hours** — the machine's shift windows inside the period, and only the
 *    part inside it: a period boundary that cuts a shift in half counts half the shift.
 *    No shift defined means no scheduled hours, not a day's worth assumed.
 *  - **Uptime hours** — engine-on time inside those windows, from the same
 *    classification the shift runner already records (`computeDutyCycle`: running
 *    status, falling back to ignition). Unchanged, so this number and the utilization
 *    report can never disagree about whether the engine was on.
 *  - **Downtime hours** — scheduled minus uptime. Not wall-clock, not idle outside a
 *    shift. A logger that went quiet mid-shift therefore counts as downtime: the
 *    machine was scheduled and nothing showed it running.
 *  - **Availability** — uptime ÷ scheduled, a ratio.
 *
 * Running outside every shift window counts toward neither side. It is unscheduled
 * work, and counting it as uptime lets availability pass 100%, at which point the
 * number means nothing. It is reported as `unscheduledRunningHours` instead, so it is
 * visible rather than discarded.
 */

export type AvailabilityReadiness = 'ready' | 'not_configured' | 'not_available';
export type AvailabilityReason = 'no_shift_schedule' | 'no_readings';

export interface Availability {
  scheduledHours: number;
  /** Null when nothing was observed: zero would read as a machine that sat still. */
  uptimeHours: number | null;
  /** Null when nothing was observed: the whole schedule as downtime would be invented. */
  downtimeHours: number | null;
  unscheduledRunningHours: number | null;
  /** Null whenever `readiness` is not `ready` — a caller that ignores readiness fails loudly. */
  availability: number | null;
  readiness: AvailabilityReadiness;
  reason?: AvailabilityReason;
}

export interface Period {
  from: Date;
  to: Date;
}

interface Interval {
  start: number;
  end: number;
}

const HOUR_MS = 3_600_000;
const round = (x: number) => Math.round(x * 1000) / 1000;

/** The signals that say whether the engine was on. The hour meter says how much, never when. */
export const AVAILABILITY_SIGNALS: readonly string[] =
  DUTY_SIGNALS.filter((s) => s !== SIGNALS.engineRuntime);

/**
 * Every shift window that overlaps the period, clipped to it and merged.
 *
 * `windowsEndingBetween` answers "which shifts ended in (after, upTo]", so the upper
 * bound is pushed out by two days to catch a shift that starts inside the period and
 * ends after it — the longest shift a definition can describe is under 48 hours.
 * Merged because two shifts on one machine are refused on write when they overlap,
 * but a retired-and-recreated pair is not, and an hour counted twice is an hour of
 * scheduled time nobody scheduled.
 */
export function scheduledIntervals(shifts: readonly ShiftDefinition[], period: Period): Interval[] {
  const from = period.from.getTime();
  const to = period.to.getTime();
  if (to <= from) return [];

  const clipped: Interval[] = [];
  for (const shift of shifts) {
    const windows = windowsEndingBetween(shift, period.from, new Date(to + 2 * 24 * HOUR_MS));
    for (const w of windows) {
      const start = Math.max(w.start.getTime(), from);
      const end = Math.min(w.end.getTime(), to);
      if (end > start) clipped.push({ start, end });
    }
  }
  return merge(clipped);
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** The parts of the period no shift covers. Where unscheduled running is looked for. */
function complement(scheduled: Interval[], period: Period): Interval[] {
  const out: Interval[] = [];
  let cursor = period.from.getTime();
  for (const s of scheduled) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < period.to.getTime()) out.push({ start: cursor, end: period.to.getTime() });
  return out;
}

function engineOnHours(readings: WindowReading[], intervals: Interval[]): number {
  let seconds = 0;
  for (const i of intervals) {
    seconds += computeDutyCycle(readings, new Date(i.start), new Date(i.end)).engineOnSeconds;
  }
  return seconds / 3600;
}

/**
 * One machine's availability over a period.
 *
 * `shifts` are the machine's active shift definitions. An empty list is the common
 * case at first — the runner is on, few machines have shifts — and the answer is
 * `no_shift_schedule`, not 0% and not 100%. The same when shifts exist but none falls
 * inside the period: there were no scheduled hours to be available for, and a ratio
 * over nothing is not a number.
 */
export function computeAvailability(
  shifts: readonly ShiftDefinition[], readings: WindowReading[], period: Period,
): Availability {
  const wanted = new Set(AVAILABILITY_SIGNALS);
  const from = period.from.getTime();
  const to = period.to.getTime();
  const observed = readings.filter((r) => {
    if (!wanted.has(r.signal) || !Number.isFinite(r.value)) return false;
    const at = new Date(r.sourceTimestamp).getTime();
    return at >= from && at < to;
  });

  const scheduled = scheduledIntervals(shifts, period);
  const scheduledHours = round(scheduled.reduce((sum, i) => sum + (i.end - i.start), 0) / HOUR_MS);

  // Measured whether or not there is a schedule: a machine running with no shift
  // defined is exactly the one whose owner most needs to see it.
  const unscheduledRunningHours = observed.length
    ? round(engineOnHours(observed, complement(scheduled, period)))
    : null;

  if (scheduledHours === 0) {
    return {
      scheduledHours: 0, uptimeHours: null, downtimeHours: null, unscheduledRunningHours,
      availability: null, readiness: 'not_configured', reason: 'no_shift_schedule',
    };
  }

  // Scheduled, and nothing in the period said whether the engine was on. Not 0:
  // a machine whose logger was off the network is not a machine that was down.
  if (!observed.length) {
    return {
      scheduledHours, uptimeHours: null, downtimeHours: null, unscheduledRunningHours: null,
      availability: null, readiness: 'not_available', reason: 'no_readings',
    };
  }

  const uptimeHours = round(engineOnHours(observed, scheduled));
  return {
    scheduledHours,
    uptimeHours,
    downtimeHours: round(Math.max(0, scheduledHours - uptimeHours)),
    unscheduledRunningHours,
    availability: round(Math.min(1, uptimeHours / scheduledHours)),
    readiness: 'ready',
  };
}

export interface FleetAvailability extends Availability {
  /** Machines whose hours are in the sums above. */
  machinesMeasured: number;
  /** Left out of the sums, by reason. An average over unmeasured machines is fabricated. */
  excluded: { noShiftSchedule: number; noReadings: number };
}

/**
 * The fleet, summed in hours — never an average of per-machine ratios.
 *
 * Averaging ratios gives a machine on a four-hour shift the same weight as one on
 * twelve, the same trap `UtilizationService.rates` documents. Machines without a
 * schedule, or without a reading, are excluded and counted, so the summary says how
 * much of the fleet it describes.
 */
export function aggregateAvailability(machines: readonly Availability[]): FleetAvailability {
  const ready = machines.filter((m) => m.readiness === 'ready');
  const excluded = {
    noShiftSchedule: machines.filter((m) => m.reason === 'no_shift_schedule').length,
    noReadings: machines.filter((m) => m.reason === 'no_readings').length,
  };
  const sum = (pick: (m: Availability) => number | null) =>
    round(ready.reduce((total, m) => total + (pick(m) ?? 0), 0));

  if (!ready.length) {
    const reason: AvailabilityReason = excluded.noReadings ? 'no_readings' : 'no_shift_schedule';
    return {
      scheduledHours: 0, uptimeHours: null, downtimeHours: null, unscheduledRunningHours: null,
      availability: null,
      readiness: reason === 'no_readings' ? 'not_available' : 'not_configured',
      reason, machinesMeasured: 0, excluded,
    };
  }

  const scheduledHours = sum((m) => m.scheduledHours);
  const uptimeHours = sum((m) => m.uptimeHours);
  return {
    scheduledHours,
    uptimeHours,
    downtimeHours: sum((m) => m.downtimeHours),
    unscheduledRunningHours: sum((m) => m.unscheduledRunningHours),
    availability: round(Math.min(1, uptimeHours / scheduledHours)),
    readiness: 'ready',
    machinesMeasured: ready.length,
    excluded,
  };
}
