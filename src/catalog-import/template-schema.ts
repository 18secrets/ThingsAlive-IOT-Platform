import { RECOMMENDATION_URGENCY_VALUES } from '../catalog/entities/equipment-class-recommendation.entity';
import { WIDGET_SIZES, WIDGET_TYPES } from '../catalog/layout/widget-types';

/**
 * The one shape the template generator writes and the parser reads (task QIMP1).
 *
 * Both sides import this file rather than each declaring their own column list,
 * because a template that drifted from what the parser expects is exactly the
 * "changed shape, read with the old meanings" failure this slice exists to prevent.
 */
// v1 -> v2: default_threshold changed shape (comparator/value -> min/max), because
// comparator/value described a threshold the alert engine cannot run — see the
// column comment below. A v1 workbook is refused by template_version rather than
// silently misread with the old column meanings.
//
// v2 -> v3: expected_signal, sensor_requirement and default_threshold — three sheets
// that each registered class+signal facts under a different name — are replaced by
// one `signal` sheet, keyed (class_slug, signal, component_scope). Three sheets
// naming the same signal were three chances for them to disagree; one row per signal
// per machine is how a person actually thinks about it. `measurement_role` and
// `canonical_unit` are gone as separate columns — `signal` and `unit` now feed both
// expected_signals and equipment_class_sensor_requirement directly, which makes
// QL1's role-must-be-declared trigger impossible to violate from an import, by
// construction rather than by validation. A v2 workbook is refused by
// template_version rather than silently read against column names it no longer has.
//
// v3 -> v4 (task QREC0a), the bump deferred three times, everything at once:
// stale_after_seconds and the forecast declaration on `signal`, the seven KPI
// presentation fields on `formula` under the database's own column names, severity
// on `failure_mode`, and a new `recommendation` sheet. Unlike v1 and v2, a v3
// workbook is NOT refused: nothing v4 added changes what a v3 column means, every
// addition is optional, and the library team has v3 work in flight. It loads with
// the defaults, and the diff names the v4 capabilities it is not using. A workbook
// stamped v3 that carries a v4 column or sheet is refused instead — it is claiming
// a shape it does not have.
//
// v4 -> v5 (task QCLASS-OEM): six optional columns on `equipment_class` carrying the
// OEM figures OEE needs — nominal fuel per productive hour and its unit, the idle
// breakdown threshold, the running signal with its idle bound, and the availability
// signal. Added the way v4 was: nothing earlier changes meaning, so v3 and v4
// workbooks still load, and an older stamp carrying a newer column is refused.
export const TEMPLATE_VERSION = 'v5';
export const ACCEPTED_TEMPLATE_VERSIONS = ['v3', 'v4', 'v5'];

export type TemplateVersion = 'v3' | 'v4' | 'v5';

/** Whether a workbook stamped `version` predates something introduced in `since`. */
export function predates(version: string, since: TemplateVersion): boolean {
  return Number(version.replace(/^v/, '')) < Number(since.replace(/^v/, ''));
}

export interface SheetColumn {
  name: string;
  /** A blank cell here rejects the row. Declared per sheet, not inferred from data. */
  requiredCell: boolean;
  /** Comma-separated in the cell: failure_mode.signals, signal.enables, formula.inputs. */
  multiValue?: boolean;
  /** TRUE/FALSE in the cell, parsed to a boolean: signal.required, signal.forecast_enabled. */
  boolean?: boolean;
  /** The template version that introduced the column. Absent means v3 or earlier. */
  since?: TemplateVersion;
}

export interface SheetSchema {
  sheet: string;
  entityKind: string;
  columns: SheetColumn[];
  /** One filled row, so the template is never handed over as a blank shell. */
  example: Record<string, string | number>;
  /** The template version that introduced the sheet. Absent means v3 or earlier. */
  since?: TemplateVersion;
}

export const META_SHEET: SheetSchema = {
  sheet: '_meta',
  entityKind: 'meta',
  columns: [
    { name: 'template_version', requiredCell: true },
    { name: 'generated_at', requiredCell: true },
    { name: 'author', requiredCell: false },
  ],
  example: { template_version: TEMPLATE_VERSION, generated_at: '', author: 'Jane Doe (Things Alive)' },
};

