/**
 * The result envelope (task QCE2 §1) — never a bare number. Three times now the
 * platform has rendered an absence as a value (D20's unlearned band, D28's vacuous
 * replay, QCE4's 13-day baseline); each time the fix was the same: make the
 * absence a state. `value` is `null` whenever `readiness !== 'ready'` — never 0,
 * never NaN, never an empty array standing in for "nothing happened".
 */
export type Readiness = 'ready' | 'blocked' | 'not_configured' | 'not_available';

export type Reason =
  | 'unbound' | 'stale' | 'no_readings' | 'mapping_required'
  | 'baseline_not_established' | 'insufficient_coverage' | 'undefined_result'
  | 'parameter_not_set' | 'site_boundary_not_set'
  // Task QFIX-BASELINE: a baseline learns only from operating periods. A machine with
  // no shift schedule has none (`not_configured`); a z-score judging a reading taken
  // while the machine was not operating has no honest answer (`not_available`).
  | 'no_shift_schedule' | 'not_operating'
  // A `not_configured` with no reason told the screen nothing it could act on. The
  // formula's own window cannot be resolved yet (a `shift` window needs the machine's
  // shift schedule, which the evaluator does not read), or the formula has no
  // compiled plan to evaluate.
  | 'window_not_resolved' | 'formula_not_compiled'
  // Task QGEO2: a formula names a geofence zone that does not apply to this machine —
  // not drawn, switched off, or aimed at other machines. Never read as "outside".
  | 'zone_not_applied';

export interface Coverage {
  expected: number;
  actual: number;
  ratio: number;
}

/** One bucketed point (task QCE2.1 §1). `v: null` is a bucket with no readings
 * in it — a gap the chart must be able to draw, never a missing point (which
 * would make the gap look like compressed time) and never `0` (which would
 * make a silent machine look like it reported zero). */
export interface SeriesPoint {
  t: string;
  v: number | null;
}

/**
 * `resultKind: 'scalar'` → `value` is `number | null`. `resultKind: 'series'`
 * → `value` is `SeriesPoint[] | null`, ascending by `t` (task QCE2.1). A plan
 * declaring `series` that produces a bare scalar is a bug, not a convention —
 * `KpiEvaluatorService` throws naming the formula key rather than silently
 * returning a number where an array was promised.
 *
 * Baseline operators (`baseline_avg`/`baseline_sd`/`zscore`/`delta_ratio`) are
 * not recomputed per bucket — they still return a single value, at the
 * window's latest instant, exactly as QCE2 built them. Declared `series`
 * because they are genuinely time-varying quantities, they come back as a
 * **one-point array**, not a bare number: `[{ t: window.to, v }]`. `value` is
 * therefore never a bare number for a `series`-kind formula, even when it only
 * has one point to show.
 */
export interface KpiEnvelope {
  formulaKey: string;
  value: number | SeriesPoint[] | null;
  unit: string;
  resultKind: 'scalar' | 'series';
  /** `null` when no window could be resolved — never empty strings, which are not
   *  dates and read as "Invalid Date" on any screen that formats them. */
  window: { from: string; to: string } | null;
  readiness: Readiness;
  reason?: Reason;
  /** With `reason: 'parameter_not_set'` (task QPARAM1 §4a): which client parameters
   * have no value at any scope for this machine, so the screen can say what to set. */
  missingParameters?: string[];
  coverage: Coverage;
}

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}
