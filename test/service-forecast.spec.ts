import {
  APPROACHING_HOURS,
  MIN_FLEET_PEERS,
  MIN_RATE_DAYS,
  OUTRUNNING_RATIO,
  compareToFleet,
  forecastService,
  resolveInterval,
  ForecastInput,
} from '../src/service/services/service-forecast';

/**
 * Turning engine hours into a date (task P4-07).
 *
 * Most of this file is about incompleteness. A forecast missing an input is not a
 * worse forecast — it is a different statement, and the tests here pin which statement
 * comes out, because a screen that cannot tell "due in nine days" from "nobody has
 * told us this machine's interval" will show the second as the first.
 */

const NOW = new Date('2026-09-14T00:00:00Z');

const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  interval: { hours: 500, source: 'equipment' },
  meterReading: 1200,
  meterUnit: 'hours',
  meterAtDatum: 1000,
  datum: 'service-record',
  datumAt: new Date('2026-06-01T00:00:00Z'),
  engineOnSeconds: 30 * 8 * 3600, // 8 h/day for 30 days
  rateDays: 30,
  now: NOW,
  ...over,
});

describe('resolveInterval', () => {
  it('lets the machine\'s own interval beat its class default', () => {
    // The specific fact wins. Otherwise setting it on the machine would have no
    // effect and nobody would be able to say why.
    expect(resolveInterval({ equipmentHours: 250, classHours: 500, classSlug: 'dg' }))
      .toMatchObject({ hours: 250, source: 'equipment' });
  });

  it('falls back to the class', () => {
    expect(resolveInterval({ equipmentHours: null, classHours: 500, classSlug: 'dg' }))
      .toMatchObject({ hours: 500, source: 'class', classSlug: 'dg' });
  });

  it('reports no interval rather than inventing one', () => {
    // The common state on day one, and the reason the forecast has a `missing` list.
    expect(resolveInterval({ equipmentHours: null, classHours: null }))
      .toMatchObject({ hours: null, source: null });
    // Zero is not an interval; it is an unset field that somebody typed into.
    expect(resolveInterval({ equipmentHours: 0, classHours: 500 }).source).toBe('class');
  });
});

