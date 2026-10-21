import { FailureModeStatus } from '../page/page-widgets';
import { DetectEntry } from '../rec-engine/rec-engine.service';
import { BundleOutcome, BundleReason } from '../rec-engine/rec-evidence-bundle.entity';
import { SignalObservation } from '../rec-engine/observe';

/**
 * Every sentence a frame can contain (task QREC2 §3).
 *
 * Templates are code and a deploy, like widget types and operators: the vocabulary is
 * closed, and only what fills it comes from the bundle. A wording change bumps
 * TEMPLATE_VERSION, because a frame cited by its answer_id must still read the way it
 * read when it was cited.
 *
 * No template holds a number of its own. Every number in a sentence comes from a bundle
 * value through `fmt`, which is also how the critic normalises what it compares, so a
 * template that hard-codes "6 of 10" is refused at render (check 3) rather than shipped.
 *
 * Absence has its own sentences and never borrows a positive one's wording: "no history
 * to search" said as "no similar cases" is the defect D21 names. "Normal" and "healthy"
 * appear nowhere — a machine we could not see must not read as one that is fine (G04).
 */
export const TEMPLATE_VERSION = 'rec-frame-templates@1';

/** The one formatter. The critic tokenises with NUMERIC_TOKEN and compares against `fmt` of bundle values. */
export const fmt = {
  num: (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)),
  time: (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`,
  list: (xs: readonly string[]): string => xs.join(', '),
};

/** A formatted time, or a plain number. A date is one token, so "2026" alone cannot slip through on a date's back. */
export const NUMERIC_TOKEN = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC|\d+(?:\.\d+)?/g;

const SCOPE_WORD: Record<string, string> = { equipment: 'machine', site: 'site', client: 'account' };
const MISSING_WORD: Record<string, string> = {
  labour_rate_per_hour: 'no labour rate is set for this machine',
  currency: 'no currency is set for this account',
};
const CANNOT = 'it cannot confirm or rule out anything';

export const TEMPLATES = {
  // ---------------------------------------------------------------- summary: one per outcome or refusal
  'summary.attributed': (a: { mode: string; signals: string[]; also: string[]; stepsFor: string | null }) =>
    `${a.mode} matches this machine's open alerts on ${fmt.list(a.signals)}.`
    + (a.also.length ? ` Also active: ${fmt.list(a.also)}.` : '')
    + (a.also.length && a.stepsFor ? ` The steps below are for ${a.stepsFor}.` : ''),
  'summary.unattributed': (a: { signals: string[]; cls: string }) =>
    `Open alerts on ${fmt.list(a.signals)}, which no failure mode in the ${a.cls} library names. Nothing here is attributed.`,
  'summary.inconclusive': (a: { signals: string[] }) =>
    `No failure mode is active, but ${fmt.list(a.signals)} could not be seen, so this is not a clean result.`,
  'summary.nothing_detected': (a: { observed: number; expected: number }) =>
    `${fmt.num(a.observed)} of ${fmt.num(a.expected)} signals reporting; none outside its limits.`,
  'summary.unclassified': () =>
    'This machine has no equipment class, so there is nothing to check it against.',
  'summary.class_not_in_account': (a: { cls: string }) =>
    `This machine's class (${a.cls}) is not in this account's library, so there is nothing to check it against.`,
  'summary.no_library_content': (a: { cls: string }) =>
    `The ${a.cls} library has no failure modes yet, so there is nothing to check this machine against.`,
  'summary.insufficient_coverage': (a: { expected: number }) =>
    `None of the ${fmt.num(a.expected)} signals this check reads could be seen, so nothing can be said about this machine.`,

  // ---------------------------------------------------------------- detect: one observation per signal not seen as fine
  'detect.anomalous': (a: { signal: string; triggers: string[] }) =>
    `${a.signal}: an open alert is raised on this signal (${fmt.list(a.triggers)}).`,
  'detect.not_observed.stale': (a: { signal: string; lastReadingAt: string }) =>
    `${a.signal} has not reported since ${fmt.time(a.lastReadingAt)}; ${CANNOT}.`,
  'detect.not_observed.no_readings': (a: { signal: string }) =>
    `${a.signal} has never reported on this machine; ${CANNOT}.`,
  'detect.not_observed.unbound': (a: { signal: string }) =>
    `${a.signal} is not connected to a device on this machine; ${CANNOT}.`,
  'detect.not_observed.no_telemetry': (a: { signal: string }) =>
    `${a.signal}: the machine has stopped sending data (a no-telemetry alert is open); ${CANNOT}.`,
  'detect.baseline_not_established': (a: { signal: string }) =>
    `${a.signal}: its usual range is still being learned, so it cannot be judged yet.`,

  // ---------------------------------------------------------------- attribute
  'attribute.active': (a: { mode: string; cls: string; signals: string[] }) =>
    `The pattern is consistent with ${a.mode}, which the ${a.cls} library links to ${fmt.list(a.signals)}.`,
  'attribute.unknown': (a: { mode: string; signals: string[] }) =>
    `${a.mode} cannot be ruled out: ${fmt.list(a.signals)} could not be seen.`,
  'attribute.unattributed': (a: { signal: string; cls: string }) =>
    `${a.signal}: an open alert, and no failure mode in the ${a.cls} library names this signal.`,

  // ---------------------------------------------------------------- precedent: this machine's own history
  'precedent.found': (a: { mode: string; alerts: number; orders: number; hours: number[] }) =>
    `${a.mode}, this machine's history: alerts on its signals, ${fmt.num(a.alerts)}; `
    + `work orders linked to them, ${fmt.num(a.orders)}`
    + (a.hours.length ? ` (time taken: ${a.hours.map((h) => `${fmt.num(h)} h`).join(', ')}).` : '.'),
  'precedent.none_found': (a: { mode: string; since: string }) =>
    `${a.mode}: no alerts on its signals in this machine's history since ${fmt.time(a.since)}.`,
  'precedent.no_history': () =>
    'No history to search — this machine has no recorded alerts, work orders or service records yet.',

  // ---------------------------------------------------------------- gap
  'gap.no_library_recommendation': (a: { mode: string; cls: string }) =>
    `The ${a.cls} library has no recommendation for ${a.mode}.`,
  'gap.in_hand': (a: { mode: string }) =>
    `Already in hand: an open work order covers this. Addresses ${a.mode}.`,
  'gap.unobserved': (a: { signals: string[] }) =>
    `Not seen, so not counted for or against: ${fmt.list(a.signals)}.`,
  'gap.expected_outcome': (a: { mode: string }) => `Addresses ${a.mode}.`,

  // ---------------------------------------------------------------- cost (D23: hours and money only from the client's own rates)
  'cost.ready': (a: { action: string; hours: number; value: number; currency: string; scope: string }) =>
    `Labour for "${a.action}": ${fmt.num(a.hours)} h, ${fmt.num(a.value)} ${a.currency} `
    + `at the labour rate set for this ${SCOPE_WORD[a.scope] ?? a.scope}.`,
  'cost.parameters_required': (a: { missing: string[] }) =>
    `Labour cost not shown: ${fmt.list(a.missing.map((p) => MISSING_WORD[p] ?? `${p} is not set`))}.`,
  'cost.validation_required': (a: { action: string }) =>
    `Labour cost not shown for "${a.action}": the library gives no time estimate for it.`,
  'cost.pending': () => 'Downtime, parts and fuel costs are not worked out yet.',

  // ---------------------------------------------------------------- limitations that are not one step's
  'limitation.attribution_is_lookup': () =>
    'This is a library lookup, not a diagnosis: a suspected cause is not a confirmed one.',
  'limitation.no_forecast_model': () =>
    'Forecast-based detection is not used yet: no forecast model is running for these signals.',
  'limitation.unattributable_alert': (a: { count: number }) =>
    `${fmt.num(a.count)} open alerts come from rules that name no signal, so they cannot be matched to a failure mode.`,
  'limitation.no_reference_documents': () => 'No reference documents are searchable yet.',
};

