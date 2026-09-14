import { Severity, SEVERITY_ORDER } from '../../common/severity';
import { detectFuelLoss, FuelLossParams, validateFuelLoss } from './fuel-loss';

/**
 * What an alert watches for (task P1-119).
 *
 * Three kinds, and each exists because something in the runtime can be true without
 * anybody being told:
 *
 *  - `prediction-severity` — the scorer said something and nobody is watching the
 *    screen. This is the ordinary one.
 *  - `signal-threshold` — a value the client knows matters, independent of any model.
 *    A scorer compares a machine against its own history; a threshold compares it
 *    against what the manufacturer said, and those disagree in useful ways.
 *  - `no-telemetry` — a shift ran and the machine said nothing. Silence is the one
 *    condition a predictive platform cannot predict its way out of, and it is
 *    indistinguishable from "everything is fine" unless somebody asks for it.
 *  - `fuel-loss` — fuel left a machine that was switched off and did not move. First
 *    in Things Alive's own build order, and the one case here that needs no model, no
 *    baseline and no history at all: a tank, a key and a GPS fix.
 */
export type AlertTrigger = 'prediction-severity' | 'signal-threshold' | 'no-telemetry' | 'fuel-loss';

export interface PredictionSeverityParams {
  /** Fires at this severity or above. */
  atLeast: Severity;
  /** Restrict to one scenario, or watch every scenario on the machine. */
  clientScenarioSlug?: string | null;
}

export interface SignalThresholdParams {
  signal: string;
  /** Either bound may be omitted; at least one is required. */
  max?: number | null;
  min?: number | null;
}

export interface NoTelemetryParams {
  /** Nothing to configure. A shift that produced no readings at all fires it. */
  reserved?: never;
}

export type AlertParams = PredictionSeverityParams | SignalThresholdParams
  | NoTelemetryParams | FuelLossParams;

export interface WindowReading {
  signal: string;
  value: number;
  unit?: string | null;
  sourceTimestamp: string;
}

export interface WindowPrediction {
  clientScenarioSlug: string;
  severity: Severity;
  riskScore: number;
  predictionId: string;
  confidence: string;
}

export interface EvaluationInput {
  trigger: AlertTrigger;
  params: AlertParams;
  readings: WindowReading[];
  predictions: WindowPrediction[];
}

export interface Firing {
  summary: string;
  /** What was true when it fired, kept so it can be explained without recomputing. */
  evidence: Record<string, unknown>;
  predictionId?: string | null;
}

const atOrAbove = (value: Severity, floor: Severity): boolean =>
  SEVERITY_ORDER.indexOf(value) >= SEVERITY_ORDER.indexOf(floor);

/**
 * Does this rule fire for this shift window, and what is the evidence?
 *
 * Pure, and it returns the evidence rather than a boolean. An alert that says a
 * machine is in trouble and cannot say why is worse than no alert: somebody walks to
 * the machine, finds nothing obvious, and trusts the next one less. The evidence is
 * captured at the moment of firing because the readings behind it will have been
 * superseded by the time anybody looks.
 */
export function evaluateRule(input: EvaluationInput): Firing | null {
  switch (input.trigger) {
    case 'prediction-severity': {
      const params = input.params as PredictionSeverityParams;
      const candidates = params.clientScenarioSlug
        ? input.predictions.filter((p) => p.clientScenarioSlug === params.clientScenarioSlug)
        : input.predictions;

      // A scorer that could not score has not said the machine is fine; it has said
      // nothing. Firing on that would train people to ignore the alert.
      const scored = candidates.filter((p) => p.confidence !== 'none');
      const worst = scored
        .filter((p) => atOrAbove(p.severity, params.atLeast))
        .sort((a, b) => b.riskScore - a.riskScore)[0];
      if (!worst) return null;

      return {
        summary: `${worst.clientScenarioSlug} scored ${worst.severity} (risk ${Math.round(worst.riskScore)})`,
        predictionId: worst.predictionId,
        evidence: {
          clientScenarioSlug: worst.clientScenarioSlug,
          severity: worst.severity,
          riskScore: worst.riskScore,
          confidence: worst.confidence,
          threshold: params.atLeast,
        },
      };
    }

    case 'signal-threshold': {
      const params = input.params as SignalThresholdParams;
      const values = input.readings.filter((r) => r.signal === params.signal);
      if (values.length === 0) return null;

      const high = params.max != null
        ? values.filter((r) => r.value > params.max!).sort((a, b) => b.value - a.value)[0]
        : undefined;
      const low = params.min != null
        ? values.filter((r) => r.value < params.min!).sort((a, b) => a.value - b.value)[0]
        : undefined;
      // The worst breach in either direction, because a shift that went both too hot
      // and too cold is one alert about an unstable machine, not two.
      const breach = high ?? low;
      if (!breach) return null;

      const direction = breach === high ? 'above' : 'below';
      const bound = breach === high ? params.max : params.min;
      return {
        summary: `${params.signal} reached ${breach.value}${breach.unit ? ` ${breach.unit}` : ''}, `
          + `${direction} ${bound}`,
        evidence: {
          signal: params.signal,
          worstValue: breach.value,
          unit: breach.unit ?? null,
          at: breach.sourceTimestamp,
          direction,
          bound,
          readingsInWindow: values.length,
          breaches: values.filter((r) =>
            (params.max != null && r.value > params.max) || (params.min != null && r.value < params.min),
          ).length,
        },
      };
    }

    case 'fuel-loss': {
      const finding = detectFuelLoss(input.readings, input.params as FuelLossParams);
      if (!finding) return null;
      return {
        summary: `${finding.droppedBy} of fuel gone in ${finding.overMinutes} minutes, `
          + 'with the engine off and the machine stationary.',
        evidence: { ...finding },
      };
    }

    case 'no-telemetry': {
      if (input.readings.length > 0) return null;
      return {
        summary: 'The shift produced no telemetry at all.',
        evidence: { readingsInWindow: 0 },
      };
    }

    default:
      return null;
  }
}

/** Everything a rule of each kind must carry, checked once on write. */
export function validateParams(trigger: AlertTrigger, params: AlertParams): string | null {
  if (trigger === 'prediction-severity') {
    const p = params as PredictionSeverityParams;
    if (!p?.atLeast || !SEVERITY_ORDER.includes(p.atLeast)) {
      return `A severity rule needs "atLeast" to be one of: ${SEVERITY_ORDER.join(', ')}.`;
    }
    // 'none' means every scored prediction fires it, which is an alert on every shift
    // of every machine — and an alert that always fires is one nobody reads.
    if (p.atLeast === Severity.None) {
      return 'A rule that fires at severity "none" would fire on every shift of every machine.';
    }
    return null;
  }
  if (trigger === 'fuel-loss') return validateFuelLoss(params as FuelLossParams);
  if (trigger === 'signal-threshold') {
    const p = params as SignalThresholdParams;
    if (!p?.signal?.trim()) return 'A threshold rule needs a signal.';
    if (p.max == null && p.min == null) {
      return 'A threshold rule needs a maximum, a minimum, or both.';
    }
    if (p.max != null && p.min != null && p.min >= p.max) {
      // Nothing can be both, so this rule can never fire and would look configured.
      return 'The minimum has to be below the maximum, or the rule can never fire.';
    }
    return null;
  }
  return null;
}