describe('forecastService', () => {
  it('forecasts a date from hours run and hours per day', () => {
    const f = forecastService(input());
    expect(f.hoursSinceDatum).toBe(200);
    expect(f.hoursRemaining).toBe(300);
    expect(f.hoursPerDay).toBe(8);
    expect(f.daysRemaining).toBe(37.5);
    expect(f.status).toBe('ok');
    expect(f.dueAt!.toISOString().slice(0, 10)).toBe('2026-10-21');
    expect(f.missing).toEqual([]);
  });

  it('converts the meter from whatever unit it counts in', () => {
    // The whole point of the calibration: the same machine, the same 200 hours.
    const asSeconds = forecastService(input({
      meterUnit: 'seconds', meterReading: 1200 * 3600, meterAtDatum: 1000 * 3600,
    }));
    expect(asSeconds.hoursSinceDatum).toBe(200);
    expect(asSeconds.hoursRemaining).toBe(300);
  });

  it('calls a machine past its interval overdue without waiting for a rate', () => {
    // The most urgent case must not be hidden behind the least available input.
    const f = forecastService(input({ meterReading: 1600, rateDays: 2 }));
    expect(f.status).toBe('overdue');
    expect(f.hoursRemaining).toBe(-100);
    expect(f.hoursPerDay).toBeNull();
    expect(f.missing).toEqual(['rate']);
  });

  it('separates due from approaching from fine', () => {
    const at = (remaining: number) =>
      forecastService(input({ meterReading: 1000 + (500 - remaining) })).status;
    expect(at(0)).toBe('overdue');
    expect(at(APPROACHING_HOURS)).toBe('due');
    expect(at(APPROACHING_HOURS + 1)).toBe('approaching');
    expect(at(APPROACHING_HOURS * 4 + 1)).toBe('ok');
  });

  it('will not build a rate out of two busy days', () => {
    // A machine that ran flat out over a long weekend would be forecast to reach its
    // interval in a fortnight, and the work order would arrive months early.
    const f = forecastService(input({ rateDays: MIN_RATE_DAYS - 1, engineOnSeconds: 6 * 20 * 3600 }));
    expect(f.hoursPerDay).toBeNull();
    expect(f.dueAt).toBeNull();
    expect(f.missing).toContain('rate');
    // The hours are still counted. Only the extrapolation is refused.
    expect(f.hoursSinceDatum).toBe(200);
    expect(f.status).toBe('ok');
  });

  it('gives an idle machine no date rather than a date in the year 40000', () => {
    // A rate of zero extrapolates to infinity, and "due in Infinity days" on a screen
    // is worse than a blank.
    const f = forecastService(input({ engineOnSeconds: 0 }));
    expect(f.hoursPerDay).toBe(0);
    expect(f.dueAt).toBeNull();
    expect(f.daysRemaining).toBeNull();
    expect(f.status).toBe('ok');
  });

  it('names a missing interval rather than forecasting without one', () => {
    const f = forecastService(input({ interval: { hours: null, source: null } }));
    expect(f.status).toBeNull();
    expect(f.hoursSinceDatum).toBeNull();
    expect(f.missing).toContain('interval');
    // The rate survives: "this machine runs 8 hours a day" is exactly the number
    // somebody uses to sanity-check an interval before setting one.
    expect(f.hoursPerDay).toBe(8);
  });

  it('names a missing unit, because an unconverted meter is not a number of hours', () => {
    const f = forecastService(input({ meterUnit: null }));
    expect(f.status).toBeNull();
    expect(f.missing).toContain('meter-unit');
  });

  it('names a missing datum', () => {
    const f = forecastService(input({ meterAtDatum: null, datum: null }));
    expect(f.status).toBeNull();
    expect(f.missing).toContain('datum');
  });

  it('refuses a meter reading below the last service', () => {
    // A replaced logger or a typo. The alternative is reporting negative hours run,
    // which nothing downstream expects and which would read as a brand new machine.
    const f = forecastService(input({ meterReading: 900 }));
    expect(f.status).toBeNull();
    expect(f.hoursSinceDatum).toBeNull();
    expect(f.missing).toContain('datum');
  });

  it('works from commissioning when the machine has never been serviced', () => {
    const f = forecastService(input({ datum: 'commissioning', meterAtDatum: 0, meterReading: 480 }));
    expect(f.datum).toBe('commissioning');
    expect(f.hoursSinceDatum).toBe(480);
    expect(f.status).toBe('due');
  });

  it('lists everything missing, so a screen can say what to fix first', () => {
    const f = forecastService(input({
      interval: { hours: null, source: null }, meterUnit: null, meterReading: null,
      meterAtDatum: null, datum: null, rateDays: 0,
    }));
    expect(f.missing).toEqual(['interval', 'meter-unit', 'meter-reading', 'datum', 'rate']);
  });
});

describe('compareToFleet', () => {
  const peer = (hoursPerDay: number | null) => ({ hoursPerDay });

  it('flags a machine outrunning its class', () => {
    const c = compareToFleet(peer(12), [peer(8), peer(8), peer(8)]);
    expect(c.fleetHoursPerDay).toBe(8);
    expect(c.ratio).toBe(1.5);
    expect(c.outrunning).toBe(true);
  });

  it('leaves a machine running with its class alone', () => {
    const c = compareToFleet(peer(8.2), [peer(8), peer(8), peer(8.4)]);
    expect(c.outrunning).toBe(false);
    expect(c.ratio).toBeLessThan(OUTRUNNING_RATIO);
  });

  it('refuses to compare a machine against one other machine', () => {
    // Two of a class do not have an average, they have each other — and comparing
    // against one peer flags whichever worked more that month, every month.
    const c = compareToFleet(peer(12), Array(MIN_FLEET_PEERS - 1).fill(peer(8)));
    expect(c.reason).toBe('too-few-peers');
    expect(c.outrunning).toBe(false);
    expect(c.fleetHoursPerDay).toBeNull();
    // The machine's own rate is still reported; only the comparison is withheld.
    expect(c.hoursPerDay).toBe(12);
  });

  it('ignores peers with no rate of their own', () => {
    const c = compareToFleet(peer(12), [peer(8), peer(8), peer(8), peer(null), peer(0)]);
    expect(c.peers).toBe(3);
    expect(c.fleetHoursPerDay).toBe(8);
  });

  it('says nothing about a machine whose own rate is unknown', () => {
    const c = compareToFleet(peer(null), [peer(8), peer(8), peer(8)]);
    expect(c.reason).toBe('no-rate');
    expect(c.outrunning).toBe(false);
  });
});
