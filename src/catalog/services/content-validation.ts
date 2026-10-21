export interface SignalForValidation {
  signal: string;
  unit: string | null;
}

/**
 * Content rules a class must satisfy regardless of which door it came through
 * (task QIMP4). `crane-400-kw` — `source = 'manual'`, never touched by the import —
 * holds a signal `{"unit": null, "signal": "temp"}` that the import validator would
 * have refused outright. Two write paths enforcing two different sets of rules
 * means the stricter set is decoration: anything it refuses can be written through
 * the other door instead. One module, called from both
 * (`CatalogImportValidatorService` and `CatalogAuthoringService`), so there is one
 * place this can be gotten right or wrong, not one per path.
 *
 * Sensor retirement is checked by retiredSignalProblems on both write paths and
 * by database triggers at the write boundary. Uncatalogued legacy signal roles
 * remain supported; this module does not require every role to have a capability.
 */
export function validateSignals(signals: SignalForValidation[]): string[] {
  const problems: string[] = [];
  for (const s of signals) {
    if (!s.unit || !s.unit.trim()) {
      problems.push(`signal "${s.signal}" has no unit.`);
    }
  }
  return problems;
}

/**
 * Checked at publish, not at create/edit — a draft mid-edit legitimately has no
 * signals yet declared. A class published with zero would leave every scenario on
 * it permanently blocked, naming signals the class never promised.
 */
export function validateSignalCountForPublish(signals: unknown[]): string | null {
  return signals.length ? null : 'declares no expected signals; publishing it would help nobody.';
}

/** A scenario requiring nothing is not a scenario — every activation of it would be
 * blocked by nothing and would fire on nothing, which is not a state the product
 * has a name for. */
export function validateScenarioRequiredSignals(requiredSignals: string[]): string | null {
  return requiredSignals.length ? null : 'a scenario must require at least one signal.';
}

/** The OEM figures OEE reads from a class (task QCLASS-OEM). */
export interface OemFigures {
  nominalFuelPerHour: number | null;
  nominalFuelUnit: string | null;
  idleBreakdownThresholdMinutes: number;
  runningSignal: string | null;
  runningIdleBound: number | null;
  availabilitySignal: string | null;
}

/** The task's stated default — not an OEM figure, a definition of "too long idle". */
export const DEFAULT_IDLE_BREAKDOWN_THRESHOLD_MINUTES = 30;
export const MIN_IDLE_BREAKDOWN_THRESHOLD_MINUTES = 5;

/**
 * The same refusals `1759800000000-ClassOemFigures.ts` enforces, said in sentences, so
 * the import can name a row and publish can name the class instead of a constraint.
 * Unset is always fine: a class without OEM figures is a class QOEE1 reports as
 * `parameter_not_set`, not an invalid one.
 */
export function oemFigureProblems(f: OemFigures, declaredSignals: string[]): string[] {
  const problems: string[] = [];
  const declared = new Set(declaredSignals);
  if (f.nominalFuelPerHour !== null && !(f.nominalFuelPerHour > 0)) {
    problems.push(`nominal_fuel_per_hour must be above 0, not ${f.nominalFuelPerHour}.`);
  }
  if (f.nominalFuelPerHour !== null && !f.nominalFuelUnit?.trim()) {
    problems.push('nominal_fuel_per_hour has no unit; a nominal without one cannot be compared to anything.');
  }
  if (f.nominalFuelPerHour === null && f.nominalFuelUnit?.trim()) {
    problems.push(`nominal_fuel_unit "${f.nominalFuelUnit}" is set with no nominal_fuel_per_hour.`);
  }
  if (!Number.isInteger(f.idleBreakdownThresholdMinutes)
    || f.idleBreakdownThresholdMinutes < MIN_IDLE_BREAKDOWN_THRESHOLD_MINUTES) {
    problems.push(
      `idle_breakdown_threshold_minutes must be a whole number of at least ${MIN_IDLE_BREAKDOWN_THRESHOLD_MINUTES}, `
        + `not ${f.idleBreakdownThresholdMinutes}.`,
    );
  }
  if ((f.runningSignal === null) !== (f.runningIdleBound === null)) {
    problems.push('running_signal and running_idle_bound are set together or not at all.');
  }
  for (const [column, signal] of [['running_signal', f.runningSignal], ['availability_signal', f.availabilitySignal]]) {
    if (signal !== null && !declared.has(signal)) {
      problems.push(`${column} "${signal}" is not a signal this class declares.`);
    }
  }
  return problems;
}
