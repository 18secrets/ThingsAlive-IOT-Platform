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
  | 'baseline_not_established' | 'insufficient_coverage' | 'undefined_result';

export interface Coverage {
  expected: number;
  actual: number;
  ratio: number;
}

/**
 * `value` is `number | null` only in this slice — never an array. A true
 * per-point rolling series (what a chart-type widget would draw for `zscore`
 * over a window) needs a materialised read path, which QCE2 explicitly scopes
 * out ("caching or materialising results"); `resultKind: 'series'` here means a
 * live value for a time-varying quantity, evaluated once at the window's latest
 * instant, not one value per reading. Reported, not silently narrowed.
 */
export interface KpiEnvelope {
  formulaKey: string;
  value: number | null;
  unit: string;
  resultKind: 'scalar' | 'series';
  window: { from: string; to: string };
  readiness: Readiness;
  reason?: Reason;
  coverage: Coverage;
}

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}
