import { MAX_BUCKETS_OVERRIDE, pickBucketSeconds } from '../src/kpi/services/bucketing';

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The bucket-size ladder (task QCE2.1 §2) — one deterministic rule, not a
 * per-chart guess, targeting roughly 120 points and never exceeding 200.
 */
describe('bucket-size ladder', () => {
  it('a 12-hour window gives 5-minute buckets (144 points)', () => {
    const seconds = pickBucketSeconds(12 * HOUR);
    expect(seconds).toBe(5 * 60);
    expect(Math.ceil(12 * HOUR / seconds)).toBe(144);
  });

  it('a 7-day window gives 1-hour buckets (168 points)', () => {
    const seconds = pickBucketSeconds(7 * DAY);
    expect(seconds).toBe(HOUR);
    expect(Math.ceil(7 * DAY / seconds)).toBe(168);
  });

  it('a 30-day window gives 6-hour buckets (120 points)', () => {
    const seconds = pickBucketSeconds(30 * DAY);
    expect(seconds).toBe(6 * HOUR);
    expect(Math.ceil(30 * DAY / seconds)).toBe(120);
  });

  it('an explicit override is honoured when it stays under the 1000-point ceiling', () => {
    expect(pickBucketSeconds(12 * HOUR, 60)).toBe(60); // 720 points, allowed
  });

  it('an explicit override producing more than 1000 points is refused, naming the count, not truncated', () => {
    expect(() => pickBucketSeconds(30 * DAY, 60)).toThrow(/43200 points/);
    expect(() => pickBucketSeconds(30 * DAY, 60)).toThrow(new RegExp(`limit is ${MAX_BUCKETS_OVERRIDE}`));
  });
});
