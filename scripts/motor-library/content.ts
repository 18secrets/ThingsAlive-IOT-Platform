/**
 * The motor library, as data: what `provision.ts` loads into the platform through its
 * own API (catalog import, alert templates, a model with ratings, a grant).
 *
 * Source: Crompton_Pump_Library.xlsx (sheets Signal Dictionary, KPIs & Formulas,
 * Universal Parameters & Formulas, Formula Verification, RCA Matrix — Borewell,
 * Predictions & Alerts). Every rated figure below names where it came from. What the
 * workbook does not give is left out, not guessed (G07):
 *   - the Mini's duty table input power per head (catalogue p.5) — so the flow estimate
 *     and expected-power KPIs read not_configured until the curve is entered;
 *   - a calibrated temperature rise (V-04: the firmware's 40 °C over 30 °C is
 *     uncalibrated) — so the winding-temperature estimate reads not_configured;
 *   - the health-score weights (the workbook's own GAP: Crompton's service team ratifies
 *     them) — so no health-score formula is loaded.
 *
 * Signals are what the motor logger sends, as `motor-ingest` writes them: one-minute
 * aggregates per signal (avg, plus min/max where an extreme matters).
 */

export const MOTOR_CLASS = 'induction-motor-1ph';
export const PUMP_CLASS = 'monoblock-pump-1ph';

export const CLASSES = [
  {
    slug: MOTOR_CLASS, name: 'Single-phase induction motor', category: 'motor',
    description: 'Electrically monitored single-phase motor (voltage, current, power factor, temperature). '
      + 'Thresholds are multiples of each motor\'s own ratings, read from its model.',
  },
  {
    slug: PUMP_CLASS, name: 'Monoblock pump, single-phase', category: 'pump',
    description: 'Residential / agricultural monoblock pump with an electrical-only logger (Crompton Mini, DMB/CMB). '
      + 'Flow is estimated from measured power through the model\'s catalogue duty curve.',
  },
];

/** The logger's signals, both classes (motor-ingest's MINUTE_SIGNALS). */
export const SIGNALS: { signal: string; unit: string; required: boolean; description: string }[] = [
  { signal: 'supply_voltage', unit: 'V', required: true, description: 'Supply voltage, one-minute average (logger, measured).' },
  { signal: 'supply_voltage_min', unit: 'V', required: false, description: 'Lowest one-second voltage in the minute: sags.' },
  { signal: 'supply_voltage_max', unit: 'V', required: false, description: 'Highest one-second voltage in the minute: surges.' },
  { signal: 'motor_current', unit: 'A', required: true, description: 'Motor current, one-minute average (logger, measured).' },
  { signal: 'motor_current_max', unit: 'A', required: false, description: 'Highest one-second current in the minute: starts and spikes.' },
  { signal: 'input_power', unit: 'kW', required: true, description: 'Input power V × I × PF, one-minute average (F2).' },
  { signal: 'motor_temperature', unit: 'degC', required: false, description: 'Logger temperature channel, one-minute average.' },
  { signal: 'motor_speed_est', unit: 'rpm', required: false, description: 'Firmware speed figure. ESTIMATED, not measured (Formula Verification V-02).' },
  { signal: 'engine_running_status', unit: 'dimensionless', required: false,
    description: '1 when the motor ran in the minute (F1: V > 15% of rated, I > 5% of rated, per second). The platform\'s running signal.' },
  { signal: 'motor_starts', unit: 'starts', required: false, description: 'Starts in the minute, counted on the one-second readings.' },
  { signal: 'motor_running_share', unit: 'dimensionless', required: false, description: 'Share of the minute\'s seconds the motor ran (0-1).' },
  { signal: 'current_fluctuation_pct', unit: 'dimensionless', required: false,
    description: 'F: current fluctuation % over running seconds. Input of instability_score; current noise, NOT vibration (V-07).' },
  { signal: 'logger_records_lost', unit: 'records', required: false, description: 'Records the logger overwrote (flash full) since its last upload.' },
  { signal: 'logger_records_dropped', unit: 'records', required: false, description: 'Readings the logger could not store since its last upload.' },
];

export interface FormulaRow {
  classes: string[]; key: string; expression: string; inputs: string[]; unit: string;
  /** 'physics' needs at least one signal input (ck_class_formula_physics_inputs); a pure
   * catalogue lookup is 'empirical'. Default physics. */
  kind?: 'physics' | 'empirical';
  /** A gauge's reference line. Only where the figure is a definition, not a guess. */
  target?: { value: number; direction: 'higher_better' | 'lower_better' };
  basis: string; window: string; chart: string; useCase: string;
}

