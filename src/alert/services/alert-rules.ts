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
  /**
   * How many recent readings, by source_timestamp, to look at before comparing to
   * the bound (task QALERT1, D34). Unset means the default applies — D32: an
   * unsupplied value is not a declaration, so this is never written as a literal
   * 10 at write time, only read as one.
   */
  lookbackReadings?: number;
  /**
   * Of the last `lookbackReadings`, how many must individually breach the bound
   * before the rule fires (task QALERT2). Replaces D34's max/min-of-the-window
   * reduction outright: reducing a window to its single worst reading and
   * comparing once is indistinguishable from comparing every reading on its own
   * the moment that worst reading is the only one that breaches, which is exactly
   * the single-spike behaviour D34 was supposed to remove and did not. Unset means
   * the default applies, same as `lookbackReadings`.
   */
  requiredBreaches?: number;
}

/** How many recent readings a signal-threshold rule considers absent an explicit
 * `lookbackReadings` (task QALERT1, D34). At the platform's 30-60s sampling rate
 * this is roughly a five-to-ten-minute view: long enough to absorb a spike, short
 * enough not to delay a real excursion. Defined once, read everywhere. */
export const DEFAULT_LOOKBACK_READINGS = 10;
export const MIN_LOOKBACK_READINGS = 1;
export const MAX_LOOKBACK_READINGS = 1000;

/** Of the last `lookbackReadings`, how many must breach absent an explicit
 * `requiredBreaches` (task QALERT2). Six of ten is a majority with margin: a
 * machine genuinely running hot stays over the line for most of a five-to-ten
 * minute window; one bad sample among nine clean ones does not. */
export const DEFAULT_REQUIRED_BREACHES = 6;
export const MIN_REQUIRED_BREACHES = 1;

/**
 * The field names above, kept in sync with the interface by the compiler rather than
 * by memory: adding or removing a field from `SignalThresholdParams` without updating
 * this object fails to type-check. Exported so anything staging threshold data outside
 * this module — the catalog import template, in particular — can be checked against
 * the same list instead of drifting out of sync with it by hand.
 */
const SIGNAL_THRESHOLD_PARAM_KEY_SET: Record<keyof SignalThresholdParams, true> = {
  signal: true, max: true, min: true, lookbackReadings: true, requiredBreaches: true,
};
export const SIGNAL_THRESHOLD_PARAM_KEYS = Object.keys(SIGNAL_THRESHOLD_PARAM_KEY_SET) as
  (keyof SignalThresholdParams)[];

/**
 * Every engine parameter is either staged from the workbook or carries a default in
 * code (task QALERT1). There is no third state, and no key is exempt by silence:
 * adding a parameter to `SignalThresholdParams` forces a choice here too, because
 * this is also `Record<keyof SignalThresholdParams, ...>` — the same compiler-enforced
 * total mapping `SIGNAL_THRESHOLD_PARAM_KEYS` uses, not a narrower view of it.
 *
 * `catalog-import-parse.spec.ts` enforces both halves: every `'staged'` key has a
 * workbook column, and every `'defaulted'` key has a default defined in code. Neither
 * check is allowed to pass by a key going unmentioned in either place.
 */
export const SIGNAL_THRESHOLD_PARAM_SOURCE: Record<keyof SignalThresholdParams, 'staged' | 'defaulted'> = {
  signal: 'staged',
  min: 'staged',
  max: 'staged',
  // Lands with QREC0's template v4 (task QALERT1 item 4). Flipping this to 'staged'
  // is a one-word change — the moment it happens, the workbook-column half of the
  // sync test starts demanding the column, by construction.
  lookbackReadings: 'defaulted',
  // Same reasoning, same template v4 (task QALERT2).
  requiredBreaches: 'defaulted',
};

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
  /**
   * Which logger reported it. Optional because most trigger kinds never cared
   * (duty cycle, chain diagnosis) — signal-threshold does now (task QALERT1, D34):
   * a window is built per (imei, signal), never by pooling every logger that has
   * ever reported a signal name into one series. Absent means the same as any
   * other reading with no imei — they group together, not with a named one.
   */
  imei?: string | null;
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

