/**
 * The motor library, as data: what `provision.ts` loads into the platform through its
 * own API (catalog import, alert templates, a model with ratings, a grant).
 *
 * Source: Crompton_Pump_Library.xlsx (sheets Signal Dictionary, KPIs & Formulas,
 * Universal Parameters & Formulas, Formula Verification, RCA Matrix — Borewell,
 * Predictions & Alerts). Every rated figure below names where it came from. What the
 * workbook does not give is left out, not guessed (G07), with three exceptions taken on
 * purpose so the POC runs before Crompton answers, each marked PROVISIONAL where it is
 * used and each replaced by editing one rating or one weight, not the formulas:
 *   - the health-score weights (the workbook's own GAP): the KPI sheet's own bands;
 *   - the temperature rise (V-04): the firmware's 40 °C over 30 °C ambient, advisory;
 *   - the locked-rotor multiple: a typical small single-phase figure.
 * Still left out: the Mini's duty table input power per head (catalogue p.5), so the
 * flow estimate and expected-power KPIs read not_configured until the curve is entered.
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
  // The logger's added sensors (firmware team, 9 Nov 2026): measured, optional per logger.
  { signal: 'ambient_temperature', unit: 'degC', required: false, description: 'Environment (air) temperature at the pump, one-minute average (sensor).' },
  { signal: 'vibration_velocity', unit: 'mm/s', required: false, description: 'Vibration velocity RMS on the pump/motor body, one-minute average (sensor).' },
  { signal: 'vibration_velocity_max', unit: 'mm/s', required: false, description: 'Highest vibration reading in the minute (sensor).' },
  { signal: 'device_load_pct', unit: 'dimensionless', required: false, description: 'The logger\'s own load figure, % of rated (device).' },
  { signal: 'water_air_gap', unit: 'dimensionless', required: false, description: 'Water / air-gap sensor reading, stored as sent. Unit and meaning to confirm with the firmware team.' },
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
// The platform has no unit conversion (QCE3), so a difference in mm/s or degC divided by a
// width in the same unit is written as (x - x + width): the width carries the unit and the
// ratio comes out dimensionless.
const tempBand = (t: string) =>
  `clamp(25 * (${t} - @insulation_temp_limit + 45) / (@insulation_temp_limit - @insulation_temp_limit + 15), 0, 25)`;
/** The health score's bands without sensors: instability stands in for vibration. */
const ELECTRICAL_DEDUCTIONS = `1.2 * #instability_score + ${tempBand('#winding_temp_est')}`
  + ' + 5 * #voltage_tier + clamp(50 * (#peak_load_ratio - 1), 0, 10)';
/**
 * With the sensors: vibration on ISO 10816 class I (machines ≤ 15 kW) — 0 points at the
 * B/C line 1.8 mm/s, all 30 at the C/D line 4.5 mm/s — and the winding estimate on the
 * measured ambient rather than an assumed one.
 */