const BOTH = [MOTOR_CLASS, PUMP_CLASS];
const lambda = '(avg(motor_current) / @rated_current)';

export const FORMULAS: FormulaRow[] = [
  { classes: BOTH, key: 'load_pct', expression: `100 * ${lambda}`, inputs: ['motor_current'], unit: 'dimensionless',
    target: { value: 100, direction: 'lower_better' }, // 100% is the rating itself
    basis: 'motor_load_pct: avg(current) / I_rated × 100, I_rated per model (KPIs & Formulas; F3)', window: '24h', chart: 'gauge', useCase: 'U1' },
  { classes: BOTH, key: 'peak_load_ratio', expression: 'max(motor_current_max) / @rated_current', inputs: ['motor_current_max'], unit: 'dimensionless',
    basis: 'λ at the worst second of the window; overload above 1.20 (F8)', window: '24h', chart: 'number', useCase: 'U4' },
  { classes: BOTH, key: 'supply_voltage_avg', expression: 'avg(supply_voltage)', inputs: ['supply_voltage'], unit: 'V',
    basis: 'Supply voltage (Signal Dictionary)', window: '24h', chart: 'number', useCase: 'U1' },
  { classes: BOTH, key: 'voltage_tier', inputs: ['supply_voltage', 'supply_voltage_min', 'supply_voltage_max'], unit: 'dimensionless',
    expression: 'if(or(min(supply_voltage_min) < @voltage_min_operating, max(supply_voltage_max) > @voltage_max_operating), 2, '
      + 'if(or(avg(supply_voltage) < @voltage_warn_low, avg(supply_voltage) > @voltage_warn_high), 1, 0))',
    basis: 'voltage_tier: 0 normal, 1 warning (outside the warn lines), 2 fault (outside the rated band) (KPIs & Formulas; V-05)', window: '24h', chart: 'number', useCase: 'U4' },
  { classes: BOTH, key: 'energy_kwh', expression: 'integrate(input_power)', inputs: ['input_power'], unit: 'kW·h',
    basis: 'Energy = ∫P dt (F12)', window: 'today', chart: 'number', useCase: 'U8' },
  { classes: BOTH, key: 'input_power_avg', expression: 'avg(input_power)', inputs: ['input_power'], unit: 'kW',
    basis: 'P = V × I × PF (F2)', window: '24h', chart: 'number', useCase: 'U1' },
  { classes: BOTH, key: 'winding_temp_est', inputs: ['motor_current'], unit: 'degC',
    expression: `@ambient_temp_reference + @rated_temp_rise * ${lambda} * ${lambda}`,
    basis: 'Steady-state F5: T_amb + ΔT_rated × λ². Advisory until bench-calibrated (V-04)', window: '24h', chart: 'number', useCase: 'U2' },
  { classes: BOTH, key: 'starts_today', expression: 'sum(motor_starts)', inputs: ['motor_starts'], unit: 'starts',
    basis: 'starts_per_day: count(start events) / day; destructive cycling is far above normal, e.g. > 60 (KPIs & Formulas; RCA 10)', window: 'today', chart: 'number', useCase: 'U6' },
  { classes: BOTH, key: 'running_pct', expression: '100 * avg(motor_running_share)', inputs: ['motor_running_share'], unit: 'dimensionless',
    basis: 'Share of minutes the motor ran (F1), the run_hours side of availability_pct (KPIs & Formulas)', window: '24h', chart: 'number', useCase: 'U9' },
  { classes: BOTH, key: 'logger_records_lost_24h', expression: 'sum(logger_records_lost) + sum(logger_records_dropped)', inputs: ['logger_records_lost', 'logger_records_dropped'], unit: 'records',
    basis: 'Records the logger lost or could not store (contract: lost_total / dropped_total, alert if they grow)', window: '24h', chart: 'number', useCase: 'U10' },
  { classes: BOTH, key: 'instability_score', expression: 'clamp(25 * (avg(current_fluctuation_pct) / 2 - 1), 0, 25)',
    inputs: ['current_fluctuation_pct'], unit: 'dimensionless',
    basis: 'instability_score = clamp(25 × (F/F0\' − 1)), F0\' = the 2% floor (KPIs & Formulas; F6). Current noise, NOT vibration (V-07)', window: '24h', chart: 'number', useCase: 'U2' },
  { classes: [PUMP_CLASS], key: 'flow_estimate_lpm', expression: "curve_at('flow_lpm', 'input_kw', avg(input_power))", inputs: ['input_power'], unit: 'L/min',
    basis: 'Q_est: catalogue P-Q curve read backwards at measured power, ±10-15% until POC T0 (F7)', window: '24h', chart: 'number', useCase: 'U8' },
  { classes: [PUMP_CLASS], key: 'expected_power_kw', kind: 'empirical', expression: "curve_at('input_kw', 'head_m', @install_head)", inputs: [], unit: 'kW',
    basis: 'P0: catalogue power at the installation head, set at commissioning (V-06)', window: '24h', chart: 'number', useCase: 'U8' },
  { classes: [PUMP_CLASS], key: 'load_loss_pct', expression: '100 * (#expected_power_kw - avg(input_power)) / #expected_power_kw', inputs: ['input_power'], unit: 'dimensionless',
    basis: 'load_loss_pct = 100 × (P0 − P) / P0 (KPIs & Formulas); positive and growing = wear, clogging, dry running', window: '24h', chart: 'number', useCase: 'U8' },
  // DRAFT. The workbook's own GAP: the weights are Things Alive's proposal and Crompton's
  // service team ratifies them. F10's inputs (λ, duty deviation, F/F0', events) on the KPI
  // sheet's bands, mapped one point per % over the line; the 25-point temperature band waits
  // for a calibrated rise (V-04) and the events band for trip reasons from the firmware.
  // Needs the duty curve (load loss), so it reads not_configured until that exists.
  { classes: [PUMP_CLASS], key: 'health_score_draft', inputs: ['motor_current_max', 'input_power', 'current_fluctuation_pct', 'supply_voltage'], unit: 'dimensionless',
    expression: '100 - clamp(100 * (#peak_load_ratio - 1), 0, 25) - clamp(abs(#load_loss_pct), 0, 25) - #instability_score - 5 * #voltage_tier',
    basis: 'DRAFT for Crompton ratification: 100 − overload (1 pt per % over rated, max 25) − duty deviation (1 pt per % load loss, max 25) − instability (max 25) − 5 × voltage tier (max 10) (F10; KPIs & Formulas pump_health_score)',
    window: '24h', chart: 'gauge', target: { value: 100, direction: 'higher_better' }, useCase: 'U2' },
];

