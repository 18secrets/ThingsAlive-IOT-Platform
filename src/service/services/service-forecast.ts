import { RuntimeUnit, meterToHours } from './runtime-unit';

/**
 * When this machine is next due a service, and whether it is already late (task P4-07).
 *
 * Third in the use-case map's build order, and the one that turns hours into a date
 * somebody can put in a diary. Three inputs, each of which can be missing, and the
 * design is mostly about saying which one is missing rather than producing a number
 * regardless:
 *
 *   - an interval, in hours, for this machine or its class;
 *   - a datum: the moment the meter was last known to be at a service point;
 *   - a rate: how fast this machine accumulates engine hours.
 *
 * A forecast with a missing input is not a worse forecast, it is a different kind of
 * statement, and a screen that cannot tell "due in nine days" from "we have never
 * been told this machine's service interval" will show the second as the first.
 */

/** Inside this many hours of the interval, somebody should be ordering parts. */
export const APPROACHING_HOURS = 50;

/**
 * A rate measured over fewer days than this is not a rate.
 *
 * A machine that happened to run flat out for two days would be forecast to reach its
 * interval in a fortnight, and the work order raised off the back of it would arrive
 * months early — which is the kind of wrong that teaches people to ignore the feature.
 */
export const MIN_RATE_DAYS = 7;

export type ServiceStatus = 'overdue' | 'due' | 'approaching' | 'ok';

/** Where the "hours at last service" figure came from. Both are legitimate; they are
 * not equally strong, and a screen should be able to say which it is looking at. */
export type Datum = 'service-record' | 'commissioning';

export interface IntervalSource {
  /** Hours set on this specific machine, which always wins. */
  equipmentHours: number | null;
  /** The default for its class, used when the machine has none of its own. */
  classHours?: number | null;
  classSlug?: string | null;
}

export interface ResolvedInterval {
  hours: number | null;
  source: 'equipment' | 'class' | null;
  classSlug?: string | null;
}

/**
 * The machine's own interval beats its class's.
 *
 * Not a fallback chain for tidiness: a class default is a statement about a kind of
 * machine and the equipment value is a statement about this one, usually because
 * somebody looked at its manual or its duty. The specific fact must win, or setting it
 * would have no effect and nobody would be able to say why.
 */
export function resolveInterval(source: IntervalSource): ResolvedInterval {
  if (source.equipmentHours !== null && source.equipmentHours > 0) {
    return { hours: source.equipmentHours, source: 'equipment', classSlug: source.classSlug ?? null };
  }
  if (source.classHours !== null && source.classHours !== undefined && source.classHours > 0) {
    return { hours: source.classHours, source: 'class', classSlug: source.classSlug ?? null };
  }
  return { hours: null, source: null, classSlug: source.classSlug ?? null };
}

export interface ForecastInput {
  /** The interval to work against, already resolved. */
  interval: ResolvedInterval;
  /** The meter as it reads now, raw, plus the unit the calibration decided on. */
  meterReading: number | null;
  meterUnit: RuntimeUnit | null;
  /** The meter reading at the last service, raw and in the same unit. */
  meterAtDatum: number | null;
  datum: Datum | null;
  datumAt: Date | null;
  /** Engine-on seconds observed over the rate window, and the days it spanned. */
  engineOnSeconds: number;
  rateDays: number;
  now: Date;
}

export interface Forecast {
  status: ServiceStatus | null;
  intervalHours: number | null;
  intervalSource: 'equipment' | 'class' | null;
  /** Hours run since the datum, converted. */
  hoursSinceDatum: number | null;
  hoursRemaining: number | null;
  /** Engine hours per calendar day, from observed time only. */
  hoursPerDay: number | null;
  /** The date the interval is reached at the current rate. */
  dueAt: Date | null;
  daysRemaining: number | null;
  datum: Datum | null;
  /**
   * Why the forecast is incomplete, most blocking first. A machine can be missing
   * several of these at once and only the first is worth telling anybody.
   */
  missing: ('interval' | 'meter-unit' | 'meter-reading' | 'datum' | 'rate')[];
}

const HOURS_PER_DAY_MS = 3600 * 1000;

