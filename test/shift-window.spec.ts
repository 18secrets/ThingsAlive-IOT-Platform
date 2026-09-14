import {
  isOvernight, localDateIn, nominalLengthMinutes, shiftsOverlap, ShiftDefinition,
  weeklyIntervals, windowForLocalDate, windowsEndingBetween, zonedWallToUtc, isValidTimeZone,
} from '../src/shift/services/shift-window';

/**
 * Shift arithmetic (task P1-109).
 *
 * Worth testing hard because everything downstream depends on it: if the window is
 * wrong, the scoring window is wrong, the baseline is wrong, and the prediction is
 * confidently wrong rather than obviously broken.
 */
const IST = 'Asia/Kolkata';
const LONDON = 'Europe/London';

const day = (startMinute: number, endMinute: number, days: any[], timeZone = IST): ShiftDefinition =>
  ({ startMinute, endMinute, days, timeZone });

describe('a shift window', () => {
  it('turns wall-clock hours in a plant\'s own zone into instants', () => {
    // 06:00 in Kolkata is 00:30 UTC. An offset stored as a number would have to know
    // this plant is on a half-hour zone; reading the zone database knows.
    const start = zonedWallToUtc(IST, 2026, 9, 14, 6 * 60);
    expect(start.toISOString()).toBe('2026-09-14T00:30:00.000Z');
  });

  it('keeps a day shift inside its day', () => {
    const w = windowForLocalDate(day(6 * 60, 14 * 60, [1]), '2026-09-14');
    expect(w.start.toISOString()).toBe('2026-09-14T00:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-14T08:30:00.000Z');
    expect(nominalLengthMinutes(day(6 * 60, 14 * 60, [1]))).toBe(480);
  });

  it('carries a night shift into the following morning', () => {
    const night = day(22 * 60, 6 * 60, [5]);
    expect(isOvernight(night)).toBe(true);

    // A shift belongs to the day it starts, so this is the Friday night shift even
    // though most of it happens on Saturday. Any other convention makes "did Friday
    // night run" unanswerable without knowing the hours.
    const w = windowForLocalDate(night, '2026-09-18');
    expect(w.start.toISOString()).toBe('2026-09-18T16:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-19T00:30:00.000Z');
    expect(w.localDate).toBe('2026-09-18');
  });

  it('distinguishes midnight at the end from midnight at the start', () => {
    // 1440 is the far end of the day; 0 would mean this shift is zero minutes long
    // and runs overnight, which is a different shift entirely.
    const untilMidnight = day(16 * 60, 1440, [1]);
    expect(isOvernight(untilMidnight)).toBe(false);
    expect(nominalLengthMinutes(untilMidnight)).toBe(480);
  });

  describe('when the clock moves', () => {
    // Britain springs forward at 01:00 UTC on 29 March 2026 and falls back at
    // 02:00 local on 25 October 2026.
    it('gives a night shift an hour less in spring and an hour more in autumn', () => {
      const night = day(22 * 60, 6 * 60, [6], LONDON);

      const spring = windowForLocalDate(night, '2026-03-28');
      const springHours = (spring.end.getTime() - spring.start.getTime()) / 3_600_000;
      // The people were there for eight hours of wall clock and seven of real time.
      // A window computed by adding eight hours to the start would run an hour past
      // the end of the shift and score readings from the next one.
      expect(springHours).toBe(7);

      const autumn = windowForLocalDate(day(22 * 60, 6 * 60, [6], LONDON), '2026-10-24');
      expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(9);
    });

    it('moves a shift forward by the gap, if its hour never happened', () => {
      // 01:30 does not exist on 29 March 2026 in London: the clock goes 00:59 to 02:00.
      // The whole shift shifts forward and keeps its wall-clock length, so it still
      // meets the shifts either side instead of opening an hour-wide hole.
      const at = zonedWallToUtc(LONDON, 2026, 3, 29, 90);
      expect(at.toISOString()).toBe('2026-03-29T01:30:00.000Z');
      expect(localDateIn(LONDON, at)).toBe('2026-03-29');
    });

    it('takes the first of a repeated hour, so the shift is the longer one', () => {
      // 01:30 happens twice on 25 October 2026. The people were there for both.
      const at = zonedWallToUtc(LONDON, 2026, 10, 25, 90);
      expect(at.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    });
  });

  describe('finding what has just finished', () => {
    const morning = day(6 * 60, 14 * 60, [0, 1, 2, 3, 4, 5, 6]);

    it('returns a shift exactly once, however often the check runs', () => {
      const after = new Date('2026-09-14T00:00:00.000Z');
      const upTo = new Date('2026-09-14T12:00:00.000Z');
      const first = windowsEndingBetween(morning, after, upTo);
      expect(first).toHaveLength(1);
      expect(first[0].localDate).toBe('2026-09-14');

      // Run again from where the last one stopped: nothing, because nothing new has
      // ended. This is what makes the scheduler safe to fire as often as it likes.
      expect(windowsEndingBetween(morning, upTo, new Date('2026-09-14T20:00:00.000Z')))
        .toEqual([]);
    });

    it('catches up in order after an outage, rather than scoring only the newest', () => {
      const windows = windowsEndingBetween(
        morning,
        new Date('2026-09-12T00:00:00.000Z'),
        new Date('2026-09-14T23:00:00.000Z'),
      );
      // Three days down is three shifts owed. Taking only the latest would leave two
      // days of a machine's history unscored and nothing to say so.
      expect(windows.map((w) => w.localDate)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14']);
    });

    it('finds a night shift by the day it started, not the day it ended', () => {
      const night = day(22 * 60, 6 * 60, [5]);
      // Friday 18 September's night shift ends early on Saturday.
      const windows = windowsEndingBetween(
        night,
        new Date('2026-09-18T20:00:00.000Z'),
        new Date('2026-09-19T06:00:00.000Z'),
      );
      expect(windows.map((w) => w.localDate)).toEqual(['2026-09-18']);
    });

    it('skips days the shift does not run', () => {
      const weekdays = day(6 * 60, 14 * 60, [1, 2, 3, 4, 5]);
      // 2026-09-13 is a Sunday.
      expect(windowsEndingBetween(
        weekdays,
        new Date('2026-09-13T00:00:00.000Z'),
        new Date('2026-09-13T23:00:00.000Z'),
      )).toEqual([]);
    });

    it('returns nothing for a shift that runs on no days at all', () => {
      expect(windowsEndingBetween(
        day(6 * 60, 14 * 60, []),
        new Date('2026-09-01T00:00:00.000Z'),
        new Date('2026-09-30T00:00:00.000Z'),
      )).toEqual([]);
    });
  });

  describe('overlap', () => {
    it('allows a three-shift day to meet exactly at the boundaries', () => {
      const a = day(6 * 60, 14 * 60, [1]);
      const b = day(14 * 60, 22 * 60, [1]);
      const c = day(22 * 60, 6 * 60, [1]);
      // The end is exclusive, so 14:00 belongs to the afternoon shift only. If it were
      // inclusive every handover would be an overlap and no plant could be modelled.
      expect(shiftsOverlap(a, b)).toBe(false);
      expect(shiftsOverlap(b, c)).toBe(false);
      expect(shiftsOverlap(a, c)).toBe(false);
    });

    it('catches a night shift colliding with the next morning', () => {
      const night = day(22 * 60, 7 * 60, [1]);
      const morning = day(6 * 60, 14 * 60, [2]);
      // Monday night runs to 07:00 Tuesday; Tuesday morning starts at 06:00. An hour
      // of telemetry would belong to two shifts and be scored twice.
      expect(shiftsOverlap(night, morning)).toBe(true);
    });

    it('catches a Saturday night shift wrapping into Sunday morning', () => {
      const saturdayNight = day(22 * 60, 6 * 60, [6]);
      const sundayMorning = day(5 * 60, 13 * 60, [0]);
      // The week boundary is where an overlap check written as plain arithmetic stops
      // working, because the interval runs past the end of the week and back to zero.
      expect(shiftsOverlap(saturdayNight, sundayMorning)).toBe(true);
      expect(weeklyIntervals(saturdayNight)).toContainEqual([0, 360]);
    });

    it('lets the same hours run on different days', () => {
      expect(shiftsOverlap(day(6 * 60, 14 * 60, [1]), day(6 * 60, 14 * 60, [2]))).toBe(false);
    });
  });

  it('knows a real timezone from a plausible one', () => {
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true);
    expect(isValidTimeZone('Asia/Bengaluru')).toBe(false);
    // Node resolves bare 'IST' quite happily, and it means India, Ireland or Israel
    // depending on who is reading. A region/city name or UTC, nothing else.
    expect(isValidTimeZone('IST')).toBe(false);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('reads a local date from the plant\'s clock, not the server\'s', () => {
    // 20:00 UTC is already tomorrow in Kolkata. A server in London deciding which day
    // a shift belongs to would put it on the wrong one for a third of every day.
    expect(localDateIn(IST, new Date('2026-09-14T20:00:00.000Z'))).toBe('2026-09-15');
    expect(localDateIn(LONDON, new Date('2026-09-14T20:00:00.000Z'))).toBe('2026-09-14');
  });
});