export type TemplateKey = keyof typeof TEMPLATES;

/** Look a template up by key; a state with no template is a bug, and says so instead of rendering nothing. */
export function template<K extends TemplateKey>(key: K): (typeof TEMPLATES)[K] {
  const t = TEMPLATES[key];
  if (typeof t !== 'function') throw new Error(`No frame template for ${key}`);
  return t;
}

// ---------------------------------------------------------------------------- the state sets

/** Compiles only when U covers every member of T: a new QREC1 state fails the build here. */
type Covers<T, U extends T> = [T] extends [U] ? true : never;

const OUTCOMES = ['attributed', 'unattributed', 'inconclusive', 'nothing_detected'] as const satisfies readonly BundleOutcome[];
const REASONS = ['unclassified', 'class_not_in_account', 'no_library_content', 'insufficient_coverage'] as const satisfies readonly BundleReason[];
const DETECT = ['anomalous', 'normal', 'baseline_not_established', 'not_observed'] as const satisfies readonly DetectEntry['state'][];
/** QREC1 writes `reason` as a string; its values are the freshness states plus the two it adds itself. */
const NOT_OBSERVED = ['stale', 'no_readings', 'unbound', 'no_telemetry'] as const satisfies readonly (Exclude<SignalObservation['freshness'], 'ready'> | 'unbound' | 'no_telemetry')[];
const MODES = ['active', 'unknown', 'clear'] as const satisfies readonly FailureModeStatus[];
const covered: [
  Covers<BundleOutcome, (typeof OUTCOMES)[number]>, Covers<BundleReason, (typeof REASONS)[number]>,
  Covers<DetectEntry['state'], (typeof DETECT)[number]>,
  Covers<Exclude<SignalObservation['freshness'], 'ready'>, Exclude<(typeof NOT_OBSERVED)[number], 'unbound' | 'no_telemetry'>>,
  Covers<FailureModeStatus, (typeof MODES)[number]>,
] = [true, true, true, true, true];
void covered;

/**
 * Every `(section, state)` the bundle can produce, as a template key. Detect's
 * not_observed is split by reason because each reason is a different sentence.
 */
export const BUNDLE_STATE_KEYS: readonly string[] = [
  ...OUTCOMES.map((s) => `summary.${s}`),
  ...REASONS.map((s) => `summary.${s}`),
  ...DETECT.flatMap((s) => (s === 'not_observed' ? NOT_OBSERVED.map((r) => `detect.not_observed.${r}`) : [`detect.${s}`])),
  ...MODES.map((s) => `attribute.${s}`),
  'attribute.unattributed',
  ...['found', 'none_found', 'no_history'].map((s) => `precedent.${s}`),
  ...['no_library_recommendation', 'in_hand', 'unobserved'].map((s) => `gap.${s}`),
  ...['ready', 'parameters_required', 'validation_required', 'pending'].map((s) => `cost.${s}`),
];

/**
 * States deliberately not phrased, each with the reason. Listed rather than silently
 * skipped, so the coverage test can tell "not phrased on purpose" from "forgotten".
 */
export const NOT_PHRASED: Readonly<Record<string, string>> = {
  'detect.normal': 'a signal seen and within its limits is counted in the nothing_detected summary, never listed as an observation',
  'attribute.clear': 'a mode with every signal seen and nothing pointing at it is not a finding; listing it would read as a clean bill',
};
