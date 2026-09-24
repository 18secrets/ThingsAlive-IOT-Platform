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
export const TEMPLATE_VERSION = 'v3';

export interface SheetColumn {
  name: string;
  /** A blank cell here rejects the row. Declared per sheet, not inferred from data. */
  requiredCell: boolean;
  /** Comma-separated in the cell: failure_mode.signals, signal.enables, formula.inputs. */
  multiValue?: boolean;
  /** TRUE/FALSE in the cell, parsed to a boolean. Only signal.required today. */
  boolean?: boolean;
}

export interface SheetSchema {
  sheet: string;
  entityKind: string;
  columns: SheetColumn[];
  /** One filled row, so the template is never handed over as a blank shell. */
  example: Record<string, string | number>;
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
      { name: 'component_scope', requiredCell: false },
      { name: 'criticality', requiredCell: false },
      { name: 'min_count', requiredCell: false },
      { name: 'enables', requiredCell: false, multiValue: true },
      { name: 'notes', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', signal: 'coolant_temp_c', unit: 'degC',
      required: 'TRUE', description: 'Coolant temperature', min: '', max: 105, severity: 'critical',
      component_scope: '', criticality: 'required', min_count: 1,
      enables: 'data_quality,physics_calculation', notes: 'Primary coolant probe',
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
      { name: 'signals', requiredCell: false, multiValue: true },
    ],
    example: {
      class_slug: 'diesel-generator', code: 'overheat', name: 'Overheating',
      symptom: 'High coolant temperature, reduced power', signals: 'coolant_temp_c,oil_pressure_kpa',
    },
  },
  {
    sheet: 'sensor_capability',
    entityKind: 'sensor_capability',
    columns: [
      { name: 'sensor_name', requiredCell: true },
      { name: 'signal', requiredCell: true },
      { name: 'parameter_key', requiredCell: false },
      { name: 'canonical_unit', requiredCell: false },
    ],
    example: {
      sensor_name: 'Coolant Temp Probe', signal: 'coolant_temp_c',
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
      { name: 'expression', requiredCell: true },
      { name: 'inputs', requiredCell: false, multiValue: true },
      { name: 'output_unit', requiredCell: false },
      { name: 'basis', requiredCell: false },
      { name: 'references', requiredCell: false },
    ],
    // inputs names a declared expected_signal ('coolant_temp_c'), and `expression`
    // is compiled for real by CatalogImportValidatorService (task QCE1's
    // formula-compiler.ts) — the example workbook has to pass its own importer's
    // validation, not just its parser. `105 - coolant_temp_c` looked plausible and
    // does not compile: 105 is a dimensionless literal (section 3's own rule) and
    // cannot be subtracted from a degC series, so `max(...)` is what ships instead.
    example: {
      class_slug: 'diesel-generator', formula_key: 'coolant_margin_c', kind: 'empirical',
      expression: 'max(coolant_temp_c)', inputs: 'coolant_temp_c',
      output_unit: 'degC', basis: 'OEM derate curve', references: '[]',
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

/**
 * Enums worth telling a spreadsheet author about — because a CHECK constraint already
 * enforces them (`1757970000000-LibraryStructure.ts`) or the task states them verbatim
 * (`required` is TRUE/FALSE). All five live on the `signal` sheet as of template v3 —
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
];
