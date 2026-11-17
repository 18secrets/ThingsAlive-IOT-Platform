import { evaluateRule, SignalThresholdParams, WindowReading } from '../src/alert/services/alert-rules';

/**
 * COS-4, raw decimals in alerts, as it came back through rated bounds (D59): a bound is
 * factor × rating, and 1.1 × 5.5 is 6.050000000000001 in floating point. The summary a
 * person reads, and the bound kept as evidence, carry the bound as it was meant.
 */
describe('alert summaries: a rated bound reads as the number it is', () => {
  const T0 = Date.parse('2026-11-09T10:00:00.000Z');
  const readings = (values: number[]): WindowReading[] => values.map((value, i) => ({
    signal: 'motor_current', value, unit: 'A', imei: 'imei-1', sourceTimestamp: new Date(T0 + i * 60_000).toISOString(),
  }));
  const fire = (params: SignalThresholdParams, rating: number, values: number[]) => evaluateRule({
    trigger: 'signal-threshold', params, readings: readings(values), predictions: [],
    ratings: new Map([['rated_current', { value: rating, unit: 'A' }]]),
  });

  it('1.1 × 5.5 A is "6.05 A" above, not 6.050000000000001', () => {
    const firing = fire({ signal: 'motor_current', rating: 'rated_current', max: 1.1, lookbackReadings: 3, requiredBreaches: 2 }, 5.5, [6.2, 6.3, 6.4]);
    expect(firing?.summary).toMatch(/breached 6\.05 A above/);
    expect(firing?.summary).not.toMatch(/0000000/);
    expect(firing?.evidence.bound).toBe(6.05);
  });

  it('a lower bound too: 0.9 × 3.3 A is 2.97, not 2.9699999999999998', () => {
    const firing = fire({ signal: 'motor_current', rating: 'rated_current', min: 0.9, lookbackReadings: 3, requiredBreaches: 2 }, 3.3, [2.5, 2.4, 2.6]);
    expect(firing?.summary).toMatch(/breached 2\.97 A below/);
    expect(firing?.evidence.bound).toBe(2.97);
  });

  it('a reading on the noise side of the bound is still judged against the exact product', () => {
    // 6.05 is not above 6.050000000000001 and not above 6.05 either: no alert either way.
    expect(fire({ signal: 'motor_current', rating: 'rated_current', max: 1.1, lookbackReadings: 3, requiredBreaches: 1 }, 5.5, [6.05, 6.05, 6.05])).toBeNull();
  });
});
