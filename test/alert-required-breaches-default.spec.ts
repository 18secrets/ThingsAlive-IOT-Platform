import {
  DEFAULT_REQUIRED_BREACHES, describeSignalThresholdRule, evaluateRule, requiredBreachesOf, validateParams,
} from '../src/alert/services/alert-rules';

/**
 * A rule that names a short window and no count (17 Nov 2026, the AI alert prompt test
 * log): "the last 3 readings" with the default of six breaches was saved, described as
 * "at least 6 of the last 3 readings", and could never fire. The default is now six or
 * the whole window, whichever is smaller; an explicit count above the window is still
 * refused.
 */
describe('signal threshold: the default breaches never exceed the window', () => {
  const readings = (values: number[]) => values.map((value, i) => ({
    signal: 'slew_drive_temperature', value, sourceTimestamp: new Date(Date.UTC(2026, 10, 17, 10, i)).toISOString(), imei: 'IMEI-1',
  }));
  const fire = (params: Record<string, unknown>, values: number[]) => evaluateRule({
    trigger: 'signal-threshold', params: { signal: 'slew_drive_temperature', ...params } as never, readings: readings(values), predictions: [],
  });

  it('a window of 3 with no count needs all 3, and fires when all 3 breach', () => {
    expect(requiredBreachesOf({ lookbackReadings: 3 })).toBe(3);
    expect(fire({ max: 80, lookbackReadings: 3 }, [85, 86, 87])).not.toBeNull();
  });

  it('a window of 3 with only 2 breaching does not fire', () => {
    expect(fire({ max: 80, lookbackReadings: 3 }, [85, 70, 87])).toBeNull();
  });

  it('describes what it will do, not "6 of the last 3"', () => {
    expect(describeSignalThresholdRule({ signal: 'slew_drive_temperature', max: 80, lookbackReadings: 3 }, { displayName: 'slew drive temperature', unit: 'degC' }))
      .toMatch(/at least 3 of the last 3 readings/);
  });

  it('the usual default is unchanged: 6 of 10', () => {
    expect(requiredBreachesOf({})).toBe(DEFAULT_REQUIRED_BREACHES);
    expect(requiredBreachesOf({ lookbackReadings: 10 })).toBe(6);
    expect(requiredBreachesOf({ lookbackReadings: 3, requiredBreaches: 2 })).toBe(2);
  });

  it('an explicit count above the window is still refused', () => {
    expect(validateParams('signal-threshold', { signal: 'slew_drive_temperature', max: 80, lookbackReadings: 3, requiredBreaches: 6 } as never))
      .toMatch(/required_breaches has to be a whole number from 1 to this rule's lookback_readings \(3\)/);
  });
});
