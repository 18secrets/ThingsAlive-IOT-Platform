/**
 * The arithmetic of the shift fuel forecast (D50), with nothing else in it: no database,
 * no clock, no connection. Everything the service decides about a number happens here, so
 * the spec can hold it to exact values.
 */

/**
 * The existing platform's shift boundaries: SHIFT_1_IN and SHIFT_2_IN in itdc_backend's
 * `late-data-shift-resync.service.ts`. Shift 1 runs 08:00–20:00 on
 * its date; shift 2 runs 20:00 on its date to 08:00 the next morning. Its rows are keyed
 * by those, so 2.0 has to use the same ones or a row describes a different twelve hours
 * than the forecast beside it.
 *
 * A fixed offset rather than a zone lookup because Asia/Kolkata has no daylight saving;
 * the migration's generated `starts_at` and `ends_at` say the same in SQL, and the spec
 * fails if the two drift apart.
 */
export const SHIFT_1_IN = '08:00';
export const SHIFT_2_IN = '20:00';
export const SHIFT_UTC_OFFSET = '+05:30';
const SHIFT_MS = 12 * 3_600_000;

export type ShiftNo = 1 | 2;
export interface ShiftKey {
  /** The existing platform's `sdate`: the calendar day the shift starts on, in India. */
  sdate: string;
  shift: ShiftNo;
}

/** The forecast's name on every row it writes. Change the arithmetic, change this. */
export const SHIFT_FUEL_METHOD = 'ewma-0.5-28d';
export const EWMA_ALPHA = 0.5;
/** How far back a forecast looks: the 28 days before the shift's own date. */
export const HISTORY_DAYS = 28;
/** Shifts forecast ahead of the newest synced row. */
export const FORECAST_AHEAD = 2;

export function shiftStart(key: ShiftKey): Date {
  return new Date(`${key.sdate}T${key.shift === 1 ? SHIFT_1_IN : SHIFT_2_IN}:00${SHIFT_UTC_OFFSET}`);
}

export function shiftEnd(key: ShiftKey): Date {
  return new Date(shiftStart(key).getTime() + SHIFT_MS);
}

export function addDays(sdate: string, days: number): string {
  const d = new Date(`${sdate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The calendar day in India at this instant. */
export function indiaDate(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function nextShift(key: ShiftKey): ShiftKey {
  return key.shift === 1 ? { sdate: key.sdate, shift: 2 } : { sdate: addDays(key.sdate, 1), shift: 1 };
}

export function compareShifts(a: ShiftKey, b: ShiftKey): number {
  return a.sdate === b.sdate ? a.shift - b.shift : (a.sdate < b.sdate ? -1 : 1);
}

/**
 * Which shifts to forecast, given the newest one the existing platform has a row for.
 *
 * The shifts after it that have not yet ended, the first `count` of them. After the
 * morning sync — newest row yesterday's night shift — that is today's two shifts.
 *
 * Not-yet-ended rather than not-yet-started, because the existing platform totals a shift
 * only after it ends: when last night's row lands, this morning's shift is already under
 * way, and refusing to forecast it would mean never forecasting a day shift at all. It is
 * still a forecast — nothing about today is in its inputs — and the database refuses one
 * issued after its shift ended (`ck_shift_fuel_forecast_in_time`).
 *
 * A machine whose rows stopped days ago skips straight to the shift under way now, so a
 * stalled feed produces current forecasts from old inputs, which `inputs_through` shows,
 * rather than a backlog of forecasts for shifts that are already over.
 */
export function targetShifts(newest: ShiftKey, now: Date, count = FORECAST_AHEAD): ShiftKey[] {
  // The shift before the one under way now; nothing at or before it can be a target.
  const today = indiaDate(now);
  let floor: ShiftKey = { sdate: addDays(today, -1), shift: 1 };
  while (shiftEnd(nextShift(floor)) <= now) floor = nextShift(floor);

  let cursor = compareShifts(newest, floor) < 0 ? floor : newest;
  const out: ShiftKey[] = [];
  while (out.length < count) {
    cursor = nextShift(cursor);
    if (shiftEnd(cursor) > now) out.push(cursor);
  }
  return out;
}

/**
 * Exponentially weighted moving average, oldest first: the first value seeds it and each
 * later one moves it `alpha` of the way. With alpha 0.5 yesterday's shift counts for half,
 * the one before for a quarter, and so on — recent enough to follow a machine moved to
 * harder work, smooth enough that one idle shift does not halve the next forecast.
 *
 * Empty history is 0: no evidence of burn is forecast as none, and `inputs_through` null
 * beside it says that is what happened.
 */
export function ewma(values: readonly number[], alpha = EWMA_ALPHA): number {
  if (values.length === 0) return 0;
  let level = values[0];
  for (let i = 1; i < values.length; i += 1) level = alpha * values[i] + (1 - alpha) * level;
  return level;
}

export interface ShiftObservation {
  sdate: string;
  shift: ShiftNo;
  /** Litres; null when the existing platform has a row and no figure. */
  fuelL: number | null;
}

export interface ShiftFuelForecastValue {
  predictedL: number;
  /** The newest day the forecast used, or null when it used none. */
  inputsThrough: string | null;
}

/**
 * The forecast for one shift from one machine's history.
 *
 * Same shift only: a night shift on these sites is a different job from a day shift, and
 * averaging the two forecasts a shift nobody works. The window is the 28 days before the
 * target's own date, and a day with no row — or a row with no figure — is skipped rather
 * than counted as zero: a missing row is the existing platform not knowing, and a zero
 * would drag the forecast down every time its feed hiccups.
 */
export function forecastShift(
  history: readonly ShiftObservation[], target: ShiftKey,
  { alpha = EWMA_ALPHA, days = HISTORY_DAYS }: { alpha?: number; days?: number } = {},
): ShiftFuelForecastValue {
  const from = addDays(target.sdate, -days);
  const used = history
    .filter((h) => h.shift === target.shift && h.sdate >= from && h.sdate < target.sdate)
    .filter((h): h is ShiftObservation & { fuelL: number } => h.fuelL !== null && Number.isFinite(h.fuelL))
    .sort((a, b) => (a.sdate < b.sdate ? -1 : a.sdate > b.sdate ? 1 : 0));
  return {
    // Two places, as the column holds it: rounding here keeps the value the API returns
    // identical to the value the database stored.
    predictedL: Math.round(ewma(used.map((h) => h.fuelL), alpha) * 100) / 100,
    inputsThrough: used.length ? used[used.length - 1].sdate : null,
  };
}
