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
];

export const COST_PARAMETER_NAMES: readonly string[] = OPERATIONAL_PARAMETERS
  .filter((p) => p.costTyped).map((p) => p.name);

export function operationalParameter(name: string): OperationalParameter | undefined {
  return OPERATIONAL_PARAMETERS.find((p) => p.name === name);
}