/** The machine page (U1): what a motor shows, in order. */
export const LAYOUT: { classes: string[]; key: string; type: string; boundTo: string | null; title: string; size: string }[] = [
  { classes: BOTH, key: 'load', type: 'kpi_gauge', boundTo: 'load_pct', title: 'Load (% of rated current)', size: 'small' },
  { classes: BOTH, key: 'voltage', type: 'kpi_number', boundTo: 'supply_voltage_avg', title: 'Supply voltage', size: 'small' },
  { classes: BOTH, key: 'voltage_tier', type: 'kpi_number', boundTo: 'voltage_tier', title: 'Voltage tier (0 normal, 1 warning, 2 fault)', size: 'small' },
  { classes: BOTH, key: 'power', type: 'kpi_number', boundTo: 'input_power_avg', title: 'Input power', size: 'small' },
  { classes: BOTH, key: 'energy', type: 'kpi_number', boundTo: 'energy_kwh', title: 'Energy today', size: 'small' },
  { classes: BOTH, key: 'running', type: 'kpi_number', boundTo: 'running_pct', title: 'Running (% of last 24 h)', size: 'small' },
  { classes: BOTH, key: 'starts', type: 'kpi_number', boundTo: 'starts_today', title: 'Starts today', size: 'small' },
  { classes: BOTH, key: 'logger_loss', type: 'kpi_number', boundTo: 'logger_records_lost_24h', title: 'Logger records lost (24 h)', size: 'small' },
  { classes: BOTH, key: 'instability', type: 'kpi_number', boundTo: 'instability_score', title: 'Current instability (0-25; not vibration)', size: 'small' },
  { classes: [PUMP_CLASS], key: 'health', type: 'kpi_gauge', boundTo: 'health_score_draft', title: 'Health score (DRAFT, pending Crompton)', size: 'small' },
  { classes: [PUMP_CLASS], key: 'flow', type: 'kpi_number', boundTo: 'flow_estimate_lpm', title: 'Flow (estimated)', size: 'small' },
  { classes: [PUMP_CLASS], key: 'load_loss', type: 'kpi_number', boundTo: 'load_loss_pct', title: 'Load loss vs catalogue', size: 'small' },
  { classes: BOTH, key: 'current_chart', type: 'signal_chart', boundTo: 'motor_current', title: 'Motor current', size: 'large' },
  { classes: BOTH, key: 'voltage_chart', type: 'signal_chart', boundTo: 'supply_voltage', title: 'Supply voltage', size: 'large' },
  { classes: BOTH, key: 'alerts', type: 'alert_list', boundTo: null, title: 'Alerts', size: 'medium' },
  { classes: BOTH, key: 'failure_modes', type: 'failure_modes', boundTo: null, title: 'What can go wrong', size: 'medium' },
  { classes: BOTH, key: 'recommendations', type: 'recommendations', boundTo: null, title: 'What to do', size: 'medium' },
  { classes: BOTH, key: 'readiness', type: 'readiness_list', boundTo: null, title: 'Signals and readiness', size: 'medium' },
];

