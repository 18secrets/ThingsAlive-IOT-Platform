/**
 * The platform-declared operational parameters (task QPARAM1 §0.4).
 *
 * A closed list, together with whatever formulas declare through `required_parameters`.
 * Free-text names are the drift that silently unbound rules in the sensor catalog: a
 * value stored under `fuel_prise` is a value nothing will ever read, and nobody finds
 * out until a cost KPI has read `not_configured` for a month.
 *
 * Names only — never values. There is no platform default for any cost parameter
 * (D39): a fuel price Things Alive chose would be a number the customer never agreed to.
 */
export type ParameterScope = 'client' | 'site' | 'equipment_class' | 'equipment';

export const PARAMETER_SCOPES: readonly ParameterScope[] = ['client', 'site', 'equipment_class', 'equipment'];

/** Most specific first — the order a value is looked for in (§3). */
export const RESOLUTION_ORDER: readonly ParameterScope[] = ['equipment', 'equipment_class', 'site', 'client'];

export interface OperationalParameter {
  name: string;
  /** `currency` in a unit means "the client's own currency", whatever it is. */
  unit: string | null;
  kind: 'number' | 'currency_code';
  /** Denominated in the client's currency. Changing the currency is refused while any
   * of these holds a value (§0.3) — `tenant_parameter_cost_names()` in the migration is
   * the database's copy of this flag, and a test holds the two to each other. */
  costTyped: boolean;
  /**
   * The formula compiler reads `@name` in `unit` rather than as a bare number (D56).
   * Absent on every parameter that predates D56: giving `fuel_price` its currency/L
   * now would change the result unit of formulas already published (D05). Each moves
   * over on its own, with the formulas that read it.
   */
  compilesWithUnit?: boolean;
  description: string;
}

export const OPERATIONAL_PARAMETERS: readonly OperationalParameter[] = [
  {
    name: 'currency', unit: null, kind: 'currency_code', costTyped: false,
    description: 'ISO 4217 code every cost-typed value is denominated in. Client scope only.',
  },
  {
    name: 'fuel_price', unit: 'currency/L', kind: 'number', costTyped: true,
    description: 'Price paid per litre of fuel.',
  },
  {
    name: 'labour_rate_per_hour', unit: 'currency/h', kind: 'number', costTyped: true,
    description: 'Cost of one hour of labour.',
  },
  {
    name: 'operating_cost_per_hour', unit: 'currency/h', kind: 'number', costTyped: true,
    description: 'Cost of running the machine for one hour.',
  },
  {
    name: 'stale_after_seconds', unit: 's', kind: 'number', costTyped: false,
    description: 'How long without a reading before a signal is stale. Overrides the class requirement.',
  },
  // OEE (task QOEE1). Each overrides the library class's OEM figure for this client,
  // site, class or machine; with none set at any scope, the OEM figure answers.
  {
    name: 'nominal_fuel_per_hour', unit: 'L/h', kind: 'number', costTyped: false,
    description: 'Fuel the machine should burn per productive hour. Compared with fuel_consumption in the same unit.',
  },
  {
    name: 'idle_breakdown_threshold_minutes', unit: 'min', kind: 'number', costTyped: false,
    description: 'How long idle with fuel available, inside a shift, before it counts as a breakdown. At least 5.',
  },
  {
    name: 'shield_due_soon_days', unit: 'd', kind: 'number', costTyped: false,
    description: 'How many days before an evidence record falls due it reads "due soon" on ThingsShield.',
  },

  // Motor and pump ratings (D56). Every motor threshold is a ratio to one of these, so
  // unlike everything above they compile in their unit: `avg(motor_current) /
  // @rated_current` is a dimensionless load ratio, and comparing it with `@rated_voltage`
  // is refused. A null unit is a pure number (poles, power factor, slip).
  //
  // Temperature rise is in degC, not K. The unit algebra has no affine temperatures, so
  // `@ambient_temp_reference + @rated_temp_rise * λ * λ` only adds up if both say degC;
  // K would refuse the motor's own thermal model over a naming difference.
  motorRating('rated_voltage', 'V', 'Rated (nameplate) supply voltage.'),
  motorRating('rated_current', 'A', 'Rated full-load current.'),
  motorRating('rated_frequency', 'Hz', 'Rated supply frequency.'),
  motorRating('poles', null, 'Number of poles. Synchronous speed is 120 × frequency ÷ poles.'),
  motorRating('phases', null, '1 for single-phase, 3 for three-phase.'),
  motorRating('rated_output', 'kW', 'Rated shaft output.'),
  motorRating('rated_power_factor', null, 'Power factor at rated load, 0 to 1.'),
  motorRating('rated_efficiency', null, 'Efficiency at rated load, 0 to 1.'),
  motorRating('rated_slip', null, 'Slip at rated load, as a fraction of synchronous speed.'),
  motorRating('rated_temp_rise', 'degC', 'Winding temperature rise above ambient at rated load.'),
  motorRating('thermal_time_constant', 's', 'How fast winding temperature follows load: the first-order time constant.'),
  motorRating('insulation_temp_limit', 'degC', 'Insulation class limit: 130 for B, 155 for F, 180 for H.'),
  motorRating('voltage_min_operating', 'V', 'Lowest supply voltage the maker rates the motor to run at.'),
  motorRating('voltage_max_operating', 'V', 'Highest supply voltage the maker rates the motor to run at.'),
  motorRating('voltage_warn_low', 'V', 'Supply voltage below which a warning is raised, inside the operating band.'),
  motorRating('voltage_warn_high', 'V', 'Supply voltage above which a warning is raised, inside the operating band.'),
  motorRating('locked_rotor_multiple', null, 'Locked-rotor current as a multiple of rated current.'),
  motorRating('max_starts_per_hour', null, 'Starts the maker allows in one hour. Compare with a start count over one hour.'),
  motorRating('install_head', 'm', 'Static head at this installation, measured at commissioning.'),
  motorRating('ambient_temp_reference', 'degC', 'Ambient temperature to assume where none is measured on site.'),
];

function motorRating(name: string, unit: string | null, description: string): OperationalParameter {
  return { name, unit, kind: 'number', costTyped: false, compilesWithUnit: true, description };
}

export const COST_PARAMETER_NAMES: readonly string[] = OPERATIONAL_PARAMETERS
  .filter((p) => p.costTyped).map((p) => p.name);

export function operationalParameter(name: string): OperationalParameter | undefined {
  return OPERATIONAL_PARAMETERS.find((p) => p.name === name);
}
