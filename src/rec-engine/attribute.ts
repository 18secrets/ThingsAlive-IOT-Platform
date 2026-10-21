import { SEVERITY_ORDER, Severity } from '../common/severity';
import { FailureModeStatus } from '../page/page-widgets';

/**
 * Whether a failure mode is happening, as far as anyone can tell (task QPAGE1 §4, then
 * QREC1 §3). One function, two callers — the page's `failure_modes` widget and the
 * recommendation engine's Attribute step — because two versions of this rule would be
 * two answers to "is this machine overheating" on one screen.
 *
 * - `active`: an open alert's rule watches one of the mode's signals.
 * - `unknown`: nothing points at the mode, but something stops us saying it is clear —
 *   one of its signals cannot be seen (unbound, stale, never read, or a forecast band
 *   not yet established), or an open alert came from a rule that names no signal and
 *   might be this failure. "We could not see" is not "clear" (G04).
 * - `clear`: every named signal was observed and nothing points at it.
 *
 * `unobservedSignals` defaults to none so a caller that has not looked keeps the old
 * answer only if it really did see every signal; both callers pass it.
 */
export function failureModeStatus(
  modeSignals: readonly string[], openAlertSignals: readonly (string | null)[],
  unobservedSignals: readonly string[] = [],
): FailureModeStatus {
  if (openAlertSignals.some((s) => s !== null && modeSignals.includes(s))) return 'active';
  if (modeSignals.some((s) => unobservedSignals.includes(s))) return 'unknown';
  if (openAlertSignals.some((s) => s === null)) return 'unknown';
  return 'clear';
}

const STATUS_RANK: Record<FailureModeStatus, number> = { active: 0, unknown: 1, clear: 2 };

/**
 * The order Attribute lists modes in (QREC1 §3.1). A sort, not a likelihood: there is no
 * probability on this list (G07), and the order is total so a replay is byte-identical.
 */
export function compareModes(
  a: { status: FailureModeStatus; matchedSignals: string[]; severity: Severity | null; failureModeCode: string },
  b: { status: FailureModeStatus; matchedSignals: string[]; severity: Severity | null; failureModeCode: string },
): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.matchedSignals.length - a.matchedSignals.length
    || severityRank(b.severity) - severityRank(a.severity)
    || (a.failureModeCode < b.failureModeCode ? -1 : a.failureModeCode > b.failureModeCode ? 1 : 0);
}

/** Higher is worse; an undeclared severity (D32) sorts after every declared one. */
function severityRank(s: Severity | null): number {
  return s === null ? -1 : SEVERITY_ORDER.indexOf(s);
}

/** The entity's declared order of urgency (QREC1 §3.3). */
export const URGENCY_ORDER = ['immediate', 'next_shift', 'next_service', 'monitor'] as const;