/**
 * Which cell is required, per sheet, is this file's call to make — the task names the
 * columns but not which are mandatory. Chosen so a row can identify what it describes
 * (the slugs and keys) and say the one thing that makes it that kind of row; everything
 * else is left to a domain reviewer, which is what QIMP2's semantic validation is for.
 */
export const CONTENT_SHEETS: SheetSchema[] = [
  {
    sheet: 'equipment_class',
    entityKind: 'equipment_class',
    columns: [
      { name: 'slug', requiredCell: true },
      { name: 'name', requiredCell: true },
      { name: 'description', requiredCell: false },
      { name: 'category', requiredCell: false },
      { name: 'service_interval_hours', requiredCell: false },
      // OEM figures (v5). The example leaves them blank on purpose: a template that
      // ships a nominal teaches people to copy it, and a nominal is the OEM's number.
      { name: 'nominal_fuel_per_hour', requiredCell: false, since: 'v5' },
      { name: 'nominal_fuel_unit', requiredCell: false, since: 'v5' },
      { name: 'idle_breakdown_threshold_minutes', requiredCell: false, since: 'v5' },
      { name: 'running_signal', requiredCell: false, since: 'v5' },
      { name: 'running_idle_bound', requiredCell: false, since: 'v5' },
      { name: 'availability_signal', requiredCell: false, since: 'v5' },
      // Cold-start fuel figures (fuel test report FU-3/FU-5), blank in the example for the
      // nominal's reason. Optional v5 columns rather than a v6: nothing earlier changes
      // meaning, and a workbook without them loads exactly as before.
      { name: 'nominal_fuel_source', requiredCell: false, since: 'v5' },
      { name: 'rated_power_kw', requiredCell: false, since: 'v5' },
      { name: 'working_load_pct', requiredCell: false, since: 'v5' },
      { name: 'bsfc_g_per_kwh', requiredCell: false, since: 'v5' },
      { name: 'bsfc_source', requiredCell: false, since: 'v5' },
      { name: 'idle_fuel_per_hour', requiredCell: false, since: 'v5' },
      { name: 'working_share', requiredCell: false, since: 'v5' },
    ],
    example: {
      slug: 'diesel-generator', name: 'Diesel Generator', description: 'Backup power genset',
      category: 'power', service_interval_hours: 250,
    },
  },
  /**
   * One row per signal per machine — the natural key is (class_slug, signal,
   * component_scope), not (class_slug, signal): a composite machine needs two rows
   * naming the same signal with different component_scope (template v3).
   *
   * A row writes between one and three tables:
   *   - always: an expected_signals entry (signal, unit, required, description)
   *   - criticality non-blank: an equipment_class_sensor_requirement row
   *     (component_scope, criticality, min_count, enables, notes)
   *   - min or max non-blank: a default threshold (min, max, severity), mirroring
   *     `SignalThresholdParams` in `src/alert/services/alert-rules.ts` one-for-one —
   *     the engine has no duration, consecutive-reading, hysteresis or dwell
   *     parameter, so a `comparator`/`value` shape would read and stage cleanly and
   *     the engine still could not run it. `severity` maps to `AlertRule.severity`,
   *     a column on the rule rather than a threshold parameter.
   * A blank criticality means the class declares the signal but does not require it
   * to be fitted — the difference between a signal we can use and one we insist on,
   * and it must survive the merge into expected_signals vs. sensor_requirement.
   *
   * unit, required, description, min, max and severity are signal-level, not
   * row-level: they must agree across every row sharing (class_slug, signal), and
   * QIMP2's validator rejects disagreement by row number rather than silently taking
   * the first row — that would make the class's declared unit depend on row order.
   * The expected_signals entry and the threshold are written once per signal, not
   * once per component row (`class-content.ts`).
   *
   * `measurement_role` and `canonical_unit` do not exist here as separate columns:
   * `signal` writes into both expected_signals.signal and
   * equipment_class_sensor_requirement.measurementRole, and `unit` into every place a
   * unit was previously given. One word for one concept, and the role-must-be-
   * declared trigger in `1757970000000-LibraryStructure.ts` becomes impossible to
   * violate from an import, by construction.
   */
  {
    sheet: 'signal',
    entityKind: 'signal',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'signal', requiredCell: true },
      { name: 'unit', requiredCell: false },
      { name: 'required', requiredCell: true, boolean: true },
      { name: 'description', requiredCell: false },
      // Either bound may be omitted; a blank min and max together mean this signal
      // has no threshold, not a rejection — "at least one, and min below max" is
      // QIMP2's semantic check on a row that supplies one, not this slice's.
      { name: 'min', requiredCell: false },
      { name: 'max', requiredCell: false },
      { name: 'severity', requiredCell: false },
      // D59: optional, so no template bump (QCE3's precedent: an optional column asks
      // nothing of a workbook that predates it). Set, it makes min and max multiples of
      // a motor rating on each machine — `rated_current` with max 1.2 is overload at
      // 1.2 × that motor's own rated current — instead of one value for every model.
      { name: 'rating', requiredCell: false },
      { name: 'component_scope', requiredCell: false },
      { name: 'criticality', requiredCell: false },
      { name: 'min_count', requiredCell: false },
      { name: 'enables', requiredCell: false, multiValue: true },
      { name: 'notes', requiredCell: false },
      // v4 (task QREC0a). All three describe the sensor_requirement row, so a row
      // with a blank criticality — which writes no requirement — has nowhere to put
      // them, and is refused rather than silently writing nowhere.
      { name: 'stale_after_seconds', requiredCell: false, since: 'v4' },
      { name: 'forecast_enabled', requiredCell: false, boolean: true, since: 'v4' },
      { name: 'forecast_horizon_hours', requiredCell: false, since: 'v4' },
    ],
    example: {
      class_slug: 'diesel-generator', signal: 'coolant_temp_c', unit: 'degC',
      required: 'TRUE', description: 'Coolant temperature', min: '', max: 105, severity: 'critical',
      component_scope: '', criticality: 'required', min_count: 1,
      enables: 'data_quality,physics_calculation', notes: 'Primary coolant probe',
      stale_after_seconds: 300, forecast_enabled: 'TRUE', forecast_horizon_hours: 24,
    },
  },
  {
    sheet: 'failure_mode',
    entityKind: 'failure_mode',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'code', requiredCell: true },
      { name: 'name', requiredCell: true },
      { name: 'symptom', requiredCell: true },
      // Optional even in v4: blank is NULL — "nobody said" — never a default (D32).
      { name: 'severity', requiredCell: false, since: 'v4' },
      { name: 'signals', requiredCell: false, multiValue: true },
    ],
    // Names only the signal the example declares. Until v4 it also named
    // oil_pressure_kpa, which the example class never declared — and a failure mode
    // naming an undeclared signal is now refused at publish (task QREC0a), so the
    // template's own example would fail its own publish.
    example: {
      class_slug: 'diesel-generator', code: 'overheat', name: 'Overheating',
      symptom: 'High coolant temperature, reduced power', severity: 'high', signals: 'coolant_temp_c',
    },
  },
  {
    sheet: 'recommendation',
    entityKind: 'recommendation',
    since: 'v4',
    columns: [
      { name: 'class_slug', requiredCell: true },
      // Must name a failure mode on the same class version — refused at validate,
      // naming both, and by the foreign key behind it.
      { name: 'failure_mode_code', requiredCell: true },
      { name: 'action', requiredCell: true },
      { name: 'urgency', requiredCell: true },
      { name: 'estimated_hours', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', failure_mode_code: 'overheat',
      action: 'Check coolant level and clear the radiator fins', urgency: 'next_shift', estimated_hours: 1,
    },
  },
  /**
   * The machine page (task QREC0b) — added inside v4, not as a v5: QREC0a's bump has
   * landed, the sheet is optional, and a workbook without it is unchanged in meaning
   * (the class gets the computed fallback page). `since: 'v4'` still refuses it in a
   * workbook stamped v3. Whether a widget agrees with its formula's presentation is
   * checked at publish, once the formula is compiled; this sheet's own shape and its
   * references are checked at validate.
   */
  {
    sheet: 'layout',
    entityKind: 'layout',
    since: 'v4',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'widget_key', requiredCell: true },
      { name: 'widget_type', requiredCell: true },
      { name: 'bound_to', requiredCell: false },
      { name: 'title', requiredCell: false },
      { name: 'position', requiredCell: true },
      { name: 'size', requiredCell: true },
    ],
    // The example formula is a series with chart_type "line", so the chart is what it
    // asks for; a kpi_number here would be refused at publish.
    example: {
      class_slug: 'diesel-generator', widget_key: 'coolant_margin', widget_type: 'kpi_chart',
      bound_to: 'coolant_margin_c', title: 'Coolant margin', position: 1, size: 'large',
    },
  },
  {
    sheet: 'sensor_capability',
    entityKind: 'sensor_capability',
    columns: [
      { name: 'sensor_name', requiredCell: true },
      // Added by task QIMP5 as optional; primary as of v4 (task QREC0a). It resolves
      // exactly, no fallback, once a sensor is catalogued; sensor_name stays the
      // display string and the case/whitespace-insensitive fallback. Still not a
      // required cell: a sensor this workbook proposes has no slug yet.
      { name: 'sensor_slug', requiredCell: false },
      // Optional, same reason: what a proposed sensor should be filed under. Blank
      // is legal — the sensor is still proposable, uncategorised.
      { name: 'category', requiredCell: false },
      { name: 'signal', requiredCell: true },
      { name: 'parameter_key', requiredCell: false },
      { name: 'canonical_unit', requiredCell: false },
    ],
    example: {
      sensor_name: 'Coolant Temp Probe', sensor_slug: '', category: 'Engine', signal: 'coolant_temp_c',
      parameter_key: 'temperature', canonical_unit: 'degC',
    },
  },
  {
    sheet: 'formula',
    entityKind: 'formula',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'formula_key', requiredCell: true },
      { name: 'kind', requiredCell: true },
      // No longer requiredCell (task QCE3) — a bind-mode row leaves this blank and
      // fills named_formula/named_formula_version/bindings instead. A row filling
      // neither is formula_mode_missing; a row filling both is formula_mode_conflict
      // — both are semantic checks (QIMP2), not a shape check this schema can make,
      // because "required" here can only mean "always", and here it means "one of".
      { name: 'expression', requiredCell: false },
      { name: 'inputs', requiredCell: false, multiValue: true },
      { name: 'output_unit', requiredCell: false },
      { name: 'basis', requiredCell: false },
      { name: 'references', requiredCell: false },
      // Optional, added by task QCE3 — not a template version bump, same reasoning
      // QIMP5's sensor_slug/category used: an optional column asks nothing of a
      // workbook that predates it.
      { name: 'named_formula', requiredCell: false },
      { name: 'named_formula_version', requiredCell: false },
      // "role=signal; role=signal" (task QCE3 §3).
      { name: 'bindings', requiredCell: false },
      // KPI presentation (D30), v4 (task QREC0a), named after the columns QCE1
      // already shipped on equipment_class_formula. Each blank cell is that column's
      // own default. display_unit is checked against the compiled unit and
      // chart_type against the compiled kind — at validate and again at publish.
      { name: 'display_unit', requiredCell: false, since: 'v4' },
      { name: 'target_value', requiredCell: false, since: 'v4' },
      { name: 'target_min', requiredCell: false, since: 'v4' },
      { name: 'target_max', requiredCell: false, since: 'v4' },
      { name: 'target_direction', requiredCell: false, since: 'v4' },
      { name: 'comparison_basis', requiredCell: false, since: 'v4' },
      { name: 'aggregation_window', requiredCell: false, since: 'v4' },
      { name: 'chart_type', requiredCell: false, since: 'v4' },
    ],
    // inputs names a declared expected_signal ('coolant_temp_c'), and `expression`
    // is compiled for real by CatalogImportValidatorService (task QCE1's
    // formula-compiler.ts) — the example workbook has to pass its own importer's
    // validation, not just its parser. `105` is a numeric literal, unit-polymorphic
    // in `+`/`-` (task QCE1.1): it adopts the degC series' unit rather than needing
    // one of its own, so this compiles to degC.
    example: {
      class_slug: 'diesel-generator', formula_key: 'coolant_margin_c', kind: 'empirical',
      expression: '105 - coolant_temp_c', inputs: 'coolant_temp_c',
      output_unit: 'degC', basis: 'OEM derate curve', references: '[]',
      // A series (it reads coolant_temp_c over time), so a line chart is legal; on
      // a scalar it would be refused.
      display_unit: 'degC', target_value: 10, target_min: '', target_max: '',
      target_direction: 'higher_better', comparison_basis: 'target', aggregation_window: 'shift',
      chart_type: 'line',
    },
  },
  /**
   * Rules (testing sheet TC_126): what predicts a fault on the class, what alerts on
   * it, and the causal chain behind it — content the class page could hold and the
   * workbook could not, so a library built in Excel arrived without any of it. Each
   * row lands as a library draft, beside the class, for an author to review and
   * publish, exactly as one written on the class page would.
   *
   * Optional v5 sheets rather than a v6, the layout precedent: nothing earlier changes
   * meaning, and a workbook without them loads exactly as before.
   *
   * `prediction_scenario` is the machine's-own-baseline rule (tier1), its sigma
   * thresholds written as the scenario's parameters under the keys the scorer reads,
   * so a client sees them as tunables like any other. No influence-model columns: that
   * model is a structure, not a tunable, and nothing authors one outside the tests yet.
   */
  {
    sheet: 'prediction_scenario',
    entityKind: 'prediction_scenario',
    since: 'v5',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'slug', requiredCell: true },
      { name: 'name', requiredCell: true },
      { name: 'description', requiredCell: false },
      { name: 'severity', requiredCell: false },
      { name: 'tier', requiredCell: false },
      { name: 'required_signals', requiredCell: true, multiValue: true },
      { name: 'minimum_history_days', requiredCell: false },
      { name: 'warning_sigma', requiredCell: false },
      { name: 'critical_sigma', requiredCell: false },
      { name: 'baseline_window_days', requiredCell: false },
      { name: 'minimum_samples', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', slug: 'diesel-generator-coolant-drift', name: 'Coolant drifting hot',
      description: 'Coolant running hotter than this machine usually does', severity: 'high', tier: 1,
      required_signals: 'coolant_temp_c', minimum_history_days: 7, warning_sigma: 2, critical_sigma: 3,
      baseline_window_days: 14, minimum_samples: 30,
    },
  },
  /**
   * One alert rule per row. Which columns apply depends on `trigger`, as on the class
   * page: a signal-threshold reads signal/min/max/rating, a prediction-severity reads
   * at_least and scenario_slug, a chain-origin reads at_least, chain_slug and
   * stage_signal. Checked by the same `validateParams` a client's own rule is.
   * Signal limits on the `signal` sheet still draft their own threshold rule; this
   * sheet is for the rules a limit cannot say.
   */
  {
    sheet: 'alert_rule',
    entityKind: 'alert_rule',
    since: 'v5',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'slug', requiredCell: true },
      { name: 'name', requiredCell: true },
      { name: 'description', requiredCell: false },
      { name: 'trigger', requiredCell: true },
      { name: 'severity', requiredCell: false },
      { name: 'enabled_on_copy', requiredCell: false, boolean: true },
      { name: 'signal', requiredCell: false },
      { name: 'min', requiredCell: false },
      { name: 'max', requiredCell: false },
      { name: 'rating', requiredCell: false },
      { name: 'at_least', requiredCell: false },
      { name: 'scenario_slug', requiredCell: false },
      { name: 'chain_slug', requiredCell: false },
      { name: 'stage_signal', requiredCell: false },
    ],
    // Alerts on the example scenario above, so the example workbook passes its own
    // validation: the scenario it names is in the same batch.
    example: {
      class_slug: 'diesel-generator', slug: 'diesel-generator-coolant-drift-alert', name: 'Coolant drifting hot',
      description: 'Raised when the coolant drift prediction reaches high', trigger: 'prediction-severity',
      severity: 'high', enabled_on_copy: 'TRUE', signal: '', min: '', max: '', rating: '',
      at_least: 'high', scenario_slug: 'diesel-generator-coolant-drift', chain_slug: '', stage_signal: '',
    },
  },
  /**
   * A causal chain, one row; its stages are rows of `causal_chain_stage` naming it.
   * A chain is written whole, so a chain with no stage row is refused, and so is a
   * stage naming a chain this workbook does not carry.
   */
  {
    sheet: 'causal_chain',
    entityKind: 'causal_chain',
    since: 'v5',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'slug', requiredCell: true },
      { name: 'name', requiredCell: true },
      { name: 'description', requiredCell: false },
      { name: 'scenario_slug', requiredCell: false },
      { name: 'outcome', requiredCell: false },
      { name: 'alignment_seconds', requiredCell: false },
      { name: 'provenance', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', slug: 'diesel-generator-cooling-chain', name: 'Load heats the coolant',
      description: 'Coolant temperature explained by engine load', scenario_slug: 'diesel-generator-coolant-drift',
      outcome: 'Overheating shutdown', alignment_seconds: 60, provenance: 'OEM cooling curve',
    },
  },
  {
    sheet: 'causal_chain_stage',
    entityKind: 'causal_chain_stage',
    since: 'v5',
    columns: [
      { name: 'chain_slug', requiredCell: true },
      { name: 'signal', requiredCell: true },
      { name: 'label', requiredCell: false },
      { name: 'intercept', requiredCell: true },
      // "signal=coefficient@lagSeconds; signal=coefficient" — a driver may be an
      // upstream stage or an outside input such as load or ambient.
      { name: 'drivers', requiredCell: true },
      { name: 'warn_above', requiredCell: true },
      { name: 'critical_above', requiredCell: true },
      { name: 'direction', requiredCell: false },
      { name: 'limit_warn_at', requiredCell: false },
      { name: 'limit_critical_at', requiredCell: false },
    ],
    example: {
      chain_slug: 'diesel-generator-cooling-chain', signal: 'coolant_temp_c', label: 'Coolant under load',
      intercept: 70, drivers: 'engine_load_pct=0.3@120', warn_above: 5, critical_above: 10,
      direction: 'above', limit_warn_at: 100, limit_critical_at: 105,
    },
  },
];

