import { shiftEnd } from '../src/shift-fuel/shift-fuel-forecast';
import {
  nowcastShift, pickSeries, runningShift, SHIFT_FUEL_NOWCAST_METHOD, soFarLitres, tickFloor,
} from '../src/shift-fuel/shift-fuel-nowcast';
import { nowcastTickSeconds } from '../src/shift-fuel/shift-fuel-nowcast.scheduler';

/**
 * The in-shift nowcast's arithmetic (D52), as pure functions. As in the EWMA spec, every
 * number is worked by hand beside it, so a change to the rule shows up as a changed
 * expectation rather than a test quietly following the code.
 *
 * The day shift of 20 October runs 02:30-14:30 UTC (08:00-20:00 in India).
 */
describe('shift fuel nowcast: the arithmetic', () => {
  const day = { sdate: '2026-10-20', shift: 1 as const };
  const at = (utc: string) => new Date(`2026-10-20T${utc}Z`);

  describe('so far plus the base forecast\'s share of the hours left', () => {
    it('two hours in: 20 burned, 120 forecast, ten twelfths of it still to come', () => {
      // 20 + 120 * 10/12 = 120
      expect(nowcastShift({ soFarL: 20, baseL: 120, asOf: at('04:30:00'), key: day }))
        .toEqual({ soFarL: 20, predictedL: 120, hoursRemaining: 10 });
    });

    it('six hours in: a heavier morning than forecast carries through to the total', () => {
      // 70 + 120 * 6/12 = 130
      expect(nowcastShift({ soFarL: 70, baseL: 120, asOf: at('08:30:00'), key: day }).predictedL).toBe(130);
    });

    it('rounds to two places, as the columns hold it', () => {
      // so far 33.333 -> 33.33; 87.5 * 8/12 = 58.3333; 33.33 + 58.3333 = 91.6633 -> 91.66
      expect(nowcastShift({ soFarL: 33.333, baseL: 87.5, asOf: at('06:30:00'), key: day }))
        .toEqual({ soFarL: 33.33, predictedL: 91.66, hoursRemaining: 8 });
    });

    it('the night shift counts its hours across midnight', () => {
      // Night of the 20th: 14:30 UTC to 02:30 UTC on the 21st. At 23:30 UTC, 3 hours left.
      // 100 + 48 * 3/12 = 112
      const night = { sdate: '2026-10-20', shift: 2 as const };
      expect(nowcastShift({ soFarL: 100, baseL: 48, asOf: new Date('2026-10-20T23:30:00Z'), key: night }))
        .toEqual({ soFarL: 100, predictedL: 112, hoursRemaining: 3 });
    });

    it('never below what has burned, never above it plus the whole base', () => {
      // At the end there is no share left; before the start, the whole base.
      expect(nowcastShift({ soFarL: 55, baseL: 120, asOf: shiftEnd(day), key: day }).predictedL).toBe(55);
      expect(nowcastShift({ soFarL: 0, baseL: 120, asOf: at('01:00:00'), key: day }).predictedL).toBe(120);
      // A base of 0 (no history) leaves the figure at what has burned.
      expect(nowcastShift({ soFarL: 12.5, baseL: 0, asOf: at('04:30:00'), key: day }).predictedL).toBe(12.5);
    });
  });

  describe('litres so far, from the counter', () => {
    it('is the counter\'s rise since the start', () => {
      // 5025.4 - 5000.15 = 25.25
      expect(soFarLitres(5000.15, 5025.4)).toBe(25.25);
      expect(soFarLitres(5000, 5000)).toBe(0);
    });

    it('a counter that went backwards credits the shift with nothing, not a negative burn', () => {
      expect(soFarLitres(7000, 12)).toBe(0);
    });
  });

  describe('which of a machine\'s counters to read', () => {
    const r = (utc: string, value: number) => ({ at: at(utc), value });

    it('the one that reported most recently: a replaced device has gone quiet', () => {
      const picked = pickSeries([
        { seriesId: 21, opening: r('02:29:00', 800), latest: r('03:00:00', 900) },
        { seriesId: 22, opening: r('03:10:00', 10), latest: r('04:25:00', 40) },
      ]);
      expect(picked?.seriesId).toBe(22);
    });

    it('the lower id when two reported at the same instant, so the choice is stable', () => {
      const picked = pickSeries([
        { seriesId: 32, opening: r('02:29:00', 1), latest: r('04:00:00', 2) },
        { seriesId: 31, opening: r('02:29:00', 1), latest: r('04:00:00', 2) },
      ]);
      expect(picked?.seriesId).toBe(31);
    });

    it('none, when no counter has a reading since the start', () => {
      expect(pickSeries([{ seriesId: 51, opening: null, latest: null }])).toBeNull();
      expect(pickSeries([])).toBeNull();
    });
  });

  describe('which shift, and which tick', () => {
    it('the shift under way, with each boundary belonging to the shift that starts there', () => {
      expect(runningShift(at('04:30:00'))).toEqual(day);
      expect(runningShift(at('02:30:00'))).toEqual(day);
      expect(runningShift(at('02:29:59'))).toEqual({ sdate: '2026-10-19', shift: 2 });
      expect(runningShift(at('14:30:00'))).toEqual({ sdate: '2026-10-20', shift: 2 });
      // 01:30 on the 21st in India is still the night shift of the 20th.
      expect(runningShift(at('20:00:00'))).toEqual({ sdate: '2026-10-20', shift: 2 });
    });

    it('rounds down to the tick, which in India falls on the quarter hours', () => {
      // 02:52:10 UTC is 08:22:10 in India; the quarter hour before it is 08:15, 02:45 UTC.
      expect(tickFloor(at('02:52:10')).toISOString()).toBe('2026-10-20T02:45:00.000Z');
      expect(tickFloor(at('02:52:10'), 300).toISOString()).toBe('2026-10-20T02:50:00.000Z');
      expect(tickFloor(at('02:45:00')).toISOString()).toBe('2026-10-20T02:45:00.000Z');
    });

    it('a tick from the environment is never under five minutes, and a typo is the default', () => {
      expect(nowcastTickSeconds({})).toBe(900);
      expect(nowcastTickSeconds({ SHIFT_FUEL_NOWCAST_TICK_SECONDS: '60' })).toBe(300);
      expect(nowcastTickSeconds({ SHIFT_FUEL_NOWCAST_TICK_SECONDS: '1800' })).toBe(1800);
      expect(nowcastTickSeconds({ SHIFT_FUEL_NOWCAST_TICK_SECONDS: '15m' })).toBe(900);
    });
  });

  it('names its method apart from the forecast it takes a share of', () => {
    expect(SHIFT_FUEL_NOWCAST_METHOD).toBe('so-far+ewma-0.5-28d-share');
  });
});
