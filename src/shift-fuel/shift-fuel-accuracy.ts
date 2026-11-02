/**
 * How close the shift fuel forecast (D50) and the in-shift nowcast (D52) came to what the
 * existing platform says was burned (D53), with nothing else in it: no database, no clock,
 * no connection, as `shift-fuel-forecast.ts` is for D50. The page that shows these numbers
 * replaced a hand-refreshed dashboard; a definition that lived in two places would drift
 * the first time either was touched, so it lives here once and the spec holds it to exact
 * values.
 */
import { addDays, indiaDate, shiftEnd, ShiftNo } from './shift-fuel-forecast';

/** What one miss is counted over: each machine-shift, each day, or the whole range at once. */
export type MissLevel = 'day' | 'shift' | 'range';
export const MISS_LEVELS: readonly MissLevel[] = ['day', 'shift', 'range'];

/** Hours into a shift at which the nowcast is scored — the points D52's backtest reported. */
export type Checkpoint = 2 | 4 | 6;
export const CHECKPOINTS: readonly Checkpoint[] = [2, 4, 6];
export type PerCheckpoint<T> = Record<Checkpoint, T>;

/**
 * About a quarter. Long enough to read a season's drift, short enough that a request reads
 * at most ~92 days × 2 shifts × the fleet — tens of thousands of rows, not a year of them.
 */
export const MAX_RANGE_DAYS = 92;

/** One completed-or-not shift of one machine that the existing platform has a figure for. */
export interface ShiftOutcome {
  sourceSystem: string;
  externalId: string;
  sdate: string;
  shift: ShiftNo;
  /** `legacy_shift_metric.fuel_l`. A row with no figure is not an outcome, and never arrives here. */
  actualL: number;
  /** The D50 forecast issued for this shift, or null when none was. */
  forecastL: number | null;
  /** The newest D52 snapshot at or before each checkpoint, or null when there was none by then. */
  checkpointL: PerCheckpoint<number | null>;
}

export interface MachineAccuracy {
  sourceSystem: string;
  externalId: string;
  /** Every completed shift's actual litres, scored or not. */
  actualL: number;
  /** The forecast litres of the shifts that were scored: those with a forecast. */
  forecastL: number;
  /** Null when the scored shifts burned nothing: a percentage of zero says nothing. */
  accuracy: number | null;
  checkpoints: PerCheckpoint<number | null>;
  /** Completed shifts with an actual figure. */
  shifts: number;
  /** Of those, the ones that burned anything. */
  ranShifts: number;
  shiftsWithoutForecast: number;
  shiftsWithoutCheckpoint: PerCheckpoint<number>;
}

export interface FleetAccuracy {
  /** Machines that burned fuel in the range; only these are in the fleet's totals. */
  machines: number;
  actualL: number;
  forecastL: number;
  accuracy: number | null;
  checkpoints: PerCheckpoint<number | null>;
  shiftsWithoutForecast: number;
  shiftsWithoutCheckpoint: PerCheckpoint<number>;
}

/**
 * The score: 100 less the miss as a percentage of what was actually burned, never below
 * zero. Rounded once, at the end, so two ways of summing the same litres cannot disagree
 * by a point. Null with nothing burned — any forecast over zero litres is "infinitely"
 * wrong, and showing 0% for a machine that sat idle would read as a bad forecast.
 */
export function accuracyPct(miss: number, actualTotal: number): number | null {
  if (!(actualTotal > 0)) return null;
  return Math.max(0, 100 - Math.round((100 * miss) / actualTotal));
}

/** Only a shift that has ended has a total to score against; one still running is a guess on both sides. */
export function isCompleted(s: { sdate: string; shift: ShiftNo }, now: Date): boolean {
  return shiftEnd(s).getTime() <= now.getTime();
}

/**
 * Litres in hundredths, as the columns hold them. Summing them as integers keeps a range
 * of 0.1s from landing at 99.99999 and rounding to the other side of a point.
 */
const cl = (litres: number): number => Math.round(litres * 100);
const litres = (centilitres: number): number => centilitres / 100;

interface Pair {
  group: string;
  predicted: number;
  actual: number;
}

/**
 * The miss: within each group, the forecast's total against the actual's, and the size of
 * that difference summed over the groups. A group's over- and under-forecast shifts cancel
 * inside it and never across groups — which is the whole difference between the levels.
 */
function score(pairs: readonly Pair[]): { predicted: number; actual: number; accuracy: number | null } {
  const diff = new Map<string, number>();
  let predicted = 0;
  let actual = 0;
  for (const p of pairs) {
    diff.set(p.group, (diff.get(p.group) ?? 0) + p.predicted - p.actual);
    predicted += p.predicted;
    actual += p.actual;
  }
  let miss = 0;
  for (const d of diff.values()) miss += Math.abs(d);
  return { predicted, actual, accuracy: accuracyPct(miss, actual) };
}

const machineKey = (s: { sourceSystem: string; externalId: string }) => `${s.sourceSystem}|${s.externalId}`;

/** A machine's own groups: its shifts, its days, or its whole range. */
const MACHINE_GROUP: Record<MissLevel, (s: ShiftOutcome) => string> = {
  shift: (s) => `${s.sdate}|${s.shift}`,
  day: (s) => s.sdate,
  range: () => '',
};

/**
 * The fleet's groups. Per shift it is still each machine's shift — one machine's miss is
 * not cancelled by another's. Per day and per range it is the fleet's own totals, because
 * that is the question a fleet figure answers: how much fuel the site needed that day.
 */
