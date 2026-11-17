import { AlertEvent } from '../alert/entities/alert-event.entity';

/**
 * The alert, as a sentence Vani can say on the phone.
 *
 * The rule engine writes its summary for a screen and for an engineer: "vibration_velocity
 * breached 4.5 mm/s above on 10 of the last 10 readings; worst was 5.25 mm/s". Read
 * aloud by text-to-speech, that is a signal key spelled out with underscores and a unit
 * pronounced letter by letter. The engine's summary stays as it is — the console and
 * every alert already raised depend on it — and this composes the spoken form from the
 * alert's evidence, which carries the same facts as numbers rather than prose.
 *
 * Nothing here adds a fact. Every word is either the evidence or the machine's
 * registered spoken name; where the evidence is not the shape this understands, the
 * engine's own summary is used with its codes made pronounceable, never paraphrased.
 */
export function speakableSummary(alert: Pick<AlertEvent, 'summary' | 'evidence'>, machineName: string): string {
  const e = alert.evidence ?? {};
  if (isThreshold(e)) {
    const unit = spokenUnit(e.unit);
    const quantity = (v: number) => `${spokenNumber(v)}${unit ? ` ${unit}` : ''}`;
    const howMany = e.breaches === e.readingsInWindow
      ? `on all of the last ${e.readingsInWindow} readings`
      : `on ${e.breaches} of the last ${e.readingsInWindow} readings`;
    return `${capitalise(spokenSignal(e.signal))} on ${machineName} has been ${e.direction} `
      + `${quantity(e.bound)} ${howMany}, reaching ${quantity(e.worstValue)}.`;
  }
  return pronounceable(alert.summary);
}

interface ThresholdEvidence {
  signal: string;
  unit: string | null;
  direction: 'above' | 'below';
  bound: number;
  worstValue: number;
  breaches: number;
  readingsInWindow: number;
}

function isThreshold(e: Record<string, unknown>): e is Record<string, unknown> & ThresholdEvidence {
  return typeof e.signal === 'string'
    && (e.direction === 'above' || e.direction === 'below')
    && [e.bound, e.worstValue, e.breaches, e.readingsInWindow].every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * How a unit is said. A unit not listed here is left out of the sentence rather than
 * read letter by letter: "5.25" alone is less precise than "5.25 millimeters per
 * second", but "5.25 em em slash ess" is worse than either.
 */
const UNITS: Record<string, string> = {
  'mm/s': 'millimeters per second',
  'degc': 'degrees Celsius',
  '°c': 'degrees Celsius',
  'c': 'degrees Celsius',
  'degf': 'degrees Fahrenheit',
  '°f': 'degrees Fahrenheit',
  'percent': 'percent',
  '%': 'percent',
  'rpm': 'r p m',
  'kpa': 'kilopascals',
  'bar': 'bar',
  'psi': 'p s i',
  'v': 'volts',
  'a': 'amps',
  'kw': 'kilowatts',
  'kva': 'k v a',
  'hz': 'hertz',
  'l': 'liters',
  'l/h': 'liters per hour',
  'h': 'hours',
  's': 'seconds',
  'min': 'minutes',
};

export function spokenUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return UNITS[unit.trim().toLowerCase()] ?? null;
}

/** Signal keys whose words alone would be misread. Anything else is its own words. */
const SIGNALS: Record<string, string> = {
  engine_rpm: 'engine speed',
  vibration_velocity: 'bearing vibration',
};

export function spokenSignal(signal: string): string {
  return SIGNALS[signal] ?? signal.replace(/_/g, ' ').trim();
}

/** Two decimals at most, and no trailing zeros: "4.5", not "4.50". */
export function spokenNumber(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** The engine's own words, with snake_case keys turned into words. Nothing else changes. */
export function pronounceable(text: string): string {
  return text.replace(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g, (key) => spokenSignal(key));
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