/** RCA Matrix — Borewell, the rows an electrical-only logger can see (U3). */
export const FAILURE_MODES: { classes: string[]; code: string; name: string; symptom: string; severity: string; signals: string[];
  action: string; urgency: string }[] = [
  { classes: BOTH, code: 'supply_voltage_damage', name: 'Low voltage / unbalance / single-phasing', severity: 'high',
    symptom: 'Current rises as voltage sags; estimated winding temperature climbs; eventual overload trips (RCA 2).',
    signals: ['supply_voltage', 'supply_voltage_min', 'motor_current'],
    action: 'Record the voltage history as evidence of a site fault; separate grid damage from pump defect for warranty (RCA 2).', urgency: 'next_shift' },
  { classes: BOTH, code: 'bearing_drag', name: 'Bearing drag / rotor rub', severity: 'high',
    symptom: 'Current rising at the same duty; starts heavier; overload trips begin (RCA 7).',
    signals: ['motor_current', 'motor_current_max'],
    action: 'Dispatch with a bearing / motor plan before lock-up (RCA 7).', urgency: 'next_service' },
  { classes: BOTH, code: 'destructive_cycling', name: 'Destructive cycling', severity: 'medium',
    symptom: 'Starts per day far above normal (e.g. > 60); short runs (RCA 10).',
    signals: ['motor_current', 'motor_current_max'],
    action: 'Fix the level control / pressure switch or undersized tank; verify starts per day normalise (RCA 10).', urgency: 'next_service' },
  { classes: [PUMP_CLASS], code: 'dry_run', name: 'Dry run', severity: 'critical',
    symptom: 'Current drops ~20-30% while running; flow estimate falls to zero (RCA 1).',
    signals: ['motor_current', 'input_power'],
    action: 'Stop the pump; tell the customer the bore / water level is the cause (RCA 1).', urgency: 'immediate' },
  { classes: [PUMP_CLASS], code: 'impeller_wear', name: 'Impeller / diffuser wear', severity: 'medium',
    symptom: 'Power slightly down vs the catalogue at the same head; load loss grows over weeks (RCA 4).',
    signals: ['input_power'],
    action: 'Plan the impeller replacement under subscription, not as an emergency (RCA 4).', urgency: 'next_service' },
];

/**
 * U4: rules whose bounds are multiples of each motor's ratings (D59). 6 of the last 10
 * one-minute readings must breach: sustained, not a single spike (D34).
 */
export const ALERT_TEMPLATES: { slugSuffix: string; name: string; severity: string;
  params: { signal: string; rating?: string; max?: number; min?: number; lookbackReadings?: number; requiredBreaches?: number } }[] = [
  { slugSuffix: 'overload', name: 'Overload: current above 1.2 × rated', severity: 'critical',
    params: { signal: 'motor_current', rating: 'rated_current', max: 1.2 } },
  { slugSuffix: 'voltage-fault-high', name: 'Voltage above the rated band', severity: 'critical',
    params: { signal: 'supply_voltage', rating: 'voltage_max_operating', max: 1 } },
  { slugSuffix: 'voltage-fault-low', name: 'Voltage below the rated band', severity: 'critical',
    params: { signal: 'supply_voltage', rating: 'voltage_min_operating', min: 1 } },
  { slugSuffix: 'voltage-warn-high', name: 'Voltage above the warning line', severity: 'medium',
    params: { signal: 'supply_voltage', rating: 'voltage_warn_high', max: 1 } },
  { slugSuffix: 'voltage-warn-low', name: 'Voltage below the warning line', severity: 'medium',
    params: { signal: 'supply_voltage', rating: 'voltage_warn_low', min: 1 } },
  // U10, the contract's own instruction: alert if lost_total / dropped_total grow. Any
  // growth in the last ten uploads, once: lost readings are gone, not a trend to wait on.
  { slugSuffix: 'logger-records-lost', name: 'Logger lost data (flash full)', severity: 'medium',
    params: { signal: 'logger_records_lost', max: 0, lookbackReadings: 10, requiredBreaches: 1 } },
  { slugSuffix: 'logger-records-dropped', name: 'Logger could not store readings', severity: 'medium',
    params: { signal: 'logger_records_dropped', max: 0, lookbackReadings: 10, requiredBreaches: 1 } },
];