const FLEET_GROUP: Record<MissLevel, (s: ShiftOutcome) => string> = {
  shift: (s) => `${machineKey(s)}|${s.sdate}|${s.shift}`,
  day: (s) => s.sdate,
  range: () => '',
};

const perCheckpoint = <T>(f: (h: Checkpoint) => T): PerCheckpoint<T> => ({ 2: f(2), 4: f(4), 6: f(6) });

interface Scored {
  actualL: number;
  forecastL: number;
  accuracy: number | null;
  checkpoints: PerCheckpoint<number | null>;
  shiftsWithoutForecast: number;
  shiftsWithoutCheckpoint: PerCheckpoint<number>;
}

/**
 * One set of shifts scored at one level. A shift with no forecast is left out of the
 * forecast's score — its litres out of the miss and out of the actual it is divided by —
 * and counted, never scored as a forecast of zero: a forecast that was never issued did
 * not predict that nothing would burn. Each checkpoint is left out shift by shift the
 * same way, so the three can be scored over different shifts, and each count says by how many.
 */
function scoreSet(shifts: readonly ShiftOutcome[], group: (s: ShiftOutcome) => string): Scored {
  const forecast = score(shifts.filter((s) => s.forecastL !== null)
    .map((s) => ({ group: group(s), predicted: cl(s.forecastL as number), actual: cl(s.actualL) })));
  return {
    actualL: litres(shifts.reduce((sum, s) => sum + cl(s.actualL), 0)),
    forecastL: litres(forecast.predicted),
    accuracy: forecast.accuracy,
    checkpoints: perCheckpoint((h) => score(shifts.filter((s) => s.checkpointL[h] !== null)
      .map((s) => ({ group: group(s), predicted: cl(s.checkpointL[h] as number), actual: cl(s.actualL) }))).accuracy),
    shiftsWithoutForecast: shifts.filter((s) => s.forecastL === null).length,
    shiftsWithoutCheckpoint: perCheckpoint((h) => shifts.filter((s) => s.checkpointL[h] === null).length),
  };
}

/**
 * Every machine's score and the fleet's, over the completed shifts among `outcomes`.
 *
 * The fleet is the machines that burned anything in the range. A machine that sat idle
 * all range is still in the table, saying so, but adding its forecast to the fleet's would
 * charge the forecast for a machine nobody ran — a decision about the site, not about fuel.
 * A machine that ran is in it whole, its forecast litres for its idle shifts included.
 *
 * Machines come back best first, the idle ones last, as the page first shows them.
 */
export function scoreAccuracy(
  outcomes: readonly ShiftOutcome[], level: MissLevel, now: Date,
): { fleet: FleetAccuracy; machines: MachineAccuracy[] } {
  const completed = outcomes.filter((s) => isCompleted(s, now));
  const byMachine = new Map<string, ShiftOutcome[]>();
  for (const s of completed) {
    const list = byMachine.get(machineKey(s));
    if (list) list.push(s);
    else byMachine.set(machineKey(s), [s]);
  }

  const machines: MachineAccuracy[] = [...byMachine.values()].map((shifts) => ({
    sourceSystem: shifts[0].sourceSystem,
    externalId: shifts[0].externalId,
    ...scoreSet(shifts, MACHINE_GROUP[level]),
    shifts: shifts.length,
    ranShifts: shifts.filter((s) => s.actualL > 0).length,
  }));
  machines.sort((a, b) => {
    if (a.accuracy !== b.accuracy) {
      if (a.accuracy === null) return 1;
      if (b.accuracy === null) return -1;
      return b.accuracy - a.accuracy;
    }
    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : a.sourceSystem < b.sourceSystem ? -1 : 1;
  });

  const ran = new Set(machines.filter((m) => m.actualL > 0).map(machineKey));
  const fleet = scoreSet(completed.filter((s) => ran.has(machineKey(s))), FLEET_GROUP[level]);
  return { fleet: { machines: ran.size, ...fleet }, machines };
}

export interface AccuracyQuery {
  from: string;
  to: string;
  level: MissLevel;
}

/** A query the endpoint refuses, and why, in words the caller can act on. */
export class AccuracyQueryError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(raw: string | undefined, field: string, today: string): string {
  if (raw === undefined || raw === '') return today;
  // The round trip refuses 2026-02-30, which Date would quietly roll into March; a month
  // of 13 is no date at all, and would throw from inside the round trip.
  if (!ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) || addDays(raw, 0) !== raw) {
    throw new AccuracyQueryError(`${field} must be a date as YYYY-MM-DD, not "${raw}".`);
  }
  return raw;
}

/**
 * The page's filters, checked. Either date left out is today in India, the calendar the
 * shifts are dated by. Both ends are inclusive and a shift is in by its `sdate`, so a
 * night shift belongs to the day it started, as the existing platform files it.
 */
export function parseAccuracyQuery(
  raw: { from?: string; to?: string; level?: string }, now: Date,
): AccuracyQuery {
  const today = indiaDate(now);
  const from = parseDay(raw.from, 'from', today);
  const to = parseDay(raw.to, 'to', today);
  if (from > to) throw new AccuracyQueryError(`from (${from}) must not be after to (${to}).`);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new AccuracyQueryError(`The range is ${days} days; at most ${MAX_RANGE_DAYS} can be asked for at once.`);
  }
  const level = raw.level === undefined || raw.level === '' ? 'day' : raw.level;
  if (!(MISS_LEVELS as readonly string[]).includes(level)) {
    throw new AccuracyQueryError(`level must be one of ${MISS_LEVELS.join(', ')}, not "${level}".`);
  }
  return { from, to, level: level as MissLevel };
}
