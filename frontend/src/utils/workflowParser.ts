// Turns a plain-English alert description into the small node-graph the
// Work Flow editor renders (trigger -> read/condition per sensor -> optional
// guard -> logic gate -> actions). It's a light heuristic, not an NLP
// pipeline — good enough to make the AI Assistant demo feel responsive to
// what someone actually typed, not just replay a canned example.

export type WorkflowOperator = '>' | '<' | '>=' | '<=' | '=';
export type WorkflowActionType = 'Webhook' | 'Email' | 'SMS';

export interface WorkflowCondition {
  sensor: string; // snake_case, e.g. "converter_oil_temperature"
  operator: WorkflowOperator;
  value: string;
}

export interface WorkflowGuard {
  field: string;
  value: string;
}

export interface WorkflowSpec {
  name: string;
  scheduleLabel: string;
  conditions: WorkflowCondition[];
  guard?: WorkflowGuard;
  logic: 'AND' | 'OR';
  actions: WorkflowActionType[];
  sourcePrompt?: string;
}

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
  const words = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  return words.join('_');
}

interface RawMatch {
  sensor: string;
  operator: WorkflowOperator;
  value: string;
  pos: number;
}

// Subject is a generous, bounded window (up to 6 words) anchored on a word
// boundary — generous enough that a real multi-word sensor name always
// fits inside it alongside whatever preamble precedes it, since cleanup
// happens afterward in cleanSubject rather than here.
const SUBJECT = '\\b((?:[a-z]+\\s+){0,5}?[a-z]+)';

// Matched in priority order; each hit blanks out its span in a scratch copy
// of the text so later patterns can't re-match the same words.
const CONDITION_PATTERNS: { regex: RegExp; operator: WorkflowOperator }[] = [
  { regex: new RegExp(`${SUBJECT}\\s+(?:is\\s+|stays\\s+|remains\\s+|spikes\\s+|rises\\s+|climbs\\s+|goes\\s+up\\s+)?(?:above|exceeds|more than|greater than)\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '>' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:is\\s+|stays\\s+|remains\\s+|drops\\s+|falls\\s+)?(?:below|less than|under)\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '<' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:increases?|spikes?|goes up)\\s+by\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '=' },
  { regex: new RegExp(`${SUBJECT}\\s+(?:drops?|decreases?|falls?)\\s+by\\s+(-?\\d+(?:\\.\\d+)?)`, 'gi'), operator: '=' },
];

const GUARD_PATTERN = /ignore\s+(?:it\s+|this\s+)?when\s+(?:the\s+)?([a-z][a-z\s]*?)\s+(?:is|=)\s*(on|off|true|false|active|inactive)\b/i;
const SCHEDULE_PATTERN = /every\s+(\d+)\s*(minutes|minute|hours|hour|days|day)/i;

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
      if (sensor) {
        found.push({ sensor, operator, value: m[2], pos: m.index });
      }
      working = working.slice(0, m.index) + ' '.repeat(m[0].length) + working.slice(m.index + m[0].length);
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const seen = new Set<string>();
  return found.filter((f) => {
    if (seen.has(f.sensor)) return false;
    seen.add(f.sensor);
    return true;
  });
}

function extractGuard(text: string): WorkflowGuard | undefined {
  const m = text.match(GUARD_PATTERN);
  if (!m) return undefined;
  return { field: cleanSubject(m[1]), value: m[2].toUpperCase() };
}

function extractActions(text: string, hasConditions: boolean): WorkflowActionType[] {
  const actions: WorkflowActionType[] = [];
  if (/webhook/i.test(text)) actions.push('Webhook');
  if (/\bemail\b/i.test(text)) actions.push('Email');
  if (/\bsms\b|text message/i.test(text)) actions.push('SMS');
  if (actions.length === 0 && hasConditions) actions.push('Webhook', 'Email');
  return actions;
}

function extractLogic(text: string, conditionCount: number): 'AND' | 'OR' {
  if (conditionCount <= 1) return 'AND';
  const lower = text.toLowerCase();
  const orIdx = lower.indexOf(' or ');
  const andIdx = lower.indexOf(' and ');
  if (orIdx !== -1 && (andIdx === -1 || orIdx < andIdx)) return 'OR';
  return 'AND';
}

export function parsePromptToWorkflow(prompt: string, name?: string): WorkflowSpec {
  const text = prompt.trim();
  const conditions = extractConditions(text);
  const schedMatch = text.match(SCHEDULE_PATTERN);

  return {
    name: name || `Workflow_draft-${Date.now()}`,
    scheduleLabel: schedMatch ? `Every ${schedMatch[1]} ${schedMatch[2]}` : 'Every 5 minutes',
    conditions: conditions.map(({ sensor, operator, value }) => ({ sensor, operator, value })),
    guard: extractGuard(text),
    logic: extractLogic(text, conditions.length),
    actions: extractActions(text, conditions.length > 0),
    sourcePrompt: text,
  };
}

// A prompt is "ready to build" once at least one concrete sensor/threshold
// pair was found — that's the signal the AI Assistant uses to decide the
// conversation is about a specific alert (navigate to Work Flow) rather
// than still being clarified (stay put, show the build checklist).
export function hasConcreteConditions(spec: WorkflowSpec): boolean {
  return spec.conditions.length > 0;
}

// Loose keyword check used only to decide whether the "Identifying Sensors"
// checklist step can be marked active while still in the clarifying phase.
const SENSOR_KEYWORDS = [
  'temperature', 'pressure', 'vibration', 'fuel', 'battery', 'voltage', 'engine',
  'speed', 'energy', 'level', 'humidity', 'oil', 'flow', 'current', 'torque',
];

export function mentionsSensorKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSOR_KEYWORDS.some((kw) => lower.includes(kw));
}
