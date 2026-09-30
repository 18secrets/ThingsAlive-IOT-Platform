import {
  describeSignalThresholdRule, evaluateRule, signalWindows, validateParams, WindowReading,
} from '../src/alert/services/alert-rules';

/**
 * A signal-threshold rule's window (task QALERT1, D34; task QALERT2).
 *
 * QALERT1 reduced the window to its max (for an upper bound) or min (for a lower
 * one) and compared that single number to the bound — which still fired on one
 * noisy sample, because the max of ten readings is just whichever one of them is
 * highest. QALERT2 replaces that reduction outright: a bound fires only once at
 * least `requiredBreaches` of the last `lookbackReadings` individually breach it
 * (defaults 6 of 10). Follows QL1's pattern: every rule in the decision gets a
 * test that attempts exactly the behaviour it describes.
 */
const BASE = new Date('2026-09-14T07:00:00.000Z').getTime();
/** `minutesAgo` reads naturally against "the last N readings" — 0 is the most
 * recent, larger numbers are older. */
const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000).toISOString();
const r = (
  signal: string, value: number, minutesAgo: number, extra: Partial<WindowReading> = {},
): WindowReading => ({ signal, value, unit: 'degC', sourceTimestamp: at(minutesAgo), ...extra });

describe('the signal-threshold window', () => {
  it('1. nine normal readings and a single spike within the window does not fire — one breach is not sustained', () => {
    // The exact bug QALERT2 exists to remove: QALERT1's max-of-window reduction
    // fired on this. Pinned directly so it can never come back silently.
    const readings = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 5),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();
  });

  it('1b. exactly six of the last ten breached fires', () => {
    const readings = [
      ...[9, 8, 7, 6].map((m) => r('coolant_temp_c', 95, m)),
      ...[5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 120, m)),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 120, direction: 'above', bound: 105, breaches: 6 });
  });

  it('1c. one short of the boundary — five of the last ten breached — does not fire', () => {
    const readings = [
      ...[9, 8, 7, 6, 3].map((m) => r('coolant_temp_c', 95, m)),
      ...[4, 2, 1, 0].map((m) => r('coolant_temp_c', 120, m)),
      r('coolant_temp_c', 120, 5),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();
  });

  it('2. a spike moved to the 11th-most-recent reading does not fire — the window moved past it', () => {
    const readings = [
      ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 10),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();
  });

  it('3. a lower bound: a single dip within the window does not fire, sustained dips do', () => {
    const singleDip = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('oil_pressure_kpa', 3.0, m, { unit: 'bar' })),
      r('oil_pressure_kpa', 1.0, 5, { unit: 'bar' }),
    ];
    expect(evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'oil_pressure_kpa', min: 2.5, lookbackReadings: 10, requiredBreaches: 6 },
      readings: singleDip, predictions: [],
    })).toBeNull();

    const sustainedDip = [
      ...[9, 8, 7, 6].map((m) => r('oil_pressure_kpa', 3.0, m, { unit: 'bar' })),
      ...[5, 4, 3, 2, 1, 0].map((m) => r('oil_pressure_kpa', 1.0, m, { unit: 'bar' })),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'oil_pressure_kpa', min: 2.5, lookbackReadings: 10, requiredBreaches: 6 },
      readings: sustainedDip, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 1.0, direction: 'below', bound: 2.5, breaches: 6 });
  });

  it('4. a rule with both bounds fires on the upper bound only when it sustains, and names it', () => {
    const readings = [
      ...[9, 8, 7, 6].map((m) => r('coolant_temp_c', 95, m)),
      ...[5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 120, m)),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', min: 10, max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ direction: 'above', bound: 105, worstValue: 120, breaches: 6 });
  });

  it('5. fewer readings available than requiredBreaches does not fire, and the reason is recorded', () => {
    const readings = [r('coolant_temp_c', 200, 1), r('coolant_temp_c', 200, 0)];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();

    const [window] = signalWindows(readings, 'coolant_temp_c', 10, 6);
    expect(window.readings).toHaveLength(2);
    expect(window.skippedReason).toMatch(/only 2 reading\(s\) available.*at least 6/);
  });

  it('6. a partial window — fewer readings than the full lookback — still fires once enough of it breaches', () => {
    const readings = [4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 110, m));
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 4 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 110, readingsInWindow: 5, breaches: 5 });
  });

  it('7. unset lookbackReadings and requiredBreaches apply the defaults 10 and 6, and the evidence names both', () => {
    const readings = [
      ...[7, 6].map((m) => r('coolant_temp_c', 95, m)),
      ...[5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 120, m)),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ lookbackReadings: 10, requiredBreaches: 6, worstValue: 120, breaches: 6 });
  });

  it('8. lookbackReadings outside [1, 1000] is refused at write time; the boundary values are allowed', () => {
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 0 }))
      .toMatch(/lookback_readings has to be a whole number from 1 to 1000/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: -1 }))
      .toMatch(/lookback_readings has to be a whole number from 1 to 1000/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 1001 }))
      .toMatch(/lookback_readings has to be a whole number from 1 to 1000/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 3.5 }))
      .toMatch(/lookback_readings has to be a whole number/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 1 })).toBeNull();
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 1000 })).toBeNull();
  });

  it('8b. requiredBreaches below 1, non-integer, or above this rule\'s own lookbackReadings is refused; the boundary values are allowed', () => {
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: 0 }))
      .toMatch(/required_breaches has to be a whole number from 1 to this rule's lookback_readings \(10\)/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: -1 }))
      .toMatch(/required_breaches has to be a whole number/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: 2.5 }))
      .toMatch(/required_breaches has to be a whole number/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: 11 }))
      .toMatch(/required_breaches has to be a whole number from 1 to this rule's lookback_readings \(10\)/);
    // Unset lookbackReadings defaults to 10 for this same ceiling check.
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, requiredBreaches: 11 }))
      .toMatch(/to this rule's lookback_readings \(10\)/);
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: 1 })).toBeNull();
    expect(validateParams('signal-threshold', { signal: 'x', max: 1, lookbackReadings: 10, requiredBreaches: 10 })).toBeNull();
  });

  it('9. readings for the same signal on a different imei do not enter the window', () => {
    // imei A alone has only 2 readings — too few to ever reach requiredBreaches on
    // its own, and one of them breaches the bound. imei B reports the same signal,
    // at the same moments, with 8 clean readings. A buggy pool-everything
    // implementation would see 10 combined readings including the breach and
    // (depending on how many of those breach) could fire; grouped by imei, A's own
    // window stays at 2 and can never reach 6.
    const readingsA = [r('coolant_temp_c', 200, 1, { imei: 'A' }), r('coolant_temp_c', 90, 0, { imei: 'A' })];
    const readingsB = [9, 8, 7, 6, 5, 4, 3, 2].map((m) => r('coolant_temp_c', 90, m, { imei: 'B' }));

    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings: [...readingsA, ...readingsB], predictions: [],
    });
    expect(firing).toBeNull();

    const windows = signalWindows([...readingsA, ...readingsB], 'coolant_temp_c', 10, 6);
    const forA = windows.find((w) => w.imei === 'A')!;
    const forB = windows.find((w) => w.imei === 'B')!;
    expect(forA.readings).toHaveLength(2);
    expect(forB.readings).toHaveLength(8);
  });

  it('9b. a more recent reading from a different imei does not enter the window and cannot displace an older one from it', () => {
    // imei A's own last 10 readings are exactly the ones that should fire: four
    // clean, six breaching, with the oldest of the breaches at the OLDEST
    // position in the window. imei B reports one clean reading for the same
    // signal, more recent than anything of A's. A pool-everything implementation,
    // sorted purely by recency and capped at 10, would keep B's reading plus A's 9
    // most recent — dropping A's oldest breach — and go from 6 breaches to 5,
    // falling short of requiredBreaches. Grouped by imei, B never enters A's
    // window at all, and A's own 10 readings, all six breaches included, fire
    // exactly as they would with B absent.
    const readingsA = [
      r('coolant_temp_c', 120, 9, { imei: 'A' }),
      ...[8, 7, 6, 5].map((m) => r('coolant_temp_c', 95, m, { imei: 'A' })),
      ...[4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 120, m, { imei: 'A' })),
    ];
    const decoyB = r('coolant_temp_c', 10, -1, { imei: 'B' });

    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10, requiredBreaches: 6 },
      readings: [...readingsA, decoyB], predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 120, imei: 'A', breaches: 6 });

    const windows = signalWindows([...readingsA, decoyB], 'coolant_temp_c', 10, 6);
    const forA = windows.find((w) => w.imei === 'A')!;
    expect(forA.readings).toHaveLength(10);
    expect(forA.readings.some((reading) => reading.value === 10)).toBe(false);
  });

  describe('10. the plain-English render-back', () => {
    it('describes an upper bound', () => {
      expect(describeSignalThresholdRule(
        { signal: 'coolant_temp_c', max: 105 }, { displayName: 'coolant temperature', unit: 'degC' },
      )).toBe('Fires when at least 6 of the last 10 readings of coolant temperature rise above 105 degC.');
    });

    it('describes a lower bound', () => {
      expect(describeSignalThresholdRule(
        { signal: 'oil_pressure_kpa', min: 2.5 }, { displayName: 'oil pressure', unit: 'bar' },
      )).toBe('Fires when at least 6 of the last 10 readings of oil pressure fall below 2.5 bar.');
    });

    it('describes a rule carrying both bounds, with explicit lookbackReadings and requiredBreaches', () => {
      expect(describeSignalThresholdRule(
        { signal: 'coolant_temp_c', min: 60, max: 105, lookbackReadings: 5, requiredBreaches: 3 },
        { displayName: 'coolant temperature', unit: 'degC' },
      )).toBe(
        'Fires when at least 3 of the last 5 readings of coolant temperature rise above 105 degC, '
        + 'or at least 3 fall below 60 degC.',
      );
    });
  });
});