const SENSOR_DEDUCTIONS = 'clamp(30 * (avg(vibration_velocity) - 1.8) / (avg(vibration_velocity) - avg(vibration_velocity) + 2.7), 0, 30)'
  + ` + ${tempBand('#winding_temp_measured')}`
  + ' + 5 * #voltage_tier + clamp(50 * (#peak_load_ratio - 1), 0, 10)';

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
  { classes: BOTH, key: 'running_pct_mtd', expression: '100 * avg(motor_running_share)', inputs: ['motor_running_share'], unit: 'dimensionless',
    basis: 'Month to date: the per-pump monthly figure the subscription report needs (Plan P5; U9 target 99%)', window: 'mtd', chart: 'number', useCase: 'U9' },
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
  // F4: speed from the slip model, replacing the firmware's cube-root figure (V-02, wrong
  // physics for a fixed-speed motor). As a share of synchronous speed: the platform has no
  // Hz-to-rpm conversion (QCE3), and N_sync = 120 f / p is in the model's ratings
  // (3,000 rpm for the 2-pole Mini, so 95% ≈ 2,850 rpm).
  { classes: BOTH, key: 'motor_speed_pct', inputs: ['motor_current'], unit: 'dimensionless',
    expression: `clamp(100 * (1 - @rated_slip * ${lambda}), 0, 100)`,
    basis: 'F4: N / N_sync = 1 − s_rated × λ_I, as %; N_sync = 120 f / p (replaces cbrt(VA), V-02)', window: '24h', chart: 'number', useCase: 'U1' },
  // F8 overtemperature on the estimate: warning at T_class − 45, fault at T_class − 30.
  { classes: BOTH, key: 'temperature_tier', inputs: ['motor_current'], unit: 'dimensionless',
    expression: 'if(#winding_temp_est >= @insulation_temp_limit - 30, 2, if(#winding_temp_est >= @insulation_temp_limit - 45, 1, 0))',
    basis: 'F8: 0 normal, 1 warning (≥ T_class − 45), 2 fault (≥ T_class − 30), on the estimated winding temperature (advisory, V-04)',
    window: '24h', chart: 'number', useCase: 'U4' },
  // F8 locked rotor: λ above 0.6 × k_lock. On the minute's peak, where a stall shows.
  { classes: BOTH, key: 'locked_rotor', inputs: ['motor_current_max'], unit: 'dimensionless',
    expression: 'if(#peak_load_ratio > 0.6 * @locked_rotor_multiple, 1, 0)',
    basis: 'F8: 1 when peak current exceeds 0.6 × locked-rotor multiple × rated current', window: '24h', chart: 'number', useCase: 'U4' },
  // The KPI sheet's dry_run_judgement (V-03): duty-referenced, not the flat %I < 80 rule.
  { classes: [PUMP_CLASS], key: 'dry_run', inputs: ['input_power'], unit: 'dimensionless',
    expression: 'if(and(#load_loss_pct > 25, #flow_estimate_lpm < 1), 1, 0)',
    basis: 'dry_run_judgement: load loss above 25% of the catalogue power at install head AND flow estimate ~0 (V-03)',
    window: '24h', chart: 'number', useCase: 'U3' },
  // PROVISIONAL weights: the KPI sheet's own pump_health_score bands, until Crompton's
  // service team ratifies them (the workbook's GAP). Each band maps onto what this
  // logger can see; a band whose inputs are missing makes the score not_configured,
  // never silently higher (GATE). Changing a weight is an edit here and a reload.
  //   vibration zone 0-30   → current instability (0-25) × 1.2: the only proxy (V-07)
  //   temperature 0-25      → 0 at the warning line T_class − 45, 25 at the fault line T_class − 30
  //   duty deviation 0-25   → 1 point per % load loss vs the catalogue (pump, with its curve)
  //   unbalance 0-10        → supply: 5 per voltage tier (single-phase has no unbalance)
  //   trip/dry-run 0-10     → overload: 0 at rated, 10 at the 1.2 × trip line
  // Two scores, because the duty band needs the catalogue curve and Crompton has not sent
  // it: health_score is the four electrical bands rescaled × 4/3 to read out of 100, live
  // on every motor and pump today; health_score_with_duty is all five, and lights up on a
  // pump once its model has a duty curve and its install head is set.
  // Three scores now the logger has vibration and ambient sensors (firmware, 9 Nov 2026):
  //   health_score            measured vibration + temperature on measured ambient + supply + overload, × 4/3
  //   health_score_with_duty  the same plus the duty band: all five, once the curve is entered (pump)
  //   health_score_electrical the earlier electrical-only score, for loggers without the sensors
  { classes: BOTH, key: 'health_score', inputs: ['motor_current', 'motor_current_max', 'vibration_velocity', 'ambient_temperature', 'supply_voltage'], unit: 'dimensionless',
    expression: `100 - (4 / 3) * (${SENSOR_DEDUCTIONS})`,
    basis: 'PROVISIONAL, pending Crompton: 100 − 4/3 × (vibration [ISO 10816 class I: 0 at 1.8, 30 at 4.5 mm/s] + temperature margin on measured ambient [max 25] + 5 × voltage tier [max 10] + overload [max 10]) (F10; KPIs & Formulas pump_health_score bands, duty band excluded)',
    window: '24h', chart: 'gauge', target: { value: 100, direction: 'higher_better' }, useCase: 'U2' },
  { classes: [PUMP_CLASS], key: 'health_score_with_duty', inputs: ['motor_current', 'motor_current_max', 'input_power', 'vibration_velocity', 'ambient_temperature', 'supply_voltage'], unit: 'dimensionless',
    expression: `100 - (${SENSOR_DEDUCTIONS}) - clamp(abs(#load_loss_pct), 0, 25)`,
    basis: 'PROVISIONAL, pending Crompton: 100 − vibration (max 30) − temperature margin (max 25) − duty deviation (max 25) − 5 × voltage tier (max 10) − overload (max 10) (F10; all five pump_health_score bands)',
    window: '24h', chart: 'gauge', target: { value: 100, direction: 'higher_better' }, useCase: 'U2' },
  { classes: BOTH, key: 'health_score_electrical', inputs: ['motor_current', 'motor_current_max', 'current_fluctuation_pct', 'supply_voltage'], unit: 'dimensionless',
    expression: `100 - (4 / 3) * (${ELECTRICAL_DEDUCTIONS})`,
    basis: 'PROVISIONAL, for loggers without vibration/ambient sensors: 100 − 4/3 × (instability×1.2 [max 30] + temperature margin on the assumed ambient [max 25] + 5 × voltage tier [max 10] + overload [max 10])',
    window: '24h', chart: 'gauge', target: { value: 100, direction: 'higher_better' }, useCase: 'U2' },
  // The sensors on their own.
  { classes: BOTH, key: 'vibration_avg', expression: 'avg(vibration_velocity)', inputs: ['vibration_velocity'], unit: 'mm/s',
    basis: 'Vibration velocity RMS, 24 h mean (sensor). ISO 10816 class I: ≤ 0.71 good, ≤ 1.8 satisfactory, ≤ 4.5 unsatisfactory, above unacceptable',
    window: '24h', chart: 'number', useCase: 'U2' },
  { classes: BOTH, key: 'vibration_zone', inputs: ['vibration_velocity_max'], unit: 'dimensionless',
    expression: 'if(max(vibration_velocity_max) > 4.5, 2, if(max(vibration_velocity_max) > 1.8, 1, 0))',
    basis: 'ISO 10816 class I on the 24 h peak: 0 zone A/B (≤ 1.8 mm/s), 1 zone C (≤ 4.5), 2 zone D (> 4.5)',
    window: '24h', chart: 'number', useCase: 'U4' },
  { classes: BOTH, key: 'ambient_temp_avg', expression: 'avg(ambient_temperature)', inputs: ['ambient_temperature'], unit: 'degC',
    basis: 'Environment temperature, 24 h mean (sensor) (U7)', window: '24h', chart: 'number', useCase: 'U7' },
  { classes: BOTH, key: 'winding_temp_measured', inputs: ['motor_current', 'ambient_temperature'], unit: 'degC',
    expression: `avg(ambient_temperature) + @rated_temp_rise * ${lambda} * ${lambda}`,
    basis: 'F5 on the measured ambient: T_amb(measured) + ΔT_rated × λ². Advisory until bench-calibrated (V-04)', window: '24h', chart: 'number', useCase: 'U2' },
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
  { classes: BOTH, key: 'health', type: 'kpi_gauge', boundTo: 'health_score', title: 'Health score (provisional weights)', size: 'small' },
  { classes: BOTH, key: 'health_electrical', type: 'kpi_gauge', boundTo: 'health_score_electrical', title: 'Health score, electrical only (loggers without vibration sensor)', size: 'small' },
  { classes: BOTH, key: 'vibration', type: 'kpi_number', boundTo: 'vibration_avg', title: 'Vibration (mm/s RMS)', size: 'small' },
  { classes: BOTH, key: 'vibration_zone', type: 'kpi_number', boundTo: 'vibration_zone', title: 'Vibration zone (0 A/B, 1 C, 2 D)', size: 'small' },
  { classes: BOTH, key: 'ambient', type: 'kpi_number', boundTo: 'ambient_temp_avg', title: 'Ambient temperature', size: 'small' },
  { classes: [PUMP_CLASS], key: 'health_duty', type: 'kpi_gauge', boundTo: 'health_score_with_duty', title: 'Health incl. duty deviation (needs the catalogue curve)', size: 'small' },
  { classes: BOTH, key: 'speed', type: 'kpi_number', boundTo: 'motor_speed_pct', title: 'Speed (% of synchronous, slip model)', size: 'small' },
  { classes: BOTH, key: 'temperature_tier', type: 'kpi_number', boundTo: 'temperature_tier', title: 'Temperature tier (0 normal, 1 warning, 2 fault)', size: 'small' },
  { classes: [PUMP_CLASS], key: 'flow', type: 'kpi_number', boundTo: 'flow_estimate_lpm', title: 'Flow (estimated)', size: 'small' },
  { classes: [PUMP_CLASS], key: 'load_loss', type: 'kpi_number', boundTo: 'load_loss_pct', title: 'Load loss vs catalogue', size: 'small' },
  { classes: BOTH, key: 'current_chart', type: 'signal_chart', boundTo: 'motor_current', title: 'Motor current', size: 'large' },
  { classes: BOTH, key: 'voltage_chart', type: 'signal_chart', boundTo: 'supply_voltage', title: 'Supply voltage', size: 'large' },
  { classes: BOTH, key: 'vibration_chart', type: 'signal_chart', boundTo: 'vibration_velocity', title: 'Vibration', size: 'large' },
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
    symptom: 'Vibration rising; current rising at the same duty; starts heavier; overload trips begin (RCA 7).',
    signals: ['vibration_velocity', 'motor_current', 'motor_current_max'],
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
  // ISO 10816 class I (≤ 15 kW): zone C from 1.8 mm/s, zone D (damage) from 4.5. Fixed
  // lines, not ratings: the standard sets them by machine class, not by model.
  { slugSuffix: 'vibration-warning', name: 'Vibration in ISO zone C (above 1.8 mm/s)', severity: 'medium',
    params: { signal: 'vibration_velocity', max: 1.8 } },
  { slugSuffix: 'vibration-critical', name: 'Vibration in ISO zone D (above 4.5 mm/s)', severity: 'critical',
    params: { signal: 'vibration_velocity', max: 4.5 } },
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
  { classes: BOTH, slugSuffix: 'bearing-vibration', name: 'Bearing wear (vibration trend)', severity: 'high', minimumHistoryDays: 7,
    requiredSignals: ['vibration_velocity', 'vibration_velocity_max'],
    description: 'Vibration rising against this motor\'s own history before it reaches ISO zone D: bearing wear, misalignment or looseness (RCA 7). Plan the bearing job.' },
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
    { name: 'rated_frequency', value: 50, source: `${WB}, Catalogue Series Library (Indian supply, 50 Hz)` },
    { name: 'poles', value: 2, source: `${WB}, Formula Verification V-02 (real speed ~2,850 rpm: a 2-pole motor)` },
    { name: 'rated_slip', value: 0.05, source: `${WB}, Formula Verification V-02: 1 − 2,850 / 3,000. Confirm from the datasheet` },
    { name: 'rated_temp_rise', value: 40, source: `PROVISIONAL. ${WB}, Formula Verification V-04: the firmware's 40 °C, uncalibrated; bench-calibrate in POC T0` },
    { name: 'ambient_temp_reference', value: 30, source: `PROVISIONAL. ${WB}, Formula Verification V-04: the firmware's fixed 30 °C ambient; set per site where measured` },
    { name: 'locked_rotor_multiple', value: 6, source: 'PROVISIONAL. Typical for small single-phase induction motors (5-7 × rated); confirm from the Crompton datasheet' },
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
