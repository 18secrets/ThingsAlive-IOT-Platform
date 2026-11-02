/**
 * The arithmetic of the in-shift fuel nowcast (D52), with nothing else in it: no database,
 * no clock, no connection, as `shift-fuel-forecast.ts` is for D50.
 *
 * While a shift runs, its total is the litres already burned — which the existing
 * platform's fuel counter knows exactly — plus the pre-shift forecast's share of the hours
 * that are left. Nothing here guesses at the part already burned, and nothing here
 * extrapolates the last hour: the backtest D52 records scored that worse than the share.
 */
import { addDays, indiaDate, ShiftKey, shiftEnd, shiftStart } from './shift-fuel-forecast';

/** The nowcast's name on every row it writes. Change the arithmetic, change this. */
export const SHIFT_FUEL_NOWCAST_METHOD = 'so-far+ewma-0.5-28d-share';

/** D50's shifts are twelve hours; the share is of those. */
export const SHIFT_HOURS = 12;

/**
 * How far before the shift start a counter reading still counts as the counter at the
 * start. About ten readings at the usual 30 s; anything older could hide burn from the
 * end of the previous shift, and the first reading after the start is used instead.
 */
export const OPENING_LOOKBACK_MS = 5 * 60_000;

/**
 * A counter reading older than this is still used — it is the best figure there is — but
 * the pass counts it as stale, and `counter_at` beside the snapshot says how old it was.
 */
export const STALE_AFTER_MS = 30 * 60_000;

export const DEFAULT_NOWCAST_TICK_SECONDS = 900;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The shift under way at this instant: the one that has started and not yet ended. At
 * exactly 08:00 or 20:00 that is the one just starting, never the one just ended.
 */
export function runningShift(at: Date): ShiftKey {
  const today = indiaDate(at);
  const candidates: ShiftKey[] = [
    { sdate: addDays(today, -1), shift: 2 }, { sdate: today, shift: 1 }, { sdate: today, shift: 2 },
  ];
  const found = candidates.find((k) => shiftStart(k) <= at && at < shiftEnd(k));
  // Unreachable while the two shifts tile the day; a throw rather than a guess if they stop.
  if (!found) throw new Error(`No shift is running at ${at.toISOString()}.`);
  return found;
}

/**
 * The tick a pass writes for: `now` rounded down to a whole multiple of the tick. It is
 * what makes a snapshot idempotent — two passes in the same quarter hour both say 08:15,
 * and the unique key keeps the first — and it is also the instant the snapshot describes,
 * so the counter is read as of it, not as of whenever the timer happened to fire.
 */
export function tickFloor(now: Date, tickSeconds = DEFAULT_NOWCAST_TICK_SECONDS): Date {
  const ms = tickSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Litres burned since the shift started, from the counter at the start and the newest
 * reading since.
 *
 * Never negative. The counter only climbs while it is the same counter, so a fall means it
 * was reset or the device was replaced under the same series. Two readings cannot say
 * how much burned either side of that, and a negative burn would pull the forecast below
 * zero; so the shift is credited with none, and the forecast's share carries the rest.
 */
export function soFarLitres(opening: number, latest: number): number {
  return round2(Math.max(0, latest - opening));
}

export interface NowcastValue {
  soFarL: number;
  predictedL: number;
  hoursRemaining: number;
}

/**
 * The shift's total, as of `asOf`: so far, plus the base forecast's share of the hours left.
 *
 * The base is spread evenly over the shift because that is all it says — a total for twelve
 * hours, not a profile within them. Rounded to two places as the columns hold it, so the
 * value the API returns is the value the database stored.
 */
export function nowcastShift(
  { soFarL, baseL, asOf, key }: { soFarL: number; baseL: number; asOf: Date; key: ShiftKey },
): NowcastValue {
  const remainingMs = Math.min(Math.max(shiftEnd(key).getTime() - asOf.getTime(), 0), SHIFT_HOURS * 3_600_000);
  const hoursRemaining = remainingMs / 3_600_000;
  const so = round2(soFarL);
  return { soFarL: so, predictedL: round2(so + baseL * (hoursRemaining / SHIFT_HOURS)), hoursRemaining };
}

export interface CounterReading {
  at: Date;
  value: number;
}

export interface CounterSeries {
  seriesId: number;
  opening: CounterReading | null;
  latest: CounterReading | null;
}

/**
 * Which of a machine's fuel counters to read, when the existing platform maps more than one.
 *
 * The one that reported most recently, and only one. Two series on a machine are either a
 * device replaced — the old one went quiet — or two devices both reporting the same tank,
 * and adding them would double the second case every shift. Taking the live one loses the
 * part of a mid-shift swap burned before it, once; adding would be wrong every time.
 */
export function pickSeries(series: readonly CounterSeries[]): (CounterSeries & { opening: CounterReading; latest: CounterReading }) | null {
  const usable = series.filter((s): s is CounterSeries & { opening: CounterReading; latest: CounterReading } =>
    s.opening !== null && s.latest !== null && Number.isFinite(s.opening.value) && Number.isFinite(s.latest.value));
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => (b.latest.at.getTime() - a.latest.at.getTime()) || (a.seriesId - b.seriesId))[0];
}
