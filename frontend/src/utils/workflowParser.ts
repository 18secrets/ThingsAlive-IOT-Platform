// Turns a plain-English alert description into a draft workflow (QWF1's WorkflowSpec):
// a ReadSignal → Threshold pair per condition found, a No data or Prediction severity
// condition when asked for, joined by All of / Any of when there is more than one,
// ending in a Notify. It's a light heuristic, not an NLP pipeline — the editor shows
// exactly what it made, and the server validates it.
//
// What it reads, beyond the conditions (the AI alert prompt test log, 17 Nov 2026, where
// each of these was asked for and silently dropped): the name the person gave, the
// message to send, the severity they set (never a severity word inside that name), how
// many readings must breach of how many, and the unit a value was given in.
import type { WorkflowScope, WorkflowSpec, WorkflowSpecNode, WorkflowVersionStatus } from './workflowTypes';

/** What the editor opens: a spec, plus where it is stored once it has been saved. */
export interface WorkflowDraft {
  name: string;
  /** Kept with the workflow on its first save; the prompt it was generated from, say. */
  description?: string;
  spec: WorkflowSpec;
  workflowId?: string;
  version?: number;
  status?: WorkflowVersionStatus;
  layout?: Record<string, { x: number; y: number }>;
  /** Shown above the canvas when it opens: what an assembly left for the person to finish. */
  notes?: string[];
}

type Operator = '>' | '<' | 'delta';

// Filler, imperative and unit words that are never a sensor name themselves — stripped
// out of whatever the regex window captures, rather than trying to get the regex to land
// on the exact right word count up front. That split (grab a generous window, then clean
// it) is what keeps "Notify me if pump energy consumption spikes above 55" from becoming
// a sensor called "notify_me_if_pump..." while still keeping multi-word sensors like
// "converter oil temperature" intact. Unit words are here because "…above 100 bar and
// also below 40" left "bar" as the second condition's sensor (test log S.NO 10).
const STOPWORDS = new Set([
  'and', 'or', 'but', 'the', 'a', 'an', 'average', 'overall', 'total', 'if', 'when', 'whenever', 'then', 'also',
  'once', 'only', 'both', 'either', 'is', 'are', 'stays', 'remains', 'goes', 'gets', 'me', 'us', 'team', 'please',
  'alert', 'alerts', 'notify', 'warn', 'warns', 'raise', 'raises', 'trigger', 'triggers', 'let', 'know', 'tell',
  'critical', 'high', 'medium', 'low', 'alarm', 'alarms', 'this', 'that', 'it', 'ignore', 'for', 'over', 'within',
  'in', 'last', 'of', 'to', 'on', 'at', 'with', 'while', 'same', 'time',
  'minute', 'minutes', 'second', 'seconds', 'hour', 'hours', 'day', 'days',
  'bar', 'psi', 'kpa', 'mpa', 'degree', 'degrees', 'deg', 'c', 'f', 'v', 'kv', 'mv', 'ma', 'rpm',
]);

function cleanSubject(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join('_');
}

interface RawMatch {
  sensor: string;
  operator: Operator;
  value: number;
  /** As typed after the number ("psi", "°C"), normalised; null when none was given. */
  unit: string | null;
  pos: number;
  end: number;
}

// Subject is a generous, bounded window (up to 6 words) anchored on a word
// boundary; cleanup happens afterward in cleanSubject rather than here.
const SUBJECT = '\\b((?:[a-z]+\\s+){0,5}?[a-z]+)';
// A number and, if given, its unit. The lookahead keeps "8 and" from reading as 8 A.
const VALUE = '(-?\\d+(?:\\.\\d+)?)\\s*(°\\s*[cf]|deg(?:rees?)?\\s*[cf]?|psi|bar|kpa|mpa|kv|mv|ma|v|a|%|rpm|mm\\/s)?(?![a-z])';
const ABOVE = '(?:is\\s+|stays\\s+|remains\\s+|spikes\\s+|rises\\s+|climbs\\s+|goes\\s+|gets\\s+|runs\\s+)?(?:up\\s+)?'
  + '(?:above|over|exceeds|exceeding|more than|greater than|higher than|beyond|>=?|≥)';
