import {
  AlertParams, AlertTrigger, ChainOriginParams, CompositeGroup, CompositeParams, describeSignalThresholdRule,
  isCompositeLeaf, PredictionSeverityParams, SignalDisplayInfo, SignalThresholdParams,
} from './alert-rules';
import { FuelLossParams } from './fuel-loss';

/** How a renderer names a signal. The caller decides where the words come from. */
export type SignalNamer = (signal: string) => SignalDisplayInfo;

/** The plain fallback: the signal key with its underscores read as spaces. */
export const plainSignalName: SignalNamer = (signal) => ({ displayName: signal.replace(/_/g, ' ') });

/**
 * The condition each kind of rule fires on, as a clause — "at least 6 of the last 10
 * readings of coolant temperature rise above 105 degC" — without "Fires when" or the
 * full stop, so a composite can join clauses and a single rule can wrap one.
 *
 * A `Record` over every trigger kind (task QWF1 §8): adding a kind to `AlertTrigger`
 * without a clause here fails to type-check, and the spec iterates `ALERT_TRIGGERS`
 * against it as well, so no rule kind can exist that cannot be read back in words.
 */
export const RULE_CLAUSES: Record<AlertTrigger, (params: AlertParams, name: SignalNamer) => string> = {
  'signal-threshold': (params, name) => {
    const p = params as SignalThresholdParams;
    // The threshold's own sentence, unwrapped — never re-worded. One vocabulary for a
    // threshold whether it stands alone or sits inside a composite.
    return describeSignalThresholdRule(p, name(p.signal)).replace(/^Fires when /, '').replace(/\.$/, '');
  },
  'prediction-severity': (params) => {
    const p = params as PredictionSeverityParams;
    return `${p.clientScenarioSlug ? `the "${p.clientScenarioSlug}" scenario` : 'any scenario'} `
      + `scores ${p.atLeast} or worse`;
  },
  'no-telemetry': () => 'a shift produces no telemetry at all',
  'fuel-loss': (params) => {
    const p = params as FuelLossParams;
    return `fuel drops by at least ${p.dropAtLeast} within ${p.withinMinutes} minutes `
      + 'with the engine off and the machine stationary';
  },
  'chain-origin': (params, name) => {
    const p = params as ChainOriginParams;
    return `${p.chainSlug ? `the "${p.chainSlug}" chain` : 'any chain'} places a fault's origin`
      + `${p.stageSignal ? ` at ${name(p.stageSignal).displayName}` : ''} at ${p.atLeast} or worse`;
  },
  composite: (params, name) => groupClause((params as CompositeParams).condition, name, false),
};

function groupClause(group: CompositeGroup, name: SignalNamer, nested: boolean): string {
  const all = !!group.allOf;
  const clause = (group.allOf ?? group.anyOf ?? [])
    .map((term) => (isCompositeLeaf(term)
      ? RULE_CLAUSES[term.trigger](term.params, name)
      : groupClause(term, name, true)))
    .join(all ? ', and ' : ', or ');
  return nested ? `(${clause})` : clause;
}

/**
 * One sentence for one rule (task QWF1 §8, D34): the read-back of stored parameters.
 * Rendered from what runs — a compiled rule — never from the graph that produced it.
 * A threshold rule comes out byte-identical to `describeSignalThresholdRule`.
 */
export function describeRule(
  rule: { trigger: AlertTrigger; params: AlertParams }, name: SignalNamer = plainSignalName,
): string {
  if (rule.trigger === 'signal-threshold') {
    const p = rule.params as SignalThresholdParams;
    return describeSignalThresholdRule(p, name(p.signal));
  }
  return `Fires when ${RULE_CLAUSES[rule.trigger](rule.params, name)}.`;
}
