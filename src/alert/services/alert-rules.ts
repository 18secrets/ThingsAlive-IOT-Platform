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
export type AlertTrigger = 'prediction-severity' | 'signal-threshold' | 'no-telemetry'
  | 'fuel-loss' | 'chain-origin';

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

/**
 * The field names above, kept in sync with the interface by the compiler rather than
 * by memory: adding or removing a field from `SignalThresholdParams` without updating
 * this object fails to type-check. Exported so anything staging threshold data outside
 * this module — the catalog import template, in particular — can be checked against
 * the same list instead of drifting out of sync with it by hand.
 */
const SIGNAL_THRESHOLD_PARAM_KEY_SET: Record<keyof SignalThresholdParams, true> = {
  signal: true, max: true, min: true,
};
export const SIGNAL_THRESHOLD_PARAM_KEYS = Object.keys(SIGNAL_THRESHOLD_PARAM_KEY_SET) as
  (keyof SignalThresholdParams)[];

export interface NoTelemetryParams {
  /** Nothing to configure. A shift that produced no readings at all fires it. */
  reserved?: never;
}

/**
 * Fire on where a physical chain says a fault entered (task P4-01).
 *
 * The difference from `signal-threshold` is the whole reason this exists. A threshold
 * on coolant temperature fires on a machine working hard, because a hard-working
 * machine really is hot; this fires only when a stage is off the curve its own drivers
 * predict, which a hard-working machine is not. And because the chain names the stage,
 * the alert arrives pointing at a component rather than at a number.
 */
export interface ChainOriginParams {
  /** Fires at this severity or above on the origin stage. */
  atLeast: 'warning' | 'critical';
  /** Restrict to one chain, or watch every chain bound to the machine's class. */
  chainSlug?: string | null;
  /**
   * Restrict to a fault entering at one particular stage.
   *
   * The reason somebody would: a rule that says "tell me when the *oil* is the origin"
   * routes to the engine fitter, and one for the coolant stage routes to whoever looks
   * after radiators. Without it every chain fault lands in one queue and the routing
   * has to be done again by a human reading the summary.
   */
  stageSignal?: string | null;
}

export type AlertParams = PredictionSeverityParams | SignalThresholdParams
  | NoTelemetryParams | FuelLossParams | ChainOriginParams;

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

/** What a chain said about this window, reduced to what a rule needs. */
export interface WindowChain {
  slug: string;
  evaluated: boolean;
  origin?: {
    signal: string;
    label?: string;
    severity?: 'none' | 'warning' | 'critical';
    residual?: number;
    expected?: number;
    actual?: number;
    exceedance?: number;
  };
  /** Downstream stages the origin accounts for, so the alert can say so itself. */
  explainedBy?: { signal: string; because: string }[];
}

export interface EvaluationInput {
  trigger: AlertTrigger;
  params: AlertParams;
  readings: WindowReading[];
  predictions: WindowPrediction[];
  /** Absent on the paths that do not run chains; a chain rule then simply does not fire. */
  chains?: WindowChain[];
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

    case 'chain-origin': {
      const params = input.params as ChainOriginParams;
      const candidates = (input.chains ?? [])
        .filter((c) => c.evaluated && c.origin?.severity)
        .filter((c) => !params.chainSlug || c.slug === params.chainSlug)
        .filter((c) => !params.stageSignal || c.origin!.signal === params.stageSignal);

      const wanted = params.atLeast === 'critical'
        ? ['critical'] : ['warning', 'critical'];
      // Worst first, and within that the furthest past its threshold: one alert per
      // rule per window, so it should be about the worst thing that happened.
      const worst = candidates
        .filter((c) => wanted.includes(c.origin!.severity!))
        .sort((a, b) => {
          const bySeverity = Number(b.origin!.severity === 'critical')
            - Number(a.origin!.severity === 'critical');
          return bySeverity !== 0 ? bySeverity
            : (b.origin!.exceedance ?? 0) - (a.origin!.exceedance ?? 0);
        })[0];
      if (!worst) return null;

      const origin = worst.origin!;
      const name = origin.label ?? origin.signal;
      const gap = origin.residual === undefined ? null
        : `${origin.residual > 0 ? '+' : ''}${origin.residual}`;
      // The summary says what is off its curve and by how much, not what the raw
      // number is. "104 degrees" is true of a healthy machine under load; "18 above
      // what the load explains" is not true of anything healthy.
      const explained = worst.explainedBy?.map((e) => e.signal) ?? [];
      return {
        summary: `${name} is ${gap ?? 'off'} against what its drivers predict`
          + `${origin.expected !== undefined ? ` (expected ${origin.expected})` : ''}.`
          + (explained.length
            ? ` ${explained.join(', ')} ${explained.length === 1 ? 'is' : 'are'} `
              + 'consistent with that and not a separate fault.'
            : ''),
        evidence: {
          chainSlug: worst.slug,
          stage: origin.signal,
          severity: origin.severity,
          actual: origin.actual,
          expected: origin.expected,
          residual: origin.residual,
          exceedance: origin.exceedance,
          explains: explained,
        },
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
  if (trigger === 'chain-origin') {
    const p = params as ChainOriginParams;
    if (p?.atLeast !== 'warning' && p?.atLeast !== 'critical') {
      return 'A chain rule needs "atLeast" to be "warning" or "critical".';
    }
    // A stage named without its chain is ambiguous the moment a second chain for the
    // class also has that stage, and the rule would quietly widen rather than fail.
    if (p.stageSignal && !p.chainSlug) {
      return 'Naming a stage needs the chain it belongs to, or the rule would follow'
        + ' that stage into every chain that has one.';
    }
    return null;
  }
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