const BELOW = '(?:is\\s+|stays\\s+|remains\\s+|drops\\s+|falls\\s+|dips\\s+|goes\\s+|gets\\s+|runs\\s+)?(?:down\\s+)?'
  + '(?:below|under|less than|lower than|beneath|<=?|≤)';

// Matched in priority order; each hit blanks out its span in a scratch copy of the text
// so later patterns can't re-match the same words. "Rises by" is recognised only so it
// can be reported: a threshold on a change has no node.
const CONDITION_PATTERNS: { regex: RegExp; operator: Operator }[] = [
  { regex: new RegExp(`${SUBJECT}\\s+${ABOVE}\\s*${VALUE}`, 'gi'), operator: '>' },
  { regex: new RegExp(`${SUBJECT}\\s+${BELOW}\\s*${VALUE}`, 'gi'), operator: '<' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:increases?|spikes?|goes up|drops?|decreases?|falls?)\\s+by\\s+${VALUE}`, 'gi'), operator: 'delta' },
];

// What follows a number that makes it a duration or a count, not a threshold.
const NOT_A_THRESHOLD = /^\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|readings?|times?)\b/i;

/** A span already read, blanked with a mark that is not whitespace: no later window spans it. */
const blank = (text: string, from: number, to: number) => text.slice(0, from) + '\u0001'.repeat(to - from) + text.slice(to);

function extractConditions(text: string): RawMatch[] {
  let working = text;
  const found: RawMatch[] = [];
  for (const { regex, operator } of CONDITION_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(working))) {
      const end = m.index + m[0].length;
      if (!NOT_A_THRESHOLD.test(working.slice(end))) {
        found.push({ sensor: cleanSubject(m[1]), operator, value: Number(m[2]), unit: normaliseUnit(m[3]), pos: m.index, end });
      }
      working = blank(working, m.index, end);
    }
  }
  found.sort((a, b) => a.pos - b.pos);
  // A condition whose window was filler only ("…above 100 bar and also below 40") is
  // about the signal named just before it (S.NO 10): it takes that one, rather than
  // being dropped or named after the filler.
  const out: RawMatch[] = [];
  for (const c of found) {
    if (c.sensor) out.push(c);
    else if (out.length && c.operator !== 'delta') out.push({ ...c, sensor: out[out.length - 1].sensor });
  }
  return out;
}

/**
 * Words that say what kind of measurement, not which one. Sharing only these is no match:
 * "pump energy consumption" is not fuel_consumption, and "pressure drop across the valves"
 * is not engine_oil_pressure — the second became a rule that fired on every normal
 * reading (test report MIN-9).
 */
const GENERIC_WORDS = new Set([
  'temperature', 'temp', 'pressure', 'level', 'oil', 'consumption', 'rate', 'status', 'speed',
  'engine', 'load', 'flow', 'current', 'voltage', 'value', 'reading',
]);

/**
 * The declared signal a phrase most likely means: exact, then one name containing the
 * other, then the most shared words — at least one of them specific, or two of any kind.
 * Unmatched phrases are kept as typed, and the server names them as undeclared rather
 * than this guessing further.
 */
export function matchSignal(phrase: string, declared: string[]): { signal: string; matched: boolean; alternatives: string[] } {
  if (!declared.length) return { signal: phrase, matched: false, alternatives: [] };
  const exact = declared.find((s) => s === phrase);
  if (exact) return { signal: exact, matched: true, alternatives: [] };
  // Several names that all contain the phrase ("oil pressure": engine and hydraulic) are
  // equally likely: the first is taken, and the others named (test log S.NO 17).
  const containing = declared.filter((s) => s.includes(phrase) || phrase.includes(s));
  if (containing.length) return { signal: containing[0], matched: true, alternatives: containing.slice(1) };
  const words = phrase.split('_');
  const scored: { signal: string; score: number }[] = [];
  for (const s of declared) {
    const shared = s.split('_').filter((w) => words.includes(w));
    const specific = shared.filter((w) => !GENERIC_WORDS.has(w)).length;
    if (specific === 0 && shared.length < 2) continue;
    scored.push({ signal: s, score: shared.length + specific });
  }
  if (!scored.length) return { signal: phrase, matched: false, alternatives: [] };
  const top = Math.max(...scored.map((x) => x.score));
  const tied = scored.filter((x) => x.score === top).map((x) => x.signal);
  return { signal: tied[0], matched: true, alternatives: tied.slice(1) };
}

// ------------------------------------------------------------------ units (S.NO 16)

/** "°C", "deg c", "degrees f", "kPa", "PSI" → one spelling. Null for none or unknown. */
export function normaliseUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.toLowerCase().replace(/\s+/g, '');
  if (/^(°c|degc|degreec|degreesc|celsius)$/.test(u)) return 'degc';
  if (/^(°f|degf|degreef|degreesf|fahrenheit)$/.test(u)) return 'degf';
  if (['bar', 'kpa', 'psi', 'mpa', 'v', 'kv', 'mv', 'a', 'ma', '%', 'rpm', 'mm/s'].includes(u)) return u;
  return null;
}

/** Linear units by family, as a factor to the family's base. Temperature is apart: it has an offset. */
const UNIT_FACTOR: Record<string, { family: string; factor: number }> = {
  bar: { family: 'pressure', factor: 1e5 }, kpa: { family: 'pressure', factor: 1e3 }, mpa: { family: 'pressure', factor: 1e6 },
  psi: { family: 'pressure', factor: 6894.757 },
  v: { family: 'voltage', factor: 1 }, kv: { family: 'voltage', factor: 1e3 }, mv: { family: 'voltage', factor: 1e-3 },
  a: { family: 'current', factor: 1 }, ma: { family: 'current', factor: 1e-3 },
};

const UNIT_LABEL: Record<string, string> = { degc: '°C', degf: '°F', kpa: 'kPa', mpa: 'MPa', bar: 'bar', psi: 'psi', v: 'V', kv: 'kV', mv: 'mV', a: 'A', ma: 'mA' };
export const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

const round = (n: number) => Math.round(n * 100) / 100;

/** `value` in `from`, in `to`; null when the two cannot be converted. */
export function convertUnit(value: number, from: string, to: string): number | null {
  if (from === to) return value;
  if (from === 'degf' && to === 'degc') return round((value - 32) * 5 / 9);
  if (from === 'degc' && to === 'degf') return round(value * 9 / 5 + 32);
  const a = UNIT_FACTOR[from];
  const b = UNIT_FACTOR[to];
  if (!a || !b || a.family !== b.family) return null;
  return round((value * a.factor) / b.factor);
}

// ------------------------------------------------------------------ the rest of the sentence

const QUOTE = `["“”'‘’]`;
const NOT_QUOTE = `[^"“”'‘’]`;
/** "named “X”", "called 'X'", "titled "X"" — the name the person gave. */
const NAME = new RegExp(`\\b(?:named|called|titled|name\\s+it)\\s*[:=]?\\s*${QUOTE}(${NOT_QUOTE}{2,120})${QUOTE}`, 'i');
/** "notify that …", "send a notification stating that …", "with the message …" — up to the end of the sentence. */
const MESSAGE = /\b(?:notify|notification|message|tell(?:ing)?\s+(?:me|us|them|the\s+\w+))\b(?:\s+\w+){0,3}?\s+(?:that|saying|stating(?:\s+that)?|:)\s+(.+?)(?:\.(?:\s|$)|$)/i;
/** The severity as an instruction, in the forms the test log used. First found wins. */
const SEVERITY_SET = [
  /\bseverity\s*(?:to|=|:|as|is|of)?\s*(?:level\s+)?(critical|high|medium|low)\b/i,
  /\b(?:mark|set|make|flag|treat|classify)\s+(?:it|this|them|the\s+alert)\s+(?:as\s+)?(critical|high|medium|low)\b/i,
  /\b(critical|high|medium|low)[\s-]+(?:severity|priority)\b/i,
];
/** "at least 3 of the last 5 readings", "4 out of the last 8 readings". */
const COUNT = /\b(?:at\s+least\s+)?(\d+)\s+(?:out\s+)?of\s+(?:the\s+)?(?:last|latest|previous|recent|most\s+recent)\s+(\d+)(?:\s+readings?)?/gi;
/** "in the last 8 readings", with no count. */
const LOOKBACK_ONLY = /\b(?:in|over|for|across)\s+(?:the\s+)?(?:last|latest|previous)\s+(\d+)\s+readings?\b/gi;
/** The editor's own field names, said in the prompt (S.NO 13). */
const FIELD_LOOKBACK = /\breadings\s+considered\s*(?:to|=|:|as|is|of)?\s*(\d+)/i;
const FIELD_BREACHES = /\breadings\s+that\s+must\s+breach\s*(?:to|=|:|as|is|of)?\s*(\d+)/i;
/** "no outrigger pressure readings are received", "stops sending data", "telemetry lost" (S.NO 9). */
const NO_DATA = /\bno\s+((?:[a-z]+\s+){0,4}?)(?:readings?|data|telemetry|signals?|values?)\b|\b(?:stops?|stopped)\s+(?:sending|reporting|transmitting)\b|\b(?:data|telemetry|readings?)\s+(?:is\s+|are\s+)?(?:missing|lost|not\s+received)\b|\bgoes\s+(?:quiet|silent|offline)\b/i;
/** "the prediction severity for this machine is high", "predicted failure" (S.NO 12). */
const PREDICTION = /\bpredict(?:ion|ions|ed|s)?\b/i;
const PREDICTION_LEVEL = /\bprediction(?:s)?\s+(?:severity\s+)?(?:\w+\s+){0,4}?(?:is|reaches|hits|at|of|=)\s+(?:at\s+least\s+)?(critical|high|medium|low)\b/i;

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** What the parser noticed, for the assistant to say in the reader's language. */
export interface ParseNote {
  key: 'converted' | 'unitMismatch' | 'noDataWholeMachine' | 'breachesOverLookback' | 'ambiguousSignal';
  values: Record<string, string | number>;
}

export interface Contradiction { signal: string; above: number; below: number }

export interface ParsedPrompt {
  draft: WorkflowDraft;
  /** Conditions turned into nodes: thresholds, No data and Prediction severity. */
  conditions: number;
  /** Phrases that named no declared signal; kept as typed. */
  unmatched: string[];
  /** "Rises by N" style conditions, which have no node and were left out. */
  unsupported: string[];
  notes: ParseNote[];
  /** "Above 100 and below 40" on one signal, all required: a rule that can never fire. */
  contradictions: Contradiction[];
}

interface Counts { lookbackReadings?: number; requiredBreaches?: number }

/**
 * @param units  each declared signal's unit, as its class declares it; a value given in
 *               another unit of the same kind is converted to it.
 */
export function parsePromptToWorkflow(
  prompt: string, scope: WorkflowScope, declared: string[], name?: string, units: Record<string, string | null> = {},
): ParsedPrompt {
  const text = prompt.trim();
  const notes: ParseNote[] = [];

  // The name and the message first, and out of the text the rest is read from: a quoted
  // "Low Outrigger Pressure" set severity Low over "Set the severity to Critical" (S.NO 4).
  let working = text;
  const named = working.match(NAME);
  if (named?.index != null) working = blank(working, named.index, named.index + named[0].length);
  const said = working.match(MESSAGE);
  if (said?.index != null) working = blank(working, said.index, said.index + said[0].length);
  const message = said ? sentence(said[1]) : null;

  // Severity: as an instruction first, then any severity word left in the text.
  let severity: string = 'high';
  const prediction = PREDICTION.test(working) ? working.match(PREDICTION_LEVEL) : null;
  const forSeverity = prediction?.index != null ? blank(working, prediction.index, prediction.index + prediction[0].length) : working;
  const instructed = SEVERITY_SET.map((re) => forSeverity.match(re)).find(Boolean);
  if (instructed) severity = instructed[1].toLowerCase();
  else {
    const any = forSeverity.toLowerCase().match(/\b(critical|high|medium|low)\b/);
    if (any) severity = any[1];
  }

  // Readings counts, each with the position it was said at.
  const counts: (Counts & { pos: number })[] = [];
  for (const m of working.matchAll(COUNT)) {
    counts.push({ pos: m.index ?? 0, requiredBreaches: Number(m[1]), lookbackReadings: Number(m[2]) });
  }
  for (const m of working.matchAll(LOOKBACK_ONLY)) {
    if (!counts.some((c) => Math.abs(c.pos - (m.index ?? 0)) < 40)) counts.push({ pos: m.index ?? 0, lookbackReadings: Number(m[1]) });
  }
  const fieldLookback = working.match(FIELD_LOOKBACK);
  const fieldBreaches = working.match(FIELD_BREACHES);
  const everyCondition: Counts = {
    ...(fieldLookback ? { lookbackReadings: Number(fieldLookback[1]) } : {}),
    ...(fieldBreaches ? { requiredBreaches: Number(fieldBreaches[1]) } : {}),
  };
  let forConditions = working;
  for (const re of [COUNT, LOOKBACK_ONLY, FIELD_LOOKBACK, FIELD_BREACHES]) {
    forConditions = forConditions.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), (s) => '\u0001'.repeat(s.length));
  }

  const raw = extractConditions(forConditions);
  const unsupported = raw.filter((c) => c.operator === 'delta').map((c) => c.sensor.replace(/_/g, ' '));
  const unmatched: string[] = [];

  const seen = new Set<string>();
  const usable = raw.filter((c) => c.operator !== 'delta').map((c) => {
    const { signal, matched, alternatives } = matchSignal(c.sensor, declared);
    if (!matched) unmatched.push(c.sensor.replace(/_/g, ' '));
    // More than one signal fits equally: the choice is made and said, with the others,
    // so it is seen and changed on the Read signal box rather than silently kept.
    if (alternatives.length) {
      notes.push({ key: 'ambiguousSignal', values: {
        phrase: c.sensor.replace(/_/g, ' '), chosen: signal.replace(/_/g, ' '),
        others: alternatives.map((a) => a.replace(/_/g, ' ')).join(', '),
      } });
    }
    // The value in the signal's own unit (S.NO 16: 29 psi was saved as 29 bar).
    const target = normaliseUnit(units[signal]);
    let value = c.value;
    if (c.unit && target && c.unit !== target) {
      const converted = convertUnit(c.value, c.unit, target);
      if (converted != null) {
        value = converted;
        notes.push({ key: 'converted', values: { from: `${c.value} ${unitLabel(c.unit)}`, to: `${converted} ${unitLabel(target)}`, signal: signal.replace(/_/g, ' ') } });
      } else {
        notes.push({ key: 'unitMismatch', values: { unit: unitLabel(c.unit), signalUnit: unitLabel(target), signal: signal.replace(/_/g, ' ') } });
      }
    }
    return { ...c, signal, value, shownUnit: target ?? c.unit };
  }).filter((c) => !seen.has(`${c.signal}${c.operator}${c.value}`) && seen.add(`${c.signal}${c.operator}${c.value}`));

  // Each count goes to the condition said just before it; one said before any condition, to the first.
  const countFor = new Map<number, Counts>();
  for (const k of counts) {
    const before = usable.map((c, i) => ({ c, i })).filter(({ c }) => c.pos < k.pos && !countFor.has(usable.indexOf(c)));
    const target = before.length ? before[before.length - 1].i : usable.findIndex((_, i) => !countFor.has(i));
    if (target >= 0) countFor.set(target, { lookbackReadings: k.lookbackReadings, requiredBreaches: k.requiredBreaches });
  }

  const lower = ` ${forConditions.toLowerCase()} `;
  const orFirst = /\b(?:or|either|any of)\b/.test(lower)
    && (lower.indexOf(' and ') === -1 || lower.search(/\b(?:or|either)\b/) < lower.indexOf(' and '));

  // A rule that can never fire: above X and below Y on one signal, both required, X ≥ Y.
  const contradictions: Contradiction[] = [];
  if (!orFirst) {
    for (const signal of new Set(usable.map((c) => c.signal))) {
      const above = usable.filter((c) => c.signal === signal && c.operator === '>').map((c) => c.value);
      const below = usable.filter((c) => c.signal === signal && c.operator === '<').map((c) => c.value);
      if (above.length && below.length && Math.max(...above) >= Math.min(...below)) {
        contradictions.push({ signal: signal.replace(/_/g, ' '), above: Math.max(...above), below: Math.min(...below) });
      }
    }
  }

  const nodes: WorkflowSpecNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const conditionIds = usable.map((c, i) => {
    const n = i + 1;
    const counted: Counts = { ...everyCondition, ...(countFor.get(i) ?? {}) };
    if (counted.requiredBreaches != null && counted.requiredBreaches > (counted.lookbackReadings ?? 10)) {
      notes.push({ key: 'breachesOverLookback', values: { breaches: counted.requiredBreaches, lookback: counted.lookbackReadings ?? 10 } });
      delete counted.requiredBreaches;
    }
    nodes.push(
      { id: `signal-${n}`, type: 'ReadSignal', params: { signal: c.signal } },
      { id: `threshold-${n}`, type: 'Threshold', params: { ...(c.operator === '>' ? { max: c.value } : { min: c.value }), ...counted } },
    );
    edges.push({ from: `signal-${n}`, to: `threshold-${n}` });
    return `threshold-${n}`;
  });

  // No data: on the signal named, when the machine has it (ReadSignal → No data); else the
  // whole machine stopped sending, and the note says that is what it watches.
  const noData = forConditions.match(NO_DATA);
  let noDataSignal: string | null = null;
  if (noData) {
    const about = cleanSubject(noData[1] ?? '');
    const found = about ? matchSignal(about, declared) : null;
    nodes.push({ id: 'no-data', type: 'FreshnessGate', params: {} });
    if (found?.matched) {
      noDataSignal = found.signal;
      nodes.push({ id: 'no-data-signal', type: 'ReadSignal', params: { signal: found.signal } });
      edges.push({ from: 'no-data-signal', to: 'no-data' });
    } else if (about) {
      notes.push({ key: 'noDataWholeMachine', values: { signal: about.replace(/_/g, ' ') } });
    }
    conditionIds.push('no-data');
  }
  // Prediction severity: a prediction for this machine at a level or above.
  const predictionLevel = prediction || PREDICTION.test(forConditions)
    ? (SEVERITIES.find((s) => s === prediction?.[1]?.toLowerCase()) ?? 'high') : null;
  if (predictionLevel) {
    nodes.push({ id: 'prediction', type: 'PredictionSeverity', params: { atLeast: predictionLevel } });
    conditionIds.push('prediction');
  }

  // Named for what it watches, not after the sentence typed: two rules on Development
  // were called "Notify me if pump energy consumption spikes above 55kWh…" (MIN-9).
  const described = [
    ...usable.map((c) => `${c.signal.replace(/_/g, ' ')} ${c.operator === '>' ? 'above' : 'below'} ${c.value}${c.shownUnit ? ` ${unitLabel(c.shownUnit)}` : ''}`),
    ...(noData ? [noDataSignal ? `no ${noDataSignal.replace(/_/g, ' ')} readings` : 'no data from the machine'] : []),
    ...(predictionLevel ? [`prediction severity ${predictionLevel} or above`] : []),
  ];
  const fromConditions = described.length ? described.join(orFirst ? ' or ' : ' and ').replace(/^./, (ch) => ch.toUpperCase()) : '';
  const title = (name || named?.[1]?.trim() || fromConditions.slice(0, 80) || text.slice(0, 80) || 'New alert').slice(0, 120);

  let last = conditionIds[0];
  if (conditionIds.length > 1) {
    nodes.push({ id: 'combine', type: orFirst ? 'AnyOf' : 'AllOf' });
    conditionIds.forEach((id) => edges.push({ from: id, to: 'combine' }));
    last = 'combine';
  }
  if (last) {
    // The message the person asked for; else what it watches, in words. Never the raw prompt.
    const notifyText = message ?? (fromConditions ? sentence(fromConditions) : '');
    nodes.push({ id: 'notify', type: 'Notify', params: { name: title, severity, ...(notifyText ? { description: notifyText.slice(0, 500) } : {}) } });
    edges.push({ from: last, to: 'notify' });
  }

  return {
    draft: { name: title, ...(text ? { description: message ?? text } : {}), spec: { kind: 'alert', scope, nodes, edges } },
    conditions: conditionIds.length, unmatched, unsupported, notes, contradictions,
  };
}

/** Capitalised and ending in a full stop. */
function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

// Loose keyword check used only to decide whether the "Identifying Sensors"
// checklist step can be marked active while still in the clarifying phase.
const SENSOR_KEYWORDS = [
  'temperature', 'pressure', 'vibration', 'fuel', 'battery', 'voltage', 'engine',
  'speed', 'energy', 'level', 'humidity', 'oil', 'flow', 'current', 'torque', 'frequency',
];

export function mentionsSensorKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSOR_KEYWORDS.some((kw) => lower.includes(kw));
}

/** A slug the server accepts (`^[a-z0-9][a-z0-9-]{1,63}$`), unique enough to not collide. */
export function slugFor(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'workflow';
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}
