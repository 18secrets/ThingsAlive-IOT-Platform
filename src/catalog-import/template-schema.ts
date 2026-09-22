/**
 * The one shape the template generator writes and the parser reads (task QIMP1).
 *
 * Both sides import this file rather than each declaring their own column list,
 * because a template that drifted from what the parser expects is exactly the
 * "changed shape, read with the old meanings" failure this slice exists to prevent.
 */
export const TEMPLATE_VERSION = 'v1';

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
  {
    sheet: 'default_threshold',
    entityKind: 'default_threshold',
    columns: [
      { name: 'class_slug', requiredCell: true },
      { name: 'signal', requiredCell: true },
      { name: 'comparator', requiredCell: true },
      { name: 'value', requiredCell: true },
      { name: 'unit', requiredCell: false },
      { name: 'severity', requiredCell: false },
    ],
    example: {
      class_slug: 'diesel-generator', signal: 'coolant_temp_c', comparator: '>',
      value: 105, unit: 'degC', severity: 'critical',
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
    example: {
      class_slug: 'diesel-generator', formula_key: 'usable_fuel_liters', kind: 'empirical',
      expression: 'tank_capacity_liters * 0.95', inputs: 'tank_capacity_liters',
      output_unit: 'L', basis: 'Field observation', references: '[]',
    },
  },
];

export const ALL_SHEETS: SheetSchema[] = [META_SHEET, ...CONTENT_SHEETS];

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
 * `default_threshold.comparator` has no equivalent to reuse: `SignalThresholdParams`
 * (`src/alert/services/alert-rules.ts`) does not store a comparator at all — a
 * threshold is a `min`/`max` numeric bound, and "greater than" or "less than" is
 * which bound is set, not a value the schema names anywhere. There is nothing here to
 * be consistent with, so nothing is listed; inventing a symbol (">", "gte", ...) would
 * be exactly the guess this file exists to avoid.
 */
export const KNOWN_ENUMS: { field: string; values: string[] }[] = [
  { field: 'sensor_requirement.criticality', values: ['required', 'recommended', 'optional'] },
  {
    field: 'sensor_requirement.enables',
    values: [
      'data_quality', 'physics_calculation', 'physics_forecast', 'approved_rule',
      'statistical_anomaly', 'recommendation_ai', 'predictive_ml', 'agent_action',
    ],
  },
  { field: 'formula.kind', values: ['physics', 'empirical', 'ml_feature'] },
  { field: 'expected_signal.required', values: ['TRUE', 'FALSE'] },
  { field: 'default_threshold.severity', values: ['none', 'low', 'medium', 'high', 'critical'] },
];
