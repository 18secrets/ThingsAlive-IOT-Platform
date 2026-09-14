import { WindowReading } from '../../alert/services/alert-rules';
import { SIGNALS } from '../../common/signals';
import { SignalBand, SignalSummary, atOrBelow, summariseSignal } from './signal-scale';

/**
 * Why this machine's data is thin, and whose problem that is (task P4-08).
 *
 * P4-05 already says *how much* of a shift went unobserved. This says *why*, and the
 * distinction is the whole point: `coverage` is a symptom that four different faults
 * produce identically, and they want four different people.
 *
 *   - The logger is buffering and the backlog is coming. Nobody does anything; the
 *     window is re-scored when it arrives, and a job raised now is a wasted trip.
 *   - The logger is reporting but the link keeps dropping. A site problem: an antenna,
 *     a position, a yard with no coverage.
 *   - The logger is dark. Either the machine is parked somewhere with no signal or the
 *     device has failed, and somebody has to go and look.
 *   - The logger is fine and its sensors are not. Nothing to do with connectivity at
 *     all, and the one case where sending a network engineer wastes everybody's day.
 *
 * A platform that reports "70% coverage" and stops has handed the diagnosis back to
 * the customer. The states below are the diagnosis, and they are ordered so that the
 * one somebody must act on wins over the one they can wait out.
 */

export type LinkState =
  | 'dark'
  | 'partial'
  | 'intermittent'
  | 'buffering'
  | 'weak-signal'
  | 'healthy'
  | 'unknown';

/** Lag above this means the logger is holding data rather than sending it. */
export const BUFFERING_LAG_SECONDS = 900;

/** A silence longer than this inside a window is a dropout, not a reporting interval. */
export const DROPOUT_SECONDS = 1800;

/** Below this fraction of its mapped signals, a device is reporting partially. */
export const PARTIAL_SIGNAL_FRACTION = 0.75;

/** A link at or below this band is worth saying so about before it fails. */
export const WEAK_BAND: SignalBand = 'fair';

export interface ArrivalStats {
  /** Readings the upstream platform recorded for this device in the window. */
  count: number;
  /** Seconds between a reading's own clock and the moment it reached the platform. */
  medianLagSeconds: number;
  maxLagSeconds: number;
}

export interface LinkInput {
  windowStart: Date;
  windowEnd: Date;
  readings: WindowReading[];
  /**
   * The signals mapped for this device, from the sensor map.
   *
   * Without it, "the device reported three signals" is unreadable — three of three is
   * perfect and three of twelve is nine dead sensors, and the number alone cannot tell
   * those apart.
   */
  expectedSignals: string[];
  /** Null when the upstream arrival times could not be read. */
  arrival: ArrivalStats | null;
}

export interface LinkHealth {
  /** Carried through so a stored verdict names the window it judged. */
  windowStart: Date;
  windowEnd: Date;
  state: LinkState;
  /** One line naming what was observed, for a screen that has to explain itself. */
  detail: string;
  signal: SignalSummary;
  /** Seconds of the window with no reading at all, longest single stretch. */
  longestGapSeconds: number | null;
  medianLagSeconds: number | null;
  maxLagSeconds: number | null;
  reportedSignals: string[];
  missingSignals: string[];
  samples: number;
  windowSeconds: number;
}

