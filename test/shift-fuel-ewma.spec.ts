import {
  ewma, forecastShift, indiaDate, nextShift, SHIFT_FUEL_METHOD, shiftEnd, shiftStart, targetShifts,
} from '../src/shift-fuel/shift-fuel-forecast';

/**
 * The shift fuel forecast's arithmetic (D50), as a pure function. Every number here is
 * worked by hand in the comment beside it, so a change to the method shows up as a
 * changed expectation rather than a test quietly following the code.
 */
describe('shift fuel forecast: the arithmetic', () => {
  describe('ewma, alpha 0.5, oldest first', () => {
    it('seeds with the first value and moves half way to each later one', () => {
      // 40 -> 70 -> 95 -> 87.5
      expect(ewma([40, 100, 120, 80])).toBe(87.5);
    });

    it('weights the newest most: the same values in the other order give another answer', () => {
      // 80 -> 100 -> 100 -> 70
      expect(ewma([80, 120, 100, 40])).toBe(70);
    });

    it('is the value itself for one observation, and 0 for none', () => {
      expect(ewma([33])).toBe(33);
      expect(ewma([])).toBe(0);
    });
  });

  describe('one shift from one machine\'s history', () => {
    const target = { sdate: '2026-10-20', shift: 1 as const };

    it('uses the same shift only, inside the 28 days before the target\'s date', () => {
      const r = forecastShift([
        { sdate: '2026-09-21', shift: 1, fuelL: 1000 }, // 29 days before: outside
        { sdate: '2026-09-22', shift: 1, fuelL: 40 }, // 28 days before: inside
        { sdate: '2026-10-16', shift: 1, fuelL: 100 },
        { sdate: '2026-10-18', shift: 2, fuelL: 999 }, // the other shift
        { sdate: '2026-10-18', shift: 1, fuelL: 120 },
        { sdate: '2026-10-19', shift: 1, fuelL: 80 },
        { sdate: '2026-10-20', shift: 1, fuelL: 5000 }, // the target's own day
      ], target);
      expect(r).toEqual({ predictedL: 87.5, inputsThrough: '2026-10-19' });
    });

    it('skips a day with no row, or a row with no figure, rather than counting it as zero', () => {
      // 100, (17th missing), (18th null), 80 -> 90. Counting the gaps as 0 would give 45.
      const r = forecastShift([
        { sdate: '2026-10-16', shift: 1, fuelL: 100 },
        { sdate: '2026-10-18', shift: 1, fuelL: null },
        { sdate: '2026-10-19', shift: 1, fuelL: 80 },
      ], target);
      expect(r).toEqual({ predictedL: 90, inputsThrough: '2026-10-19' });
    });

    it('sorts by date whatever order the rows arrive in', () => {
      const r = forecastShift([
        { sdate: '2026-10-19', shift: 1, fuelL: 80 },
        { sdate: '2026-10-16', shift: 1, fuelL: 40 },
      ], target);
      expect(r.predictedL).toBe(60);
    });

    it('is 0 with no history, and says it used nothing', () => {
      expect(forecastShift([{ sdate: '2026-10-19', shift: 2, fuelL: 70 }], target))
        .toEqual({ predictedL: 0, inputsThrough: null });
    });

    it('rounds to the column\'s two places', () => {
      // 10 -> 10.5 -> 10.75 -> 10.875, stored as 10.88
      const r = forecastShift([10, 11, 11, 11].map((fuelL, i) => ({ sdate: `2026-10-1${i}`, shift: 1 as const, fuelL })), target);
      expect(r.predictedL).toBe(10.88);
    });

    it('names itself', () => {
      expect(SHIFT_FUEL_METHOD).toBe('ewma-0.5-28d');
    });
  });

  describe('the existing platform\'s shifts', () => {
    it('shift 1 is 08:00-20:00 India time on its date; shift 2 is 20:00 to 08:00 the next morning', () => {
      expect(shiftStart({ sdate: '2026-10-20', shift: 1 }).toISOString()).toBe('2026-10-20T02:30:00.000Z');
      expect(shiftEnd({ sdate: '2026-10-20', shift: 1 }).toISOString()).toBe('2026-10-20T14:30:00.000Z');
      expect(shiftStart({ sdate: '2026-10-20', shift: 2 }).toISOString()).toBe('2026-10-20T14:30:00.000Z');
      expect(shiftEnd({ sdate: '2026-10-20', shift: 2 }).toISOString()).toBe('2026-10-21T02:30:00.000Z');
    });

    it('dates by India\'s calendar, not UTC\'s', () => {
      // 19:00 UTC on the 19th is 00:30 on the 20th in India.
      expect(indiaDate(new Date('2026-10-19T19:00:00Z'))).toBe('2026-10-20');
      expect(nextShift({ sdate: '2026-10-31', shift: 2 })).toEqual({ sdate: '2026-11-01', shift: 1 });
    });
  });

  describe('which shifts to forecast', () => {
    const at = (iso: string) => new Date(iso);

    it('after the morning sync, today\'s two shifts — the day shift already under way among them', () => {
      // 10:00 India time; the newest row is last night's.
      expect(targetShifts({ sdate: '2026-10-19', shift: 2 }, at('2026-10-20T04:30:00Z'))).toEqual([
        { sdate: '2026-10-20', shift: 1 }, { sdate: '2026-10-20', shift: 2 },
      ]);
    });

    it('after the evening sync, tonight and tomorrow morning', () => {
      // 20:30 India time; the newest row is today's day shift.
      expect(targetShifts({ sdate: '2026-10-20', shift: 1 }, at('2026-10-20T15:00:00Z'))).toEqual([
        { sdate: '2026-10-20', shift: 2 }, { sdate: '2026-10-21', shift: 1 },
      ]);
    });

    it('never a shift that has already ended, however old the newest row is', () => {
      // The feed stalled a week ago: forecast now and next, not the week in between.
      expect(targetShifts({ sdate: '2026-10-12', shift: 1 }, at('2026-10-20T04:30:00Z'))).toEqual([
        { sdate: '2026-10-20', shift: 1 }, { sdate: '2026-10-20', shift: 2 },
      ]);
      // Just after midnight in India the night shift that began yesterday is still running.
      expect(targetShifts({ sdate: '2026-10-19', shift: 1 }, at('2026-10-19T19:00:00Z'))).toEqual([
        { sdate: '2026-10-19', shift: 2 }, { sdate: '2026-10-20', shift: 1 },
      ]);
    });
  });
});