export function forecastService(input: ForecastInput): Forecast {
  const missing: Forecast['missing'] = [];
  const { interval } = input;

  if (interval.hours === null) missing.push('interval');
  if (input.meterUnit === null) missing.push('meter-unit');
  if (input.meterReading === null) missing.push('meter-reading');
  if (input.meterAtDatum === null || input.datum === null) missing.push('datum');

  const base: Forecast = {
    status: null,
    intervalHours: interval.hours,
    intervalSource: interval.source,
    hoursSinceDatum: null,
    hoursRemaining: null,
    hoursPerDay: null,
    dueAt: null,
    daysRemaining: null,
    datum: input.datum,
    missing,
  };

  // The rate is computed whether or not the rest is available: "this machine runs
  // 6.2 hours a day" is worth showing on its own, and it is the number somebody uses
  // to sanity-check an interval before setting one.
  const hoursPerDay = input.rateDays >= MIN_RATE_DAYS && input.rateDays > 0
    ? round(input.engineOnSeconds / 3600 / input.rateDays)
    : null;
  if (hoursPerDay === null) missing.push('rate');
  base.hoursPerDay = hoursPerDay;

  if (
    interval.hours === null || input.meterUnit === null
    || input.meterReading === null || input.meterAtDatum === null
  ) {
    return base;
  }

  const rawSince = input.meterReading - input.meterAtDatum;
  if (rawSince < 0) {
    // The meter reads below the last service. A replaced logger or a transcription
    // error, and either way this machine's hours cannot be counted from here — the
    // alternative is reporting negative hours run, which nothing downstream expects.
    return { ...base, missing: [...base.missing, 'datum'] };
  }

  const hoursSinceDatum = round(meterToHours(rawSince, input.meterUnit));
  const hoursRemaining = round(interval.hours - hoursSinceDatum);

  // Status does not need the rate. A machine already past its interval is overdue
  // whether or not anybody knows how fast it runs, and withholding that until a rate
  // exists would hide the most urgent case behind the least available input.
  const status: ServiceStatus = hoursRemaining <= 0 ? 'overdue'
    : hoursRemaining <= APPROACHING_HOURS ? 'due'
    : hoursRemaining <= APPROACHING_HOURS * 4 ? 'approaching'
    : 'ok';

  let dueAt: Date | null = null;
  let daysRemaining: number | null = null;
  if (hoursPerDay !== null && hoursPerDay > 0 && hoursRemaining > 0) {
    daysRemaining = round(hoursRemaining / hoursPerDay);
    dueAt = new Date(input.now.getTime() + daysRemaining * 24 * HOURS_PER_DAY_MS);
  } else if (hoursPerDay !== null && hoursRemaining <= 0) {
    // Already past it: the date is not in the future and saying so is the point.
    daysRemaining = 0;
    dueAt = input.now;
  }
  // A machine sitting idle has a rate of zero and will never reach its interval. No
  // date is the honest answer; extrapolating from zero gives infinity, and a screen
  // rendering "due in Infinity days" is worse than a blank.

  return {
    ...base, status, hoursSinceDatum, hoursRemaining, hoursPerDay, dueAt, daysRemaining,
  };
}

/**
 * Is this machine working harder than others of its kind?
 *
 * The question Things Alive asked for: which machines reach their interval faster than
 * the fleet average. Answered on hours per day rather than on total hours, because a
 * machine commissioned last month has fewer total hours than one commissioned in 2019
 * and is not thereby working less hard.
 */
export const MIN_FLEET_PEERS = 3;
export const OUTRUNNING_RATIO = 1.25;

export interface FleetComparison {
  hoursPerDay: number | null;
  fleetHoursPerDay: number | null;
  ratio: number | null;
  outrunning: boolean;
  peers: number;
  /** Absent when the class is too small to have an average worth comparing against. */
  reason?: 'too-few-peers' | 'no-rate';
}

export function compareToFleet(
  machine: { hoursPerDay: number | null },
  peers: { hoursPerDay: number | null }[],
  minPeers = MIN_FLEET_PEERS,
): FleetComparison {
  const rates = peers.map((p) => p.hoursPerDay).filter((r): r is number => r !== null && r > 0);

  if (machine.hoursPerDay === null) {
    return { hoursPerDay: null, fleetHoursPerDay: null, ratio: null, outrunning: false, peers: rates.length, reason: 'no-rate' };
  }
  // Two machines of a class do not have an average; they have each other. Comparing
  // against one peer would flag whichever of a pair happened to work more that month,
  // every month, which is noise wearing the clothes of a finding.
  if (rates.length < minPeers) {
    return {
      hoursPerDay: machine.hoursPerDay, fleetHoursPerDay: null, ratio: null,
      outrunning: false, peers: rates.length, reason: 'too-few-peers',
    };
  }

  const fleet = round(rates.reduce((a, b) => a + b, 0) / rates.length);
  const ratio = fleet > 0 ? round(machine.hoursPerDay / fleet) : null;
  return {
    hoursPerDay: machine.hoursPerDay,
    fleetHoursPerDay: fleet,
    ratio,
    outrunning: ratio !== null && ratio >= OUTRUNNING_RATIO,
    peers: rates.length,
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;