export function assessLink(input: LinkInput): LinkHealth {
  const startMs = input.windowStart.getTime();
  const endMs = input.windowEnd.getTime();
  const windowSeconds = Math.max(0, (endMs - startMs) / 1000);

  const inWindow = input.readings
    .map((r) => ({ ...r, at: new Date(r.sourceTimestamp).getTime() }))
    .filter((r) => Number.isFinite(r.at) && r.at >= startMs && r.at <= endMs)
    .sort((a, b) => a.at - b.at);

  const reportedSignals = [...new Set(inWindow.map((r) => r.signal))].sort();
  const expected = [...new Set(input.expectedSignals)].sort();
  const missingSignals = expected.filter((s) => !reportedSignals.includes(s));

  const signal = summariseSignal(
    inWindow.filter((r) => r.signal === SIGNALS.gsmSignalStrength).map((r) => r.value),
  );

  const base = {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    signal,
    longestGapSeconds: longestGap(inWindow.map((r) => r.at), startMs, endMs),
    medianLagSeconds: input.arrival?.medianLagSeconds ?? null,
    maxLagSeconds: input.arrival?.maxLagSeconds ?? null,
    reportedSignals,
    missingSignals,
    samples: inWindow.length,
    windowSeconds,
  };

  // Nothing at all. First, because every other verdict below is a statement about
  // readings that exist, and a silent device makes all of them vacuous.
  if (inWindow.length === 0) {
    // Except: the platform may hold readings for this window that have not reached
    // 2.0 yet. Silence here with arrivals upstream is a sync problem on our side, not
    // a dead logger, and sending somebody to a yard for it would be our mistake.
    if (input.arrival && input.arrival.count > 0) {
      return {
        ...base, state: 'buffering',
        detail: `${input.arrival.count} reading(s) exist upstream for this window but have `
          + 'not been ingested here yet.',
      };
    }
    return {
      ...base, state: 'dark',
      detail: 'No readings at all in this window, and none recorded upstream either.',
    };
  }

  // The device is up, so a connectivity verdict would be wrong. Sensors are a
  // different trade and a different person; saying "weak signal" here sends a network
  // engineer to a machine whose radio is fine.
  if (expected.length > 0 && reportedSignals.length < expected.length * PARTIAL_SIGNAL_FRACTION) {
    return {
      ...base, state: 'partial',
      detail: `Reporting ${reportedSignals.length} of ${expected.length} mapped signals. `
        + `Missing: ${missingSignals.slice(0, 6).join(', ')}`
        + (missingSignals.length > 6 ? `, and ${missingSignals.length - 6} more.` : '.'),
    };
  }

  // A dropout is the link failing while the device keeps working, and it is the state
  // that costs a customer a prediction: the window scores on part of itself and the
  // rest never arrives, because the logger had nothing to hold.
  const gap = base.longestGapSeconds;
  if (gap !== null && gap >= DROPOUT_SECONDS) {
    return {
      ...base, state: 'intermittent',
      detail: `Longest silence ${Math.round(gap / 60)} minutes inside a `
        + `${Math.round(windowSeconds / 60)}-minute window.`,
    };
  }

  // Reporting steadily, but hours behind. The data is complete and late, which is a
  // different thing from missing and must not be dressed as a fault: acting on it
  // means waiting, and the window will be re-scored when the backlog lands.
  if (input.arrival && input.arrival.medianLagSeconds >= BUFFERING_LAG_SECONDS) {
    return {
      ...base, state: 'buffering',
      detail: `Readings arriving a median of ${Math.round(input.arrival.medianLagSeconds / 60)} `
        + 'minutes after they were taken. Complete, and late.',
    };
  }

  // Nothing is wrong yet. Said anyway, because a link running at the edge is the one
  // that drops next month, and it is cheap to fix while somebody is already on site.
  if (signal.worstBand && atOrBelow(signal.worstBand, WEAK_BAND)) {
    return {
      ...base, state: 'weak-signal',
      detail: `Signal fell to ${signal.worst} (${signal.worstBand}) on the `
        + `${signal.scale} scale during this window.`,
    };
  }

  return { ...base, state: 'healthy', detail: 'Reporting steadily, on time.' };
}

/**
 * The longest stretch of the window with no reading, including the ends.
 *
 * The ends count deliberately. A device that went quiet an hour before the shift ended
 * has an hour-long gap, and measuring only between readings would score it perfect —
 * which is the exact moment somebody wants to be told.
 */
function longestGap(times: number[], startMs: number, endMs: number): number | null {
  if (endMs <= startMs) return null;
  if (times.length === 0) return (endMs - startMs) / 1000;

  let longest = times[0] - startMs;
  for (let i = 1; i < times.length; i += 1) {
    longest = Math.max(longest, times[i] - times[i - 1]);
  }
  longest = Math.max(longest, endMs - times[times.length - 1]);
  return longest / 1000;
}
