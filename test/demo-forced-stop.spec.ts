import { forcedStop, running } from '../src/database/seeds/seed-demo';

/**
 * The live demo stream forces machines running; that ran every machine round the clock
 * and gave every Production card identical hours (test report MIN-14). Under it each
 * machine now has a daily stop of its own.
 */
describe('forced-running demo machines', () => {
  const HOUR = 3_600_000;
  const day = Date.UTC(2026, 9, 30);
  const hoursStopped = (id: string) => Array.from({ length: 24 }, (_, h) => forcedStop(id, day + h * HOUR)).filter(Boolean).length;

  it('each machine stops 0–4 hours a day, so machines differ', () => {
    const stops = ['EX-01', 'EX-02', 'EX-03', 'EX-04', 'EX-05', 'EX-10', 'EX-12', 'EX-14'].map(hoursStopped);
    expect(stops.every((h) => h >= 0 && h <= 4)).toBe(true);
    expect(new Set(stops).size).toBeGreaterThan(2);
  });

  it('only while forced, and only when the machine is named; the seed\'s own shift schedule is unchanged', () => {
    const before = process.env.DEMO_FORCE_RUNNING;
    try {
      process.env.DEMO_FORCE_RUNNING = 'true';
      const stopHour = Array.from({ length: 24 }, (_, h) => day + h * HOUR).find((t) => forcedStop('EX-04', t))!;
      expect(running(stopHour, 'EX-04')).toBe(false);
      expect(running(stopHour)).toBe(true);
      delete process.env.DEMO_FORCE_RUNNING;
      expect(running(stopHour, 'EX-04')).toBe(running(stopHour));
    } finally {
      if (before === undefined) delete process.env.DEMO_FORCE_RUNNING; else process.env.DEMO_FORCE_RUNNING = before;
    }
  });
});