export const ALL_SHEETS: SheetSchema[] = [META_SHEET, ...CONTENT_SHEETS];

// Named and exported individually — not just inlined into KNOWN_ENUMS below — so
// QIMP2's validator checks a batch against the exact same list a spreadsheet author
// is shown, rather than a second copy that could drift from it.
export const CRITICALITY_VALUES = ['required', 'recommended', 'optional'];
export const ENABLES_VALUES = [
  'data_quality', 'physics_calculation', 'physics_forecast', 'approved_rule',
  'statistical_anomaly', 'recommendation_ai', 'predictive_ml', 'agent_action',
];
export const FORMULA_KIND_VALUES = ['physics', 'empirical', 'ml_feature'];
export const SEVERITY_VALUES = ['none', 'low', 'medium', 'high', 'critical'];
/** Defined beside the column it constrains; restated here so the template's enums
 * sheet lists it with the rest. */
export const URGENCY_VALUES: string[] = [...RECOMMENDATION_URGENCY_VALUES];
// The CHECK constraints of 1758010000000-FormulaCompilerMetadata.ts (and 'number',
// 1758100000000-LibraryContent.ts), restated so an author sees them before the
// database does. `fleet` and `own_baseline` are not here on purpose: nothing
// evaluates them yet, and a value with no evaluator is a declared state nobody honours.
export const TARGET_DIRECTION_VALUES = ['higher_better', 'lower_better', 'band', 'none'];
export const COMPARISON_BASIS_VALUES = ['none', 'previous_period', 'target'];
/** QCE2's vocabulary — `resolveWindow` in kpi-evaluator.service.ts accepts exactly these. */
export const AGGREGATION_WINDOW_VALUES = ['shift', 'today', '24h', '7d', '30d', 'mtd', 'ytd'];
export const CHART_TYPE_VALUES = ['none', 'line', 'bar', 'area', 'gauge', 'number'];
/** The triggers the alert_rule sheet can write (TC_126). Not composite or fuel-loss:
 * their parameters are a structure, not a row of cells. */