/** The last `lookbackReadings` of a signal, grouped by logger and ordered
 * most-recent-first by `source_timestamp` (task QALERT1, D34). */
export interface SignalWindow {
  imei: string | null;
  /** Most-recent-first, capped to `lookbackReadings`. */
  readings: WindowReading[];
  /** Why this window cannot possibly reach `requiredBreaches`; null once it can. */
  skippedReason: string | null;
}

/**
 * Groups a shift's readings by (imei, signal) and keeps each group's most recent
 * `lookbackReadings`, without counting breaches yet (task QALERT1, D34; QALERT2).
 *
 * Grouped by imei rather than pooled across every logger that ever reported this
 * signal name: a device swap mid-shift, or two loggers that happen to report the
 * same signal, must not let one logger's noise smear into another's clean window,
 * or dilute a real breach on one logger with a quiet reading from another.
 *
 * A window shorter than `requiredBreaches` is flagged here rather than left for the
 * caller to notice zero breaches on its own — fewer readings than the count needed
 * to fire makes firing mathematically impossible, not merely unlikely, and D34's
 * original fixed floor of 3 was this same reasoning before `requiredBreaches`
 * existed to say it directly (task QALERT2).
 *
 * Exported so a test can assert the skip reason directly, and so a caller wanting
 * to know *why* a rule stayed quiet is not left re-deriving it from a bare `null`.
 */
export function signalWindows(
  readings: WindowReading[], signal: string, lookbackReadings: number, requiredBreaches: number,
): SignalWindow[] {
  const byImei = new Map<string | null, WindowReading[]>();
  for (const r of readings) {
    if (r.signal !== signal) continue;
    const key = r.imei ?? null;
    const group = byImei.get(key);
    if (group) group.push(r); else byImei.set(key, [r]);
  }
  return [...byImei.entries()].map(([imei, group]) => {
    const ordered = group
      .slice()
      .sort((a, b) => new Date(b.sourceTimestamp).getTime() - new Date(a.sourceTimestamp).getTime())
      .slice(0, lookbackReadings);
    return {
      imei,
      readings: ordered,
      skippedReason: ordered.length < requiredBreaches
        ? `only ${ordered.length} reading(s) available in the window; at least `
          + `${requiredBreaches} are needed for that many to possibly breach.`
        : null,
    };
  });
}

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
      const lookbackReadings = params.lookbackReadings ?? DEFAULT_LOOKBACK_READINGS;
      const requiredBreaches = params.requiredBreaches ?? DEFAULT_REQUIRED_BREACHES;
      // Windows too short to possibly reach requiredBreaches are dropped here, not
      // compared: a rule watches "this equipment", but a window that cannot say
      // anything trustworthy must not fire just because it technically has zero
      // breaches (task QALERT1, D34).
      const usable = signalWindows(input.readings, params.signal, lookbackReadings, requiredBreaches)
        .filter((w) => w.skippedReason === null);
      if (usable.length === 0) return null;

      // A window fires on a bound only once at least `requiredBreaches` of its own
      // readings individually breach it (task QALERT2) — max/min-of-the-window is
      // gone: reducing a window to its single worst reading and comparing once is
      // indistinguishable from comparing every reading on its own the moment that
      // worst reading is the only one that breaches, which is the single-spike
      // behaviour D34 was supposed to remove and did not. Each bound is still
      // counted independently, never counted once and compared twice.
      const above = params.max != null
        ? usable
          .map((w) => ({ w, matches: w.readings.filter((r) => r.value > params.max!) }))
          .filter((x) => x.matches.length >= requiredBreaches)
        : [];
      const below = params.min != null
        ? usable
          .map((w) => ({ w, matches: w.readings.filter((r) => r.value < params.min!) }))
          .filter((x) => x.matches.length >= requiredBreaches)
        : [];

      // Worst reading among the windows that actually qualified — not the worst
      // reading in any window, which would let one extreme reading in a window
      // that never reached requiredBreaches masquerade as evidence for one that
      // did. A high breach still wins a tie against a low one, same as before: a
      // shift that went both too hot and too cold is one alert about an unstable
      // machine.
      const high = above
        .flatMap((x) => x.matches.map((r) => ({ r, w: x.w, count: x.matches.length })))
        .sort((a, b) => b.r.value - a.r.value)[0];
      const low = below
        .flatMap((x) => x.matches.map((r) => ({ r, w: x.w, count: x.matches.length })))
        .sort((a, b) => a.r.value - b.r.value)[0];
      const breach = high ?? low;
      if (!breach) return null;

      const direction = breach === high ? 'above' : 'below';
      const bound = direction === 'above' ? params.max! : params.min!;
      const window = breach.w.readings;
      return {
        summary: `${params.signal} breached ${bound}${breach.r.unit ? ` ${breach.r.unit}` : ''} `
          + `${direction} on ${breach.count} of the last ${window.length} readings; `
          + `worst was ${breach.r.value}${breach.r.unit ? ` ${breach.r.unit}` : ''}`,
        evidence: {
          signal: params.signal,
          worstValue: breach.r.value,
          unit: breach.r.unit ?? null,
          at: breach.r.sourceTimestamp,
          direction,
          bound,
          imei: breach.w.imei,
          lookbackReadings,
          requiredBreaches,
          readingsInWindow: window.length,
          breaches: breach.count,
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
    if (p.lookbackReadings != null && (
      !Number.isInteger(p.lookbackReadings)
      || p.lookbackReadings < MIN_LOOKBACK_READINGS
      || p.lookbackReadings > MAX_LOOKBACK_READINGS
    )) {
      return `lookback_readings has to be a whole number from ${MIN_LOOKBACK_READINGS} `
        + `to ${MAX_LOOKBACK_READINGS}.`;
    }
    // Bounded by this rule's own lookback_readings, not a fixed ceiling (task
    // QALERT2): requiring more breaches than the window can ever hold would look
    // configured but could never fire.
    const effectiveLookback = p.lookbackReadings ?? DEFAULT_LOOKBACK_READINGS;
    if (p.requiredBreaches != null && (
      !Number.isInteger(p.requiredBreaches)
      || p.requiredBreaches < MIN_REQUIRED_BREACHES
      || p.requiredBreaches > effectiveLookback
    )) {
      return `required_breaches has to be a whole number from ${MIN_REQUIRED_BREACHES} `
        + `to this rule's lookback_readings (${effectiveLookback}).`;
    }
    return null;
  }
  return null;
}

