import {
  AccuracyQueryError, accuracyPct, MAX_RANGE_DAYS, parseAccuracyQuery, scoreAccuracy, ShiftOutcome,
} from '../src/shift-fuel/shift-fuel-accuracy';

/**
 * How accuracy is scored (D53), as pure functions. Every number is worked by hand beside
 * it, as in the EWMA and nowcast specs, so a change to the definition shows up as a
 * changed expectation rather than a test quietly following the code.
 *
 * Three machines over the 20th and 21st of October, scored at 12:00 UTC on the 22nd —
 * the 22nd's day shift (02:30-14:30 UTC) is still running then.
 *
 *              actual  forecast  at 2h  at 4h  at 6h
 *   EQ-A 20/1    100      120     110    105    102
 *        20/2     50       40      45     48     49
 *        21/1    120      100       -    115    118
 *        21/2     70        -       -      -      -     no forecast was issued
 *        22/1    999        1                            still running
 *   EQ-B 20/1      0       10       -      -      -
 *        20/2     30       30       -      -      -
 *   EQ-C 20/1      0       25                            never ran
 *        21/1      0        -
 */
describe('shift fuel accuracy: the arithmetic', () => {
  const NOW = new Date('2026-10-22T12:00:00Z');
  const none = { 2: null, 4: null, 6: null };
  const o = (
    externalId: string, sdate: string, shift: 1 | 2, actualL: number, forecastL: number | null,
    checkpointL: ShiftOutcome['checkpointL'] = none,
  ): ShiftOutcome => ({ sourceSystem: 'ta-2.0', externalId, sdate, shift, actualL, forecastL, checkpointL });

  const OUTCOMES: ShiftOutcome[] = [
    o('EQ-A', '2026-10-20', 1, 100, 120, { 2: 110, 4: 105, 6: 102 }),
    o('EQ-A', '2026-10-20', 2, 50, 40, { 2: 45, 4: 48, 6: 49 }),
    o('EQ-A', '2026-10-21', 1, 120, 100, { 2: null, 4: 115, 6: 118 }),
    o('EQ-A', '2026-10-21', 2, 70, null),
    o('EQ-A', '2026-10-22', 1, 999, 1, { 2: 1, 4: 1, 6: 1 }),
    o('EQ-B', '2026-10-20', 1, 0, 10),
    o('EQ-B', '2026-10-20', 2, 30, 30),
    o('EQ-C', '2026-10-20', 1, 0, 25),
    o('EQ-C', '2026-10-21', 1, 0, null),
  ];
  const machine = (level: 'day' | 'shift' | 'range', id: string) =>
    scoreAccuracy(OUTCOMES, level, NOW).machines.find((m) => m.externalId === id);

  describe('the score', () => {
    it('is 100 less the miss as a percentage of the actual, rounded once', () => {
      expect(accuracyPct(50, 270)).toBe(81); // 18.52% -> 19
      expect(accuracyPct(0, 300)).toBe(100);
      // Half a point rounds up, against the forecast.
      expect(accuracyPct(5, 1000)).toBe(99);
      expect(accuracyPct(4.9, 1000)).toBe(100);
    });

    it('never goes below zero, however wrong', () => {
      expect(accuracyPct(250, 100)).toBe(0);
    });

    it('is null when nothing burned, not 0% and not 100%', () => {
      expect(accuracyPct(0, 0)).toBeNull();
      expect(accuracyPct(25, 0)).toBeNull();
    });
  });

  describe('one machine, per level', () => {
    it('per shift: every machine-shift\'s miss counts on its own', () => {
      // Scored: 20/1, 20/2, 21/1. Miss |120-100| + |40-50| + |100-120| = 50; actual 270.
      // 100 - round(18.52) = 81.
      expect(machine('shift', 'EQ-A')).toMatchObject({ accuracy: 81 });
    });

    it('per day: a day\'s shifts net off inside the day', () => {
      // Day 20: 160 vs 150 -> 10. Day 21: 100 vs 120 -> 20 (21/2 is not scored). 30 / 270 = 11.1% -> 89.
      expect(machine('day', 'EQ-A')).toMatchObject({ accuracy: 89 });
    });

    it('over the whole range: one total against the other', () => {
      // 260 vs 270 -> 10 / 270 = 3.7% -> 96.
      expect(machine('range', 'EQ-A')).toMatchObject({ accuracy: 96 });
    });

    it('litres and counts: every completed shift\'s actual, the scored shifts\' forecast', () => {
      expect(machine('day', 'EQ-A')).toEqual({
        sourceSystem: 'ta-2.0', externalId: 'EQ-A',
        actualL: 340, forecastL: 260, accuracy: 89,
        // 2h: 20/1 and 20/2 -> |110-100| + |45-50| over day 20: 155 vs 150 -> 5 / 150 -> 97.
        // 4h: day 20 153 vs 150 -> 3; day 21 115 vs 120 -> 5; 8 / 270 = 2.96% -> 97.
        // 6h: day 20 151 vs 150 -> 1; day 21 118 vs 120 -> 2; 3 / 270 = 1.1% -> 99.
        checkpoints: { 2: 97, 4: 97, 6: 99 },
        shifts: 4, ranShifts: 4,
        shiftsWithoutForecast: 1,
        shiftsWithoutCheckpoint: { 2: 2, 4: 1, 6: 1 },
      });
    });

    it('a checkpoint per shift is scored over its own shifts', () => {
      // 2h: |110-100| + |45-50| = 15 over 150 -> 90. 4h: 5 + 2 + 5 = 12 over 270 -> 96.
      // 6h: 2 + 1 + 2 = 5 over 270 -> 98.
      expect(machine('shift', 'EQ-A')?.checkpoints).toEqual({ 2: 90, 4: 96, 6: 98 });
    });

    it('a shift with no forecast is left out, never scored as a forecast of zero', () => {
      const asZero = OUTCOMES.map((s) => (s.externalId === 'EQ-A' && s.forecastL === null ? { ...s, forecastL: 0 } : s));
      // Scored as zero, 21/2 would add a miss of 70 and 70 litres: 120 / 340 -> 65, not 81.
      expect(scoreAccuracy(asZero, 'shift', NOW).machines.find((m) => m.externalId === 'EQ-A')?.accuracy).toBe(65);
      expect(machine('shift', 'EQ-A')?.accuracy).toBe(81);
    });

    it('a shift still running is not in any figure', () => {
      // EQ-A's 22/1 — 999 litres against a forecast of 1 — would sink every score.
      expect(machine('range', 'EQ-A')).toMatchObject({ actualL: 340, shifts: 4 });
      expect(machine('range', 'EQ-A')?.checkpoints[2]).toBe(97);
      const later = scoreAccuracy(OUTCOMES, 'range', new Date('2026-10-22T14:30:00Z'));
      expect(later.machines.find((m) => m.externalId === 'EQ-A')).toMatchObject({ actualL: 1339, shifts: 5 });
    });

    it('a machine that burned nothing says so: no percentage, its litres still shown', () => {
      expect(machine('day', 'EQ-C')).toEqual({
        sourceSystem: 'ta-2.0', externalId: 'EQ-C',
        actualL: 0, forecastL: 25, accuracy: null, checkpoints: { 2: null, 4: null, 6: null },
        shifts: 2, ranShifts: 0, shiftsWithoutForecast: 1, shiftsWithoutCheckpoint: { 2: 2, 4: 2, 6: 2 },
      });
    });

    it('an idle shift of a machine that ran is scored: its forecast was wrong', () => {
      // EQ-B per shift: |10-0| + |30-30| = 10 over 30 -> 67.
      expect(machine('shift', 'EQ-B')).toMatchObject({ actualL: 30, forecastL: 40, accuracy: 67, shifts: 2, ranShifts: 1 });
    });

    it('comes back best first, the ones that never ran last', () => {
      expect(scoreAccuracy(OUTCOMES, 'shift', NOW).machines.map((m) => [m.externalId, m.accuracy]))
        .toEqual([['EQ-A', 81], ['EQ-B', 67], ['EQ-C', null]]);
    });

    it('sums litres as the columns hold them, to the hundredth', () => {
      const tenths = [o('EQ-D', '2026-10-20', 1, 0.3, 0.1), o('EQ-D', '2026-10-20', 2, 0.2, 0.2), o('EQ-D', '2026-10-21', 1, 0.1, 0.3)];
      // In floating point 0.1 + 0.2 + 0.3 is 0.6000000000000001.
      expect(scoreAccuracy(tenths, 'range', NOW).machines[0]).toMatchObject({ actualL: 0.6, forecastL: 0.6, accuracy: 100 });
    });
  });

  describe('the fleet', () => {
    it('is the machines that burned anything, and only those', () => {
      // EQ-A and EQ-B. EQ-C's 25 forecast litres are not charged to the fleet.
      expect(scoreAccuracy(OUTCOMES, 'shift', NOW).fleet).toEqual({
        machines: 2, actualL: 370, forecastL: 300,
        // Machine-shift misses 50 + 10 = 60 over 300 -> 80. With EQ-C it would be 85 / 300 -> 72.
        accuracy: 80,
        // 2h: EQ-A's 15 over 150 -> 90. EQ-B has no snapshots.
        checkpoints: { 2: 90, 4: 96, 6: 98 },
        shiftsWithoutForecast: 1,
        shiftsWithoutCheckpoint: { 2: 4, 4: 3, 6: 3 },
      });
    });

    it('per day, the fleet\'s own day totals: one machine over and another under cancel', () => {
      // Day 20: forecast 120 + 40 + 10 + 30 = 200, actual 100 + 50 + 0 + 30 = 180 -> 20.
      // Day 21: 100 vs 120 -> 20. 40 / 300 = 13.3% -> 87.
      expect(scoreAccuracy(OUTCOMES, 'day', NOW).fleet.accuracy).toBe(87);
    });

    it('over the range, the fleet\'s total against its total', () => {
      // 300 vs 300.
      expect(scoreAccuracy(OUTCOMES, 'range', NOW).fleet.accuracy).toBe(100);
    });

    it('with nothing to score, nothing: no machines, no percentage', () => {
      expect(scoreAccuracy([], 'day', NOW).fleet).toEqual({
        machines: 0, actualL: 0, forecastL: 0, accuracy: null, checkpoints: { 2: null, 4: null, 6: null },
        shiftsWithoutForecast: 0, shiftsWithoutCheckpoint: { 2: 0, 4: 0, 6: 0 },
      });
    });
  });

  describe('the query', () => {
    it('defaults to today in India, counted per day', () => {
      // 20:00 UTC on the 20th is 01:30 on the 21st in India.
      expect(parseAccuracyQuery({}, new Date('2026-10-20T20:00:00Z')))
        .toEqual({ from: '2026-10-21', to: '2026-10-21', level: 'day' });
      expect(parseAccuracyQuery({ from: '2026-10-01', level: 'range' }, new Date('2026-10-20T20:00:00Z')))
        .toEqual({ from: '2026-10-01', to: '2026-10-21', level: 'range' });
    });

    it(`takes up to ${MAX_RANGE_DAYS} days, ends included`, () => {
      // August 31 + September 30 + October 31.
      expect(parseAccuracyQuery({ from: '2026-08-01', to: '2026-10-31', level: 'shift' }, NOW))
        .toEqual({ from: '2026-08-01', to: '2026-10-31', level: 'shift' });
    });

    it('refuses a day more than that', () => {
      expect(() => parseAccuracyQuery({ from: '2026-08-01', to: '2026-11-01' }, NOW)).toThrow(/93 days/);
    });

    it('refuses a range that ends before it starts', () => {
      expect(() => parseAccuracyQuery({ from: '2026-10-21', to: '2026-10-20' }, NOW)).toThrow(AccuracyQueryError);
    });

    it('refuses a date that is not one, or not written as YYYY-MM-DD', () => {
      expect(() => parseAccuracyQuery({ from: '2026-02-30', to: '2026-03-01' }, NOW)).toThrow(/from must be a date/);
      expect(() => parseAccuracyQuery({ to: '20261021' }, NOW)).toThrow(/to must be a date/);
      expect(() => parseAccuracyQuery({ from: '21/10/2026' }, NOW)).toThrow(AccuracyQueryError);
      expect(() => parseAccuracyQuery({ to: '2026-13-01' }, NOW)).toThrow(/to must be a date/);
    });

    it('refuses a level it does not know', () => {
      expect(() => parseAccuracyQuery({ level: 'week' }, NOW)).toThrow(/level must be one of day, shift, range/);
    });
  });
});
