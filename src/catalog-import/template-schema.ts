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
export const TEMPLATE_VERSION = 'v2';

export interface SheetColumn {
  name: string;
  /** A blank cell here rejects the row. Declared per sheet, not inferred from data. */
  requiredCell: boolean;
  /** Comma-separated in the cell: failure_mode.signals, requirement.enables, formula.inputs. */
  multiValue?: boolean;
  /** TRUE/FALSE in the cell, parsed to a boolean. Only expected_signal.required today. */
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
  {
    sheet: 'expected_signal',
    entityKind: 'expected_signal',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'signal', requiredCell: true },
      { name: 'unit', requiredCell: false },
      { name: 'required', requiredCell: true, boolean: true },
      { name: 'description', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', signal: 'coolant_temp_c', unit: 'degC',
      required: 'TRUE', description: 'Coolant temperature',
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
    sheet: 'sensor_requirement',
    entityKind: 'sensor_requirement',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'measurement_role', requiredCell: true },
      { name: 'component_scope', requiredCell: false },
      { name: 'criticality', requiredCell: false },
      { name: 'min_count', requiredCell: false },
      { name: 'canonical_unit', requiredCell: false },
      { name: 'enables', requiredCell: false, multiValue: true },
      { name: 'notes', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', measurement_role: 'coolant_temp_c', component_scope: '',
      criticality: 'required', min_count: 1, canonical_unit: 'degC',
      enables: 'data_quality,physics_calculation', notes: 'Primary coolant probe',
    },
  },
  {
    sheet: 'sensor_capability',
    entityKind: 'sensor_capability',
    columns: [
      { name: 'sensor_name', requiredCell: true },
      { name: 'measurement_role', requiredCell: true },
      { name: 'parameter_key', requiredCell: false },
      { name: 'canonical_unit', requiredCell: false },
    ],
    example: {
      sensor_name: 'Coolant Temp Probe', measurement_role: 'coolant_temp_c',
      parameter_key: 'temperature', canonical_unit: 'degC',
    },
  },
  /**
   * Mirrors `SignalThresholdParams` in `src/alert/services/alert-rules.ts` one-for-one
   * (`signal`, `min`, `max` — nothing else; the engine has no duration, consecutive-
   * reading, hysteresis or dwell parameter). A `comparator`/`value` shape read cleanly
   * and staged cleanly, and the alert engine still could not run it — the exact
   * failure that looks like "no faults detected" rather than an error. `min`/`max`
   * cannot express anything the engine does not, because it is what the engine reads.
   * `unit` and `severity` are kept: `unit` documents the value for whoever fills the
   * cell in (the engine compares raw numbers, in the reading's own unit), and
   * `severity` maps to `AlertRule.severity`, a column on the rule rather than a
   * threshold parameter.
   */
  {
    sheet: 'default_threshold',
    entityKind: 'default_threshold',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'signal', requiredCell: true },
      // Either bound may be omitted; at least one is required — the same rule
      // `validateParams` enforces on `alert_rule` itself. Neither cell is
      // unconditionally required at the shape level; "at least one, and min below
      // max" is QIMP2's semantic check, not this slice's.
      { name: 'min', requiredCell: false },
      { name: 'max', requiredCell: false },
      { name: 'unit', requiredCell: false },
      { name: 'severity', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', signal: 'coolant_temp_c', min: '',
      max: 105, unit: 'degC', severity: 'critical',
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
    // inputs names a declared expected_signal ('coolant_temp_c') rather than a scalar
    // parameter such as tank capacity: QIMP2 checks a formula's inputs against
    // declared signals and other formula_keys, and the example workbook has to pass
    // its own importer's validation, not just its parser.
    example: {
      class_slug: 'diesel-generator', formula_key: 'coolant_margin_c', kind: 'empirical',
      expression: '105 - coolant_temp_c', inputs: 'coolant_temp_c',
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
 * (`required` is TRUE/FALSE).
 *
 * `default_threshold.severity` reuses `AlertRule.severity` (`src/alert/entities/
 * alert-rule.entity.ts`), which is `Severity` from `src/common/severity.ts` — the one
 * severity vocabulary the whole platform maps foreign values onto. A threshold loaded
 * with a severity the alert engine cannot read is a threshold that never fires while
 * looking like it was imported successfully, which is the failure this list exists
 * to catch before it reaches a spreadsheet.
 *
 * There is no `default_threshold.comparator` entry: the sheet no longer has a
 * comparator column at all. It mirrors `SignalThresholdParams` as `min`/`max` bounds
 * directly — "greater than" or "less than" is which bound is set, not a value that
 * needs its own vocabulary.
 */
export const KNOWN_ENUMS: { field: string; values: string[] }[] = [
  { field: 'sensor_requirement.criticality', values: CRITICALITY_VALUES },
  { field: 'sensor_requirement.enables', values: ENABLES_VALUES },
  { field: 'formula.kind', values: FORMULA_KIND_VALUES },
  { field: 'expected_signal.required', values: ['TRUE', 'FALSE'] },
  { field: 'default_threshold.severity', values: SEVERITY_VALUES },
];
