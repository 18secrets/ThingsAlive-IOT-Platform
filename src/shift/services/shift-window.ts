/**
 * Shift arithmetic, in one place and without a date library (task P1-109).
 *
 * Scoring is not per reading. A prediction is worth making once a shift's worth of
 * telemetry exists, which means the whole runtime hangs off the question "which shift
 * just ended, and what window of time was it". That question has three ways to be
 * quietly wrong, and all three are here rather than scattered through a service:
 *
 *  - A night shift crosses midnight, so its window is not "a day".
 *  - Shift hours are wall-clock in the plant's own timezone, and an offset stored as a
 *    number is wrong twice a year for anybody observing daylight saving.
 *  - On the two days a year the clock moves, a wall time can not exist at all or exist
 *    twice, and picking silently is how an eight-hour shift becomes a seven-hour one.
 *
 * Node's ICU carries the full timezone database, so the rules are read from there
 * rather than approximated. No dependency, and no offsets frozen into the schema.
 */

/** 0 is Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

export interface ShiftDefinition {
  /** Minutes from local midnight, 0..1439. */
  startMinute: number;
  /**
   * Minutes from local midnight, 1..1440.
   *
   * An end at or before the start means the shift runs past midnight: 22:00 to 06:00
   * is `startMinute` 1320 and `endMinute` 360. 1440 is midnight at the far end, which
   * is a different thing from 0 and is why the range starts at 1.
   */
  endMinute: number;
  /**
   * The days the shift *starts* on.
   *
   * A shift belongs to the day it begins, so the night shift that runs from Friday
   * 22:00 into Saturday morning is a Friday shift. Any other convention makes "did
   * the Friday night shift run" unanswerable without knowing the hours.
   */
  days: readonly Weekday[];
  /** IANA name, e.g. 'Asia/Kolkata'. Not an offset. */
  timeZone: string;
}

export interface ShiftWindow {
  /** The instant the shift began. */
  start: Date;
  /** The instant it ended. Exclusive: a reading at exactly `end` belongs to the next. */
  end: Date;
  /** The local calendar date it started on, as YYYY-MM-DD. What people call it. */
  localDate: string;
}

/**
 * A zone we are prepared to compute against.
 *
 * Not `Intl.supportedValuesOf`, which lists only canonical names: it rejects
 * `Asia/Kolkata` in favour of `Asia/Calcutta`, and Kolkata is exactly what an Indian
 * customer will enter. Constructibility accepts both, but on its own it also accepts
 * bare abbreviations like `IST` — which Node resolves, and which mean India, Ireland
 * or Israel depending on who is reading. A region/city name or UTC, nothing else.
 */
export function isValidTimeZone(zone: string): boolean {
  if (zone === 'UTC') return true;
  if (!zone.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = PARTS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    PARTS.set(zone, f);
  }
  return f;
}

interface LocalParts {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}

/** What the clock in `zone` reads at this instant. */
export function localPartsAt(zone: string, at: Date): LocalParts {
  const parts = formatter(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  // Midnight formats as hour 24 in some engines; 24:00 today is 00:00 today.
  const hour = get('hour') % 24;
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour, minute: get('minute'), second: get('second'),
  };
}