export const IMPORTABLE_TRIGGERS = ['signal-threshold', 'prediction-severity', 'chain-origin'];
export const SCENARIO_TIER_VALUES = ['1', '2', '3'];
export const CHAIN_DIRECTION_VALUES = ['above', 'below', 'either'];
export const CHAIN_ALERT_LEVELS = ['warning', 'critical'];

/** What a workbook stamped `version` does not use, for the diff to name — derived from
 * `since`, so it cannot drift from the columns themselves. */
export function capabilitiesAfter(version: string): string[] {
  const names: string[] = [];
  for (const schema of CONTENT_SHEETS) {
    if (schema.since && predates(version, schema.since)) {
      names.push(`${schema.sheet} sheet`);
      continue;
    }
    for (const col of schema.columns) {
      if (col.since && predates(version, col.since)) names.push(`${schema.sheet}.${col.name}`);
    }
  }
  return names;
}

/**
 * Enums worth telling a spreadsheet author about — because a CHECK constraint already
 * enforces them (`1757970000000-LibraryStructure.ts`) or the task states them verbatim
 * (`required` is TRUE/FALSE). Template v4 (task QREC0a) adds the formula presentation
 * columns, failure_mode.severity, recommendation.urgency and signal.forecast_enabled,
 * each restating a CHECK constraint. The first five live on the `signal` sheet as of template v3 —
 * criticality and enables feed equipment_class_sensor_requirement, required feeds
 * expected_signals, severity feeds the threshold, and all four are read off the same
 * row that names the signal.
 *
 * `signal.severity` reuses `AlertRule.severity` (`src/alert/entities/
 * alert-rule.entity.ts`), which is `Severity` from `src/common/severity.ts` — the one
 * severity vocabulary the whole platform maps foreign values onto. A threshold loaded
 * with a severity the alert engine cannot read is a threshold that never fires while
 * looking like it was imported successfully, which is the failure this list exists
 * to catch before it reaches a spreadsheet.
 *
 * There is no `signal.comparator` entry: the sheet has no comparator column at all.
 * It mirrors `SignalThresholdParams` as `min`/`max` bounds directly — "greater than"
 * or "less than" is which bound is set, not a value that needs its own vocabulary.
 */
