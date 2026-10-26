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

/**
 * Which readings a baseline may learn from (task QFIX-BASELINE): only those taken while
 * the machine was operating — inside a scheduled shift with the engine on, the gate
 * Availability applies (`operatingIntervals`). A running engine and a parked one are two
 * populations; averaging them puts the mean between the clusters and makes σ the
 * distance between them, so a healthy machine read ±1.5σ every day.
 *
 * Optional only so the reference semantics above stay testable on their own. The KPI
 * evaluator always passes one; there is no path through it to an ungated baseline.
 */
export interface OperatingGate {
  /** False when the machine has no shift schedule — there is nothing to gate on. */
  scheduled: boolean;
  periods: ExcludedRange[];
  /** Whether any engine-state reading fell in the window. Scheduled but unobserved, the
   * periods are empty because nobody knows, not because the machine never ran. */
  observed?: boolean;
}

/**
 * The least operating data a baseline is computed from (QFIX-BASELINE §3). Below
 * either, the answer is `insufficient_coverage`, never a baseline from four hours
 * and never the unfiltered window.
 *
 * - **Days** carries the four-hours case whatever the logger's cadence: a σ from one
 *   afternoon describes that afternoon. Seven is about two-thirds of the ten working
 *   days a five-day schedule fits into the 14-day minimum, so a young machine that
 *   missed a few shifts still qualifies and one that ran on two days does not. The
 *   seeded demo has 22 operating days in its 30-day window.
 * - **Readings** is the floor under a sparse logger. σ's own sampling error is about
 *   1/√(2n): 18% at 15, which moves a z of 2 to anywhere from 1.7 to 2.4. The demo
 *   has 1,239 operating readings in 30 days, so the measurements never bind it; what
 *   bounds it from above is the one-reading-a-day fixtures in the evaluator specs,
 *   which keep 18 after a dirty-window exclusion.
 */
export const BASELINE_COVERAGE = { minOperatingReadings: 15, minOperatingDays: 7 } as const;

export type BaselineReason =
  | 'baseline_not_established' | 'insufficient_coverage' | 'not_operating' | 'no_shift_schedule';

export type BaselineValue =
  | { established: true; value: number }
  | { established: false; reason: BaselineReason };

const NOT_ESTABLISHED: BaselineValue = { established: false, reason: 'baseline_not_established' };
const INSUFFICIENT_COVERAGE: BaselineValue = { established: false, reason: 'insufficient_coverage' };
const NOT_OPERATING: BaselineValue = { established: false, reason: 'not_operating' };
const NO_SHIFT_SCHEDULE: BaselineValue = { established: false, reason: 'no_shift_schedule' };

const isExcluded = (at: Date, excluded: ExcludedRange[]): boolean =>
  excluded.some((r) => at >= r.start && at < r.end);

const distinctDays = (rows: Reading[]): number =>
  new Set(rows.map((r) => r.at.toISOString().slice(0, 10))).size;

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

/**
 * The rows a baseline is computed over, or why there are none worth using. The order
 * is the order of remedies: no schedule is a configuration gap, short history is time,
 * thin operating data is the machine not having worked enough yet. Elapsed history is
 * judged on every reading — `baseline_not_established` keeps its meaning — and only
 * then is the window narrowed to operating periods.
 *
 * `minimum` is false for a leg that is short by design (`delta_ratio`'s `w1`); such a
 * leg still needs one operating reading, or there is nothing to average.
 */
function baselineRows(
  readings: Reading[], asOf: Date, hours: number, excluded: ExcludedRange[],
  operating: OperatingGate | undefined, minimum: boolean,
): Reading[] | BaselineValue {
  if (operating && !operating.scheduled) return NO_SHIFT_SCHEDULE;
  const rows = windowed(readings, asOf, hours, excluded);
  if (!rows.length) return NOT_ESTABLISHED;
  if (minimum && !reachesMinimum(rows, asOf)) return NOT_ESTABLISHED;
  if (!operating) return rows;

  const kept = rows.filter((r) => isExcluded(r.at, operating.periods));
  if (!kept.length) return INSUFFICIENT_COVERAGE;
  if (minimum && (kept.length < BASELINE_COVERAGE.minOperatingReadings
    || distinctDays(kept) < BASELINE_COVERAGE.minOperatingDays)) return INSUFFICIENT_COVERAGE;
  return kept;
}

function trailingMean(
  readings: Reading[],
  asOf: Date,
  hours: number,
  excluded: ExcludedRange[],
  requireMinHistory: boolean,
  operating?: OperatingGate,
): BaselineValue {
  const rows = baselineRows(readings, asOf, hours, excluded, operating, requireMinHistory);
  if (!Array.isArray(rows)) return rows;
  return { established: true, value: rows.reduce((sum, r) => sum + r.value, 0) / rows.length };
}

export function baselineAvg(
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
  operating?: OperatingGate,
): BaselineValue {
  return trailingMean(readings, asOf, windowHours, excluded, true, operating);
}

export function baselineSd(
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
  operating?: OperatingGate,
): BaselineValue {
  const rows = baselineRows(readings, asOf, windowHours, excluded, operating, true);
  if (!Array.isArray(rows)) return rows;
  const mean = rows.reduce((sum, r) => sum + r.value, 0) / rows.length;
  const variance = rows.reduce((sum, r) => sum + (r.value - mean) ** 2, 0) / rows.length;
  return { established: true, value: Math.sqrt(variance) };
}

/** `(current − baseline_avg) / baseline_sd`. A zero-variance baseline (a long flat
 * history) followed by one extreme current reading divides by zero on purpose —
 * `Infinity` is large, which is exactly what a z-score threshold needs it to be; it
 * is not special-cased away.
 *
 * Gated, the reading being judged must itself be an operating one (QFIX-BASELINE).
 * A parked engine's coolant against a running engine's baseline reads about −21σ —
 * a worse version of the defect the gate removes — so it is `not_operating`, with no
 * number, rather than an excursion nobody should act on. `currentAt` is when it was
 * taken. */
export function zscore(
  current: number,
  readings: Reading[],
  asOf: Date,
  windowHours: number,
  excluded: ExcludedRange[] = [],
  operating?: OperatingGate,
  currentAt?: Date,
): BaselineValue {
  const avg = baselineAvg(readings, asOf, windowHours, excluded, operating);
  if (!avg.established) return avg;
  const sd = baselineSd(readings, asOf, windowHours, excluded, operating);
  if (!sd.established) return sd;
  if (operating) {
    if (!currentAt) throw new Error('zscore: a gated z-score needs the time of the reading it judges.');
    if (!isExcluded(currentAt, operating.periods)) return NOT_OPERATING;
  }
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
  operating?: OperatingGate,
): BaselineValue {
  // `w2` first: when both legs fail, the machine's history is the more useful answer.
  const baseline = trailingMean(readings, asOf, w2Hours, excluded, true, operating);
  if (!baseline.established) return baseline;
  const recent = trailingMean(readings, asOf, w1Hours, excluded, false, operating);
  if (!recent.established) return recent;
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