/** The zone's offset from UTC at a given instant, in minutes. */
function offsetMinutesAt(zone: string, at: Date): number {
  const p = localPartsAt(zone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * A wall-clock time in a zone, as an instant.
 *
 * Converting the other way is a lookup; this way is not, because the offset to apply
 * depends on the answer. So both candidate offsets are taken — the one in force a day
 * earlier and the one in force a day later — and each is tested by converting back and
 * asking whether the clock really reads what was asked for. On an ordinary day they
 * agree and there is one answer.
 *
 * The two days a year they disagree are decided here rather than left to chance:
 *
 *  - The hour happens twice, in autumn. Both candidates read correctly, and the first
 *    is taken: the shift is the longer one, because the people were there for both.
 *  - The hour never happens, in spring. Neither reads correctly, and the later is
 *    taken, which moves the whole shift forward by the gap and keeps its wall-clock
 *    length — so it still meets the shifts on either side instead of opening an
 *    hour-wide hole or overlapping into one of them.
 *
 * Neither choice is more true than the other. What matters is that one is made, in one
 * place, so a shift that ends at 01:30 and the shift that starts at 01:30 resolve to
 * the same instant.
 */
export function zonedWallToUtc(
  zone: string, year: number, month: number, day: number, minutesFromMidnight: number,
): Date {
  const dayCarry = Math.floor(minutesFromMidnight / MINUTES_PER_DAY);
  const within = minutesFromMidnight - dayCarry * MINUTES_PER_DAY;
  const hour = Math.floor(within / 60);
  const minute = within % 60;

  const naive = Date.UTC(year, month - 1, day + dayCarry, hour, minute);
  // The offsets in force on either side of this moment. They are the same number on
  // every ordinary day, and different on the two days a year that matter.
  const before = naive - offsetMinutesAt(zone, new Date(naive - MINUTES_PER_DAY * 60_000)) * 60_000;
  const after = naive - offsetMinutesAt(zone, new Date(naive + MINUTES_PER_DAY * 60_000)) * 60_000;

  const valid = [before, after].filter((t) => readsAs(zone, new Date(t), hour, minute));
  // Two valid answers means the hour is being repeated. Take the first: the shift is
  // the longer one, because the people were there for both.
  if (valid.length) return new Date(Math.min(...valid));
  // None means the hour never happened. Take the later, which shifts the whole shift
  // forward by the gap and keeps its wall-clock length — so it still meets the shift
  // on either side of it instead of opening an hour-wide hole or an overlap.
  return new Date(Math.max(before, after));
}

function readsAs(zone: string, at: Date, hour: number, minute: number): boolean {
  const p = localPartsAt(zone, at);
  return p.hour === hour && p.minute === minute;
}

/** YYYY-MM-DD as the clock in `zone` reads it. */
export function localDateIn(zone: string, at: Date): string {
  const p = localPartsAt(zone, at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isOvernight(shift: Pick<ShiftDefinition, 'startMinute' | 'endMinute'>): boolean {
  return shift.endMinute <= shift.startMinute;
}

/** The window for the instance of this shift that starts on a given local date. */
export function windowForLocalDate(shift: ShiftDefinition, localDate: string): ShiftWindow {
  const [year, month, day] = localDate.split('-').map(Number);
  const start = zonedWallToUtc(shift.timeZone, year, month, day, shift.startMinute);
  const endMinutes = isOvernight(shift)
    ? shift.endMinute + MINUTES_PER_DAY
    : shift.endMinute;
  const end = zonedWallToUtc(shift.timeZone, year, month, day, endMinutes);
  return { start, end, localDate };
}

/**
 * Every instance of this shift that finished in `(after, upTo]`.
 *
 * The half-open interval is what makes a scheduler safe to run repeatedly: pass the
 * last run's timestamp as `after` and a shift is returned exactly once, however often
 * the check fires or however late it is. Returned oldest first, so a service that has
 * been down for two days catches up in order rather than scoring the newest and
 * silently abandoning the rest.
 */
export function windowsEndingBetween(
  shift: ShiftDefinition, after: Date, upTo: Date,
): ShiftWindow[] {
  if (shift.days.length === 0 || upTo <= after) return [];

  const out: ShiftWindow[] = [];
  const seen = new Set<string>();
  // Start a couple of days early: an overnight shift that ended inside the interval
  // began the day before, and the local date can be a day either side of the UTC one.
  const lookBackDays = isOvernight(shift) ? 3 : 2;
  const from = after.getTime() - lookBackDays * MINUTES_PER_DAY * 60_000;
  const days = Math.ceil((upTo.getTime() - from) / (MINUTES_PER_DAY * 60_000)) + 1;

  for (let i = 0; i <= days; i += 1) {
    const at = new Date(from + i * MINUTES_PER_DAY * 60_000);
    const localDate = localDateIn(shift.timeZone, at);
    if (seen.has(localDate)) continue;
    seen.add(localDate);

    const [y, m, d] = localDate.split('-').map(Number);
    // Which weekday the *local* date falls on, independent of the reader's clock.
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
    if (!shift.days.includes(weekday)) continue;

    const window = windowForLocalDate(shift, localDate);
    if (window.end.getTime() > after.getTime() && window.end.getTime() <= upTo.getTime()) {
      out.push(window);
    }
  }
  return out.sort((a, b) => a.end.getTime() - b.end.getTime());
}

/**
 * Minute-of-week intervals this shift occupies, for overlap checking.
 *
 * A shift crossing midnight also crosses the week boundary on its last day, so an
 * interval can wrap. Splitting it here means the caller compares plain ranges.
 */
export function weeklyIntervals(shift: ShiftDefinition): [number, number][] {
  const length = isOvernight(shift)
    ? shift.endMinute + MINUTES_PER_DAY - shift.startMinute
    : shift.endMinute - shift.startMinute;

  const out: [number, number][] = [];
  for (const day of shift.days) {
    const from = day * MINUTES_PER_DAY + shift.startMinute;
    const to = from + length;
    if (to <= MINUTES_PER_WEEK) out.push([from, to]);
    else {
      out.push([from, MINUTES_PER_WEEK]);
      out.push([0, to - MINUTES_PER_WEEK]);
    }
  }
  return out;
}

/** Do two shifts ever cover the same minute of the same weekday? */
export function shiftsOverlap(a: ShiftDefinition, b: ShiftDefinition): boolean {
  const left = weeklyIntervals(a);
  const right = weeklyIntervals(b);
  return left.some(([s1, e1]) => right.some(([s2, e2]) => s1 < e2 && s2 < e1));
}

/** Minutes a single instance of this shift covers. Ignores clock changes. */
export function nominalLengthMinutes(shift: ShiftDefinition): number {
  return isOvernight(shift)
    ? shift.endMinute + MINUTES_PER_DAY - shift.startMinute
    : shift.endMinute - shift.startMinute;
}
