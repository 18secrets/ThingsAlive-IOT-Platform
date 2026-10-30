// Turns a plain-English alert description into a draft workflow (QWF1's WorkflowSpec):
// a ReadSignal → Threshold pair per condition found, joined by All of / Any of when
// there is more than one, ending in a Notify. It's a light heuristic, not an NLP
// pipeline — the editor shows exactly what it made, and the server validates it.
import type { WorkflowScope, WorkflowSpec, WorkflowSpecNode, WorkflowVersionStatus } from '../lib/api';

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

// Filler and imperative words that are never a sensor name themselves —
// stripped out of whatever the regex window captures, rather than trying
// to get the regex to land on the exact right word count up front. That
// split (grab a generous window, then clean it) is what keeps "Notify me
// if pump energy consumption spikes above 55" from becoming a sensor
// called "notify_me_if_pump..." while still keeping multi-word sensors
// like "converter oil temperature" intact.
const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'average', 'overall', 'total', 'if', 'when', 'then', 'also', 'once',
  'is', 'are', 'stays', 'remains', 'me', 'us', 'team', 'please', 'alert', 'alerts', 'notify', 'warn',
  'warns', 'raise', 'raises', 'critical', 'high', 'medium', 'low', 'alarm', 'alarms', 'this', 'that',
  'it', 'ignore', 'for', 'over', 'within', 'in', 'last', 'of', 'to', 'on', 'at', 'with',
  'minute', 'minutes', 'second', 'seconds', 'hour', 'hours', 'day', 'days',
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
  pos: number;
}

// Subject is a generous, bounded window (up to 6 words) anchored on a word
// boundary; cleanup happens afterward in cleanSubject rather than here.
const SUBJECT = '\\b((?:[a-z]+\\s+){0,5}?[a-z]+)';

// Matched in priority order; each hit blanks out its span in a scratch copy
// of the text so later patterns can't re-match the same words. "Rises by" is
// recognised only so it can be reported: a threshold on a change has no node.
const CONDITION_PATTERNS: { regex: RegExp; operator: Operator }[] = [
  { regex: new RegExp(`${SUBJECT}\\s+(?:is\\s+|stays\\s+|remains\\s+|spikes\\s+|rises\\s+|climbs\\s+|goes\\s+up\\s+)?(?:above|exceeds|more than|greater than)\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '>' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:is\\s+|stays\\s+|remains\\s+|drops\\s+|falls\\s+)?(?:below|less than|under)\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '<' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:increases?|spikes?|goes up|drops?|decreases?|falls?)\\s+by\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: 'delta' },
];

function extractConditions(text: string): RawMatch[] {
  let working = text;
  const found: RawMatch[] = [];
  for (const { regex, operator } of CONDITION_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(working))) {
      const sensor = cleanSubject(m[1]);
      // A window that was pure filler (e.g. "for" in "...for more than 3
      // minutes", a duration clause, not a sensor threshold) cleans down
      // to nothing — that's a signal to drop the match, not a sensor.
      if (sensor) found.push({ sensor, operator, value: Number(m[2]), pos: m.index });
      working = working.slice(0, m.index) + ' '.repeat(m[0].length) + working.slice(m.index + m[0].length);
    }
  }
  found.sort((a, b) => a.pos - b.pos);
  return found;
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
export function matchSignal(phrase: string, declared: string[]): { signal: string; matched: boolean } {
  if (!declared.length) return { signal: phrase, matched: false };
  const exact = declared.find((s) => s === phrase);
  if (exact) return { signal: exact, matched: true };
  const containing = declared.find((s) => s.includes(phrase) || phrase.includes(s));
  if (containing) return { signal: containing, matched: true };
  const words = phrase.split('_');
  let best: { signal: string; score: number } | null = null;
  for (const s of declared) {
    const shared = s.split('_').filter((w) => words.includes(w));
    const specific = shared.filter((w) => !GENERIC_WORDS.has(w)).length;
    if (specific === 0 && shared.length < 2) continue;
    const score = shared.length + specific;
    if (!best || score > best.score) best = { signal: s, score };
  }
  return best ? { signal: best.signal, matched: true } : { signal: phrase, matched: false };
}

function extractSeverity(text: string): string {
  const m = text.toLowerCase().match(/\b(critical|high|medium|low)\b/);
  return m ? m[1] : 'high';
}

export interface ParsedPrompt {
  draft: WorkflowDraft;
  /** Threshold conditions turned into nodes. */
  conditions: number;
  /** Phrases that named no declared signal; kept as typed. */
  unmatched: string[];
  /** "Rises by N" style conditions, which have no node and were left out. */
  unsupported: string[];
}

export function parsePromptToWorkflow(prompt: string, scope: WorkflowScope, declared: string[], name?: string): ParsedPrompt {
  const text = prompt.trim();
  const raw = extractConditions(text);
  const unsupported = raw.filter((c) => c.operator === 'delta').map((c) => c.sensor.replace(/_/g, ' '));
  const unmatched: string[] = [];

  const seen = new Set<string>();
  const usable = raw.filter((c) => c.operator !== 'delta').map((c) => {
    const { signal, matched } = matchSignal(c.sensor, declared);
    if (!matched) unmatched.push(c.sensor.replace(/_/g, ' '));
    return { ...c, signal };
  }).filter((c) => !seen.has(`${c.signal}${c.operator}`) && seen.add(`${c.signal}${c.operator}`));

  const nodes: WorkflowSpecNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const conditionIds = usable.map((c, i) => {
    const n = i + 1;
    nodes.push(
      { id: `signal-${n}`, type: 'ReadSignal', params: { signal: c.signal } },
      { id: `threshold-${n}`, type: 'Threshold', params: c.operator === '>' ? { max: c.value } : { min: c.value } },
    );
    edges.push({ from: `signal-${n}`, to: `threshold-${n}` });
    return `threshold-${n}`;
  });

  const lower = ` ${text.toLowerCase()} `;
  const orFirst = lower.indexOf(' or ') !== -1 && (lower.indexOf(' and ') === -1 || lower.indexOf(' or ') < lower.indexOf(' and '));
  // Named for what it watches, not after the sentence typed: two rules on Development
  // were called "Notify me if pump energy consumption spikes above 55kWh…" (MIN-9).
  const described = usable.map((c) => `${c.signal.replace(/_/g, ' ')} ${c.operator === '>' ? 'above' : 'below'} ${c.value}`);
  const fromConditions = described.length
    ? (described.join(orFirst ? ' or ' : ' and ').replace(/^./, (ch) => ch.toUpperCase())) : '';
  const title = name || fromConditions.slice(0, 80) || text.slice(0, 80) || 'New alert';
  let last = conditionIds[0];
  if (conditionIds.length > 1) {
    nodes.push({ id: 'combine', type: orFirst ? 'AnyOf' : 'AllOf' });
    conditionIds.forEach((id) => edges.push({ from: id, to: 'combine' }));
    last = 'combine';
  }
  if (last) {
    nodes.push({ id: 'notify', type: 'Notify', params: { name: title.slice(0, 120), severity: extractSeverity(text), ...(text ? { description: text.slice(0, 500) } : {}) } });
    edges.push({ from: last, to: 'notify' });
  }

  return {
    draft: { name: title, ...(text ? { description: text } : {}), spec: { kind: 'alert', scope, nodes, edges } },
    conditions: usable.length, unmatched, unsupported,
  };
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
