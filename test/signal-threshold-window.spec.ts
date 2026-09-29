import {
  describeSignalThresholdRule, evaluateRule, signalWindows, validateParams, WindowReading,
} from '../src/alert/services/alert-rules';

/**
 * A signal-threshold rule's window (task QALERT1, D34).
 *
 * At 30-60s sampling, comparing every single reading on its own raised an alert on
 * one noisy sample. This reduces the last N readings by source_timestamp to one
 * number before comparing to the bound — long enough to absorb a spike, short
 * enough not to delay a real excursion. Follows QL1's pattern: every rule in the
 * decision gets a test that attempts exactly the behaviour it describes.
 */
const BASE = new Date('2026-09-14T07:00:00.000Z').getTime();
/** `minutesAgo` reads naturally against "the last N readings" — 0 is the most
 * recent, larger numbers are older. */
const at = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000).toISOString();
const r = (
  signal: string, value: number, minutesAgo: number, extra: Partial<WindowReading> = {},
): WindowReading => ({ signal, value, unit: 'degC', sourceTimestamp: at(minutesAgo), ...extra });

describe('the signal-threshold window', () => {
  it('1. nine readings below the bound and a spike within the window fires — the window catches it, it does not hide it', () => {
    const readings = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 5),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 120, direction: 'above', bound: 105 });
  });

  it('2. the same spike, moved to the 11th-most-recent reading, does not fire — the window moved past it', () => {
    const readings = [
      ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 10),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();
  });

  it('3. a lower bound fires on the minimum of the window', () => {
    const readings = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('oil_pressure_kpa', 3.0, m, { unit: 'bar' })),
      r('oil_pressure_kpa', 1.0, 5, { unit: 'bar' }),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'oil_pressure_kpa', min: 2.5, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 1.0, direction: 'below', bound: 2.5 });
  });

  it('4. a rule with both bounds fires on the upper bound only when there is no low dip, and names it', () => {
    const readings = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 5),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold',
      params: { signal: 'coolant_temp_c', min: 10, max: 105, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ direction: 'above', bound: 105, worstValue: 120 });
  });

  it('5. fewer than 3 readings available does not fire, and the reason is recorded', () => {
    const readings = [r('coolant_temp_c', 200, 1), r('coolant_temp_c', 200, 0)];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing).toBeNull();

    const [window] = signalWindows(readings, 'coolant_temp_c', 10);
    expect(window.readings).toHaveLength(2);
    expect(window.skippedReason).toMatch(/only 2 reading\(s\) available.*at least 3/);
  });

  it('6. a partial window of 5 readings, all above the bound, still fires', () => {
    const readings = [4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 110, m));
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 110, readingsInWindow: 5 });
  });

  it('7. an unset lookbackReadings applies the default of 10, and the evidence names the number actually used', () => {
    const readings = [
      ...[9, 8, 7, 6, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m)),
      r('coolant_temp_c', 120, 5),
    ];
    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105 },
      readings, predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ lookbackReadings: 10, worstValue: 120 });
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

  it('9. readings for the same signal on a different imei do not enter the window', () => {
    // imei A alone has only 2 readings — too short to fire on its own, and one of
    // them breaches the bound. imei B reports the same signal, at the same
    // moments, with 8 clean readings. A buggy pool-everything implementation would
    // see 10 combined readings (enough to clear the 3-reading floor) including the
    // breach, and fire; grouped by imei, A's own window stays at 2 and stays quiet.
    const readingsA = [r('coolant_temp_c', 200, 1, { imei: 'A' }), r('coolant_temp_c', 90, 0, { imei: 'A' })];
    const readingsB = [9, 8, 7, 6, 5, 4, 3, 2].map((m) => r('coolant_temp_c', 90, m, { imei: 'B' }));

    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings: [...readingsA, ...readingsB], predictions: [],
    });
    expect(firing).toBeNull();

    const windows = signalWindows([...readingsA, ...readingsB], 'coolant_temp_c', 10);
    const forA = windows.find((w) => w.imei === 'A')!;
    const forB = windows.find((w) => w.imei === 'B')!;
    expect(forA.readings).toHaveLength(2);
    expect(forB.readings).toHaveLength(8);
  });

  it('9b. a more recent reading from a different imei does not enter the window and cannot displace an older one from it', () => {
    // imei A's own last 10 readings are exactly the ones that should fire: nine
    // clean, one spike at the OLDEST position. imei B reports one clean reading
    // for the same signal, more recent than anything of A's. A pool-everything
    // implementation, sorted purely by recency and capped at 10, would keep B's
    // reading plus A's 9 most recent — dropping A's oldest, which is the spike —
    // and go quiet. Grouped by imei, B never enters A's window at all, and A's own
    // 10 readings, spike included, fire exactly as they would with B absent.
    const readingsA = [
      r('coolant_temp_c', 120, 9, { imei: 'A' }),
      ...[8, 7, 6, 5, 4, 3, 2, 1, 0].map((m) => r('coolant_temp_c', 95, m, { imei: 'A' })),
    ];
    const decoyB = r('coolant_temp_c', 10, -1, { imei: 'B' });

    const firing = evaluateRule({
      trigger: 'signal-threshold', params: { signal: 'coolant_temp_c', max: 105, lookbackReadings: 10 },
      readings: [...readingsA, decoyB], predictions: [],
    });
    expect(firing!.evidence).toMatchObject({ worstValue: 120, imei: 'A' });

    const windows = signalWindows([...readingsA, decoyB], 'coolant_temp_c', 10);
    const forA = windows.find((w) => w.imei === 'A')!;
    expect(forA.readings).toHaveLength(10);
    expect(forA.readings.some((reading) => reading.value === 10)).toBe(false);
  });

  describe('10. the plain-English render-back', () => {
    it('describes an upper bound', () => {
      expect(describeSignalThresholdRule(
        { signal: 'coolant_temp_c', max: 105 }, { displayName: 'coolant temperature', unit: 'degC' },
      )).toBe('Fires when the highest of the last 10 readings of coolant temperature rises above 105 degC.');
    });

    it('describes a lower bound', () => {
      expect(describeSignalThresholdRule(
        { signal: 'oil_pressure_kpa', min: 2.5 }, { displayName: 'oil pressure', unit: 'bar' },
      )).toBe('Fires when the lowest of the last 10 readings of oil pressure falls below 2.5 bar.');
    });

    it('describes a rule carrying both bounds', () => {
      expect(describeSignalThresholdRule(
        { signal: 'coolant_temp_c', min: 60, max: 105, lookbackReadings: 5 },
        { displayName: 'coolant temperature', unit: 'degC' },
      )).toBe(
        'Fires when the highest of the last 5 readings of coolant temperature rises above 105 degC, '
        + 'or the lowest falls below 60 degC.',
      );
    });
  });
});