const WB = 'Crompton_Pump_Library.xlsx';

/**
 * U3: Tier 1 scenarios — each scores its signals against the machine's own baseline,
 * learned from running periods only (z-score: warning 1.5σ, critical 2.5σ). Severity and
 * minimum history from the workbook's Predictions & Alerts sheet. They read "baseline not
 * established" until a machine has that much history: true of every new pump.
 */
export const SCENARIOS: { classes: string[]; slugSuffix: string; name: string; description: string; severity: string;
  requiredSignals: string[]; minimumHistoryDays: number }[] = [
  { classes: BOTH, slugSuffix: 'bearing-drag', name: 'Bearing drag / rotor rub', severity: 'high', minimumHistoryDays: 14,
    requiredSignals: ['motor_current', 'motor_current_max'],
    description: 'Current rising at the same duty against this motor\'s own history; starts heavier (RCA 7). Dispatch before lock-up.' },
  { classes: BOTH, slugSuffix: 'supply-damage', name: 'Supply-side damage risk (sags, low voltage)', severity: 'high', minimumHistoryDays: 3,
    requiredSignals: ['supply_voltage_min', 'motor_current'],
    description: 'Voltage sags with current up against this motor\'s history: winding insulation cooks silently (RCA 2).' },
  { classes: BOTH, slugSuffix: 'destructive-cycling', name: 'Destructive cycling', severity: 'medium', minimumHistoryDays: 7,
    requiredSignals: ['motor_starts'],
    description: 'Starts far above this motor\'s own normal: level control, pressure switch or tank (RCA 10).' },
  { classes: [PUMP_CLASS], slugSuffix: 'wear-clogging', name: 'Impeller wear / clogging', severity: 'medium', minimumHistoryDays: 14,
    requiredSignals: ['input_power', 'current_fluctuation_pct'],
    description: 'Power drifting from this pump\'s own history at the same running pattern (RCA 4, 5, 6); the catalogue curve sharpens it once entered.' },
];

/** The POC motor (Plan P2; Platform Prep Steps A2). Ratings with their sources. */
export const MINI_1HP_MODEL = {
  name: 'Crompton Mini 1 HP (MASTER PLUS I / DURA I)',
  manufacturer: 'Crompton',
  category: 'pump',
  equipmentClassSlug: PUMP_CLASS,
  description: '0.75 kW (1 HP), 220 V single-phase, 25 × 25 mm, residential self-priming (catalogue pp.4-5).',
  ratings: [
    { name: 'rated_output', value: 0.75, source: `${WB}, Platform Prep Steps A2 (catalogue pp.4-5)` },
    { name: 'rated_voltage', value: 220, source: `${WB}, Catalogue Series Library row 2 and Platform Prep A2` },
    { name: 'phases', value: 1, source: `${WB}, Catalogue Series Library row 2 (220 V 1-ph)` },
    { name: 'rated_current', value: 5.5, source: `${WB}, Universal Parameters row 28 (~5.5 A). Approximate: confirm from the pump nameplate (FU-5)` },
    { name: 'voltage_min_operating', value: 180, source: `${WB}, Formula Verification V-05 (Crompton band 180-260 V)` },
    { name: 'voltage_max_operating', value: 260, source: `${WB}, Formula Verification V-05` },
    { name: 'voltage_warn_low', value: 190, source: `${WB}, Formula Verification V-05 (warning 190/250)` },
    { name: 'voltage_warn_high', value: 250, source: `${WB}, Formula Verification V-05` },
    { name: 'insulation_temp_limit', value: 155, source: `${WB}, Formula Verification V-04 (Class F)` },
  ],
};

/** The POC machine and its logger in the motors account. */
export const POC = {
  tenantId: 'motors',
  machineCode: 'POC-MINI-01',
  machineName: 'POC Mini 1 HP (bench)',
  deviceId: 'MOTOR_001',
  shiftTemplate: 'existing-platform-day-night',
};
