import { WindowReading } from '../../alert/services/alert-rules';

/**
 * Did the machine actually run during this shift? (tasks P1-118, P1-123)
 *
 * Things Alive said the equipment status comes from the backend. It turns out it comes
 * from the telemetry that is already flowing through the pipe 2.0 reads:
 * `engine_running_status` is an ordinary sensor measurement alongside coolant
 * temperature and oil pressure, and their own shift metrics are configured against it
 * (`SHIFT_METRICS_ENGINE_ON_MEASUREMENT_NAME`). So this needs no second integration,
 * no API client and no extra route through anybody's firewall.
 *
 * Why it matters more than telling a screen "offline". A machine whose logger reported
 * all shift while the engine never turned over produces a shift's worth of readings
 * that look like telemetry and describe nothing: cold, still, unloaded. Scoring that
 * against a baseline built from a working machine is not a near-miss — it is a
 * confident answer about a machine that was not there.
 *
 * Three outcomes, and the third is the honest one. If the signal is absent the machine
 * has not said it was idle; it has said nothing about whether it was, and treating
 * that as "not running" would silently stop scoring every fleet that does not report
 * the signal.
 */
export type RunningStatus = 'running' | 'not-running' | 'unknown';

/** Their configured name for it. Theirs is configurable; ours follows if it changes. */
export const RUNNING_SIGNAL = 'engine_running_status';

/** Their configured "on" value. Anything else is off. */
export const RUNNING_VALUE = 1;

export function runningStatusFor(
  readings: WindowReading[],
  signal: string = RUNNING_SIGNAL,
  onValue: number = RUNNING_VALUE,
): RunningStatus {
  const reported = readings.filter((r) => r.signal === signal);
  if (reported.length === 0) return 'unknown';
  // One sample of it running is enough. A machine that ran for twenty minutes of an
  // eight-hour shift did run, and the readings from those twenty minutes are worth
  // scoring; demanding a majority would quietly discard every short job.
  return reported.some((r) => r.value === onValue) ? 'running' : 'not-running';
}