export const KNOWN_ENUMS: { field: string; values: string[] }[] = [
  { field: 'signal.criticality', values: CRITICALITY_VALUES },
  { field: 'signal.enables', values: ENABLES_VALUES },
  { field: 'formula.kind', values: FORMULA_KIND_VALUES },
  { field: 'signal.required', values: ['TRUE', 'FALSE'] },
  { field: 'signal.severity', values: SEVERITY_VALUES },
  { field: 'signal.forecast_enabled', values: ['TRUE', 'FALSE'] },
  { field: 'failure_mode.severity', values: SEVERITY_VALUES },
  { field: 'recommendation.urgency', values: URGENCY_VALUES },
  { field: 'formula.target_direction', values: TARGET_DIRECTION_VALUES },
  { field: 'formula.comparison_basis', values: COMPARISON_BASIS_VALUES },
  { field: 'formula.aggregation_window', values: AGGREGATION_WINDOW_VALUES },
  { field: 'formula.chart_type', values: CHART_TYPE_VALUES },
  { field: 'layout.widget_type', values: [...WIDGET_TYPES] },
  { field: 'layout.size', values: [...WIDGET_SIZES] },
  { field: 'prediction_scenario.severity', values: SEVERITY_VALUES },
  { field: 'prediction_scenario.tier', values: SCENARIO_TIER_VALUES },
  { field: 'alert_rule.trigger', values: IMPORTABLE_TRIGGERS },
  { field: 'alert_rule.severity', values: SEVERITY_VALUES },
  { field: 'alert_rule.at_least', values: [...SEVERITY_VALUES.filter((v) => v !== 'none'), ...CHAIN_ALERT_LEVELS] },
  { field: 'causal_chain_stage.direction', values: CHAIN_DIRECTION_VALUES },
];
