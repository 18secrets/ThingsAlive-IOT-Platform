import { DEFAULT_WINDOW_DAYS } from './baseline.service';
import { influenceModelFrom } from './influence';
import { DEFAULT_INFLUENCE_WINDOW_HOURS } from './prediction.service';
import { scenarioNumber } from './scenario-params';
import { DEFAULT_CRITICAL_SIGMA, DEFAULT_MINIMUM_SAMPLES, DEFAULT_WARNING_SIGMA } from './tier1';

/**
 * The rule a scenario is scored by, in the numbers the scorer will use (fuel test report
 * FU-1, TC-FP-01): "Scenario rule logic evaluated server-side, not shown; no formula,
 * threshold or rate in the master library to validate against."
 *
 * Nothing here is a description written beside the code. Each figure is read by the same
 * `scenarioNumber` the scorer calls, with the same fallbacks, so a threshold shown is the
 * threshold applied. When a scenario carries an influence model the scorer tries it first
 * and falls back to the baseline rule when the window cannot answer, so both are shown.
 */
export interface ScenarioRule {
  /** What scores it first. */
  method: 'influence@1' | 'tier1@1';
  requiredSignals: string[];
  minimumHistoryDays: number;
  /** The machine's own baseline rule: always present, the influence model's fallback. */
  baseline: {
    windowDays: number;
    warningSigma: number;
    criticalSigma: number;
    minimumSamples: number;
    sentence: string;
  };
  influence: null | {
    target: string;
    intercept: number;
    terms: { signal: string; coefficient: number }[];
    warnAbove: number;
    criticalAbove: number;
    windowHours: number;
    formula: string;
    sentence: string;
  };
}

export function scenarioRule(
  scenario: { requiredSignals: string[]; minimumHistoryDays: number; parameters: { key: string; default: unknown }[] | null },
): ScenarioRule {
  const num = (key: string, fallback: number) => scenarioNumber(scenario.parameters, null, key, fallback);
  const windowDays = num('baseline_window_days', DEFAULT_WINDOW_DAYS);
  const warningSigma = num('warning_sigma', DEFAULT_WARNING_SIGMA);
  const criticalSigma = num('critical_sigma', DEFAULT_CRITICAL_SIGMA);
  const minimumSamples = num('minimum_samples', DEFAULT_MINIMUM_SAMPLES);
  const signals = scenario.requiredSignals.join(', ') || 'no signal';

  const model = influenceModelFrom(scenario.parameters, {});
  const windowHours = num('influence_window_hours', DEFAULT_INFLUENCE_WINDOW_HOURS);
  const influence = model ? {
    target: model.target, intercept: model.intercept,
    terms: model.terms.map((t) => ({ signal: t.signal, coefficient: t.coefficient })),
    warnAbove: model.warnAbove, criticalAbove: model.criticalAbove, windowHours,
    formula: `expected ${model.target} = ${model.intercept}`
      + model.terms.map((t) => ` ${t.coefficient < 0 ? '-' : '+'} ${Math.abs(t.coefficient)} × ${t.signal}`).join(''),
    sentence: `Over the last ${windowHours} h, each ${model.target} reading is compared with what its influences say it `
      + `should be; a residual above ${model.warnAbove} is a warning and above ${model.criticalAbove} critical.`,
  } : null;

  return {
    method: influence ? 'influence@1' : 'tier1@1',
    requiredSignals: [...scenario.requiredSignals],
    minimumHistoryDays: scenario.minimumHistoryDays,
    baseline: {
      windowDays, warningSigma, criticalSigma, minimumSamples,
      sentence: `The newest reading of each of ${signals}, taken while the machine was operating, is compared with `
        + `the same machine's own ${windowDays}-day average while operating: ${warningSigma} standard deviations away `
        + `is a warning, ${criticalSigma} critical. A signal with fewer than ${minimumSamples} operating samples in `
        + 'its baseline is not judged.',
    },
    influence,
  };
}