/** What a renderer needs to name a signal in a sentence — its own vocabulary, not
 * the slug telemetry uses for it. */
export interface SignalDisplayInfo {
  displayName: string;
  unit?: string | null;
}

/**
 * Renders a signal-threshold rule back into the one sentence it means (task
 * QALERT2): "Fires when at least 6 of the last 10 readings of coolant temperature
 * rise above 105 degC." An alert rule is stored parameters a person can read back,
 * never free text — this is that read-back.
 *
 * Pure and framework-free — no repository, no request — so QWF1 (or anything else
 * composing a plain-English summary of a rule) can import it directly rather than
 * this living behind a controller only that one caller can reach.
 */
export function describeSignalThresholdRule(
  params: SignalThresholdParams, signal: SignalDisplayInfo,
): string {
  const lookbackReadings = params.lookbackReadings ?? DEFAULT_LOOKBACK_READINGS;
  const requiredBreaches = params.requiredBreaches ?? DEFAULT_REQUIRED_BREACHES;
  const unitSuffix = signal.unit ? ` ${signal.unit}` : '';
  const clauses: string[] = [];
  if (params.max != null) {
    clauses.push(
      `at least ${requiredBreaches} of the last ${lookbackReadings} readings of ${signal.displayName} `
        + `rise above ${params.max}${unitSuffix}`,
    );
  }
  if (params.min != null) {
    clauses.push(
      clauses.length
        ? `at least ${requiredBreaches} fall below ${params.min}${unitSuffix}`
        : `at least ${requiredBreaches} of the last ${lookbackReadings} readings of ${signal.displayName} `
          + `fall below ${params.min}${unitSuffix}`,
    );
  }
  return `Fires when ${clauses.join(', or ')}.`;
}
