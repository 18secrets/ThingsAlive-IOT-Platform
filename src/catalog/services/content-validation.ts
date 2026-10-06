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
