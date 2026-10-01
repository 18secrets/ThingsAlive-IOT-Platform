/**
 * Reference semantics for the four baseline operators (task QCE4): pure arithmetic
 * over caller-supplied readings, proving the three rules this task owns — current-
 * period exclusion, the 14-day minimum, and dirty-window exclusion — independent of
 * QCE2, which does not exist yet and is where a real engine would assemble
 * `readings`/exclusion ranges from `telemetry_reading`, `alert_event` and
 * `work_order`. Nothing here reads a database.
 *
 * Same threshold and same three-state reasoning as D20's residual bands
 * (`ai-layer-decisions.md`): a baseline computed over too little history is noise
 * presented as authority, and a baseline learned during a fault encodes the fault as
 * normal. `baseline_not_established` is its own state — never `0`, never `null`
 * silently, and never rendered as "normal".
 */

/** D20's own threshold, reused rather than re-decided (task QCE4 §2). */
export const MIN_BASELINE_DAYS = 14;

export interface Reading {
  at: Date;
  value: number;
}

/** A period to drop from a baseline window before computing anything over it —
 * built by `alertExcludedRanges` / `openWorkOrderExcludedRanges` below, or by
 * whatever QCE2 eventually assembles instead. */
export interface ExcludedRange {
  start: Date;
  end: Date;
}

export type BaselineValue =
  | { established: true; value: number }
  | { established: false; reason: 'baseline_not_established' };

const NOT_ESTABLISHED: BaselineValue = { established: false, reason: 'baseline_not_established' };

const isExcluded = (at: Date, excluded: ExcludedRange[]): boolean =>
  excluded.some((r) => at >= r.start && at < r.end);

/** Readings strictly before `asOf`, inside the trailing `hours` window, with any
 * dirty period removed. Strictly before: the current period is excluded from its own
 * baseline (QCE4 §1) — a baseline that includes the reading being judged damps
 * exactly the excursion it exists to find. */
function windowed(readings: Reading[], asOf: Date, hours: number, excluded: ExcludedRange[]): Reading[] {
  const windowStart = new Date(asOf.getTime() - hours * 3_600_000);
  return readings
    .filter((r) => r.at >= windowStart && r.at < asOf)
    .filter((r) => !isExcluded(r.at, excluded));
}

/** Whether the earliest reading remaining in `rows` reaches back far enough from
 * `asOf` — the same check whether the shortfall is a young machine or an exclusion
 * that ate most of the window (QCE4 §2–3 are one check, not two). */
function reachesMinimum(rows: Reading[], asOf: Date): boolean {
  if (!rows.length) return false;
  const earliest = Math.min(...rows.map((r) => r.at.getTime()));
  return asOf.getTime() - earliest >= MIN_BASELINE_DAYS * 86_400_000;
}

function trailingMean(
  readings: Reading[],
  asOf: Date,
  hours: number,
  excluded: ExcludedRange[],
  requireMinHistory: boolean,
): BaselineValue {
  const rows = windowed(readings, asOf, hours, excluded);
  if (!rows.length) return NOT_ESTABLISHED;
  if (requireMinHistory && !reachesMinimum(rows, asOf)) return NOT_ESTABLISHED;
  return { established: true, value: rows.reduce((sum, r) => sum + r.value, 0) / rows.length };
}

export function baselineAvg(
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
): BaselineValue {
  return trailingMean(readings, asOf, windowHours, excluded, true);
}

export function baselineSd(
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
): BaselineValue {
  const rows = windowed(readings, asOf, windowHours, excluded);
  if (!rows.length) return NOT_ESTABLISHED;
  if (!reachesMinimum(rows, asOf)) return NOT_ESTABLISHED;
  const mean = rows.reduce((sum, r) => sum + r.value, 0) / rows.length;
  const variance = rows.reduce((sum, r) => sum + (r.value - mean) ** 2, 0) / rows.length;
  return { established: true, value: Math.sqrt(variance) };
}

/** `(current − baseline_avg) / baseline_sd`. A zero-variance baseline (a long flat
 * history) followed by one extreme current reading divides by zero on purpose —
 * `Infinity` is large, which is exactly what a z-score threshold needs it to be; it
 * is not special-cased away. */
export function zscore(
  current: number,
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
): BaselineValue {
  const avg = baselineAvg(readings, asOf, windowHours, excluded);
  const sd = baselineSd(readings, asOf, windowHours, excluded);
  if (!avg.established || !sd.established) return NOT_ESTABLISHED;
  return { established: true, value: (current - avg.value) / sd.value };
}

/**
 * `mean(w1) / mean(w2)` — the 7-day-vs-90-day shape (QCE4 §1).
 *
 * The 14-day minimum is checked against `w2` only. `w1` is deliberately shorter than
 * 14 days by design (a 7-day leg compared against a 90-day one) — requiring 14 days
 * *inside* a 7-day window can never be satisfied, which would make the operator
 * permanently `baseline_not_established` regardless of how mature the signal is.
 * The minimum instead gates on the leg that is actually standing in for "the
 * machine's own history" (`w2`); `w1` only needs at least one reading to average.
 * Flagged in the task report as a judgment call, not a literal reading of "below 14
 * days of history in the window."
 */
export function deltaRatio(
  readings: Reading[],
  asOf: Date,
  w1Hours: number,
  w2Hours: number,
  excluded: ExcludedRange[] = [],
): BaselineValue {
  const recent = trailingMean(readings, asOf, w1Hours, excluded, false);
  const baseline = trailingMean(readings, asOf, w2Hours, excluded, true);
  if (!recent.established || !baseline.established) return NOT_ESTABLISHED;
  return { established: true, value: recent.value / baseline.value };
}

// --------------------------------------------------- dirty-window exclusion (§3)

/** `alert_event` rows for one signal — the caller's job is the join (tenant, asset,
 * signal); this only turns firing/resolution timestamps into excluded ranges. An
 * alert still open at `asOf` excludes through `asOf` itself. */
export interface AlertSpan {
  firedAt: Date;
  resolvedAt: Date | null;
}

export function alertExcludedRanges(events: AlertSpan[], asOf: Date): ExcludedRange[] {
  return events.map((e) => ({ start: e.firedAt, end: e.resolvedAt ?? asOf }));
}

/** `work_order` rows for one machine. Coarser than an alert on purpose — a work
 * order has no signal column (`src/work/entities/work-order.entity.ts`); D20 and
 * QCE4 both say "an open work order on the machine", not "on the signal", so every
 * signal on that machine is excluded for the order's duration, not just one. */
export interface WorkOrderSpan {
  status: 'created' | 'in-progress' | 'completed' | 'cancelled';
  startedAt: Date | null;
  createdAt: Date;
  endedAt: Date | null;
}

const OPEN_WORK_ORDER_STATUSES = new Set(['created', 'in-progress']);

export function openWorkOrderExcludedRanges(orders: WorkOrderSpan[], asOf: Date): ExcludedRange[] {
  return orders
    .filter((o) => OPEN_WORK_ORDER_STATUSES.has(o.status))
    .map((o) => ({ start: o.startedAt ?? o.createdAt, end: o.endedAt ?? asOf }));
}
