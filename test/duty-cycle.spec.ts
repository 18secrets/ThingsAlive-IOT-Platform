import {
  CARRY_FACTOR,
  DEFAULT_CARRY_SECONDS,
  DEFAULT_LOAD_THRESHOLD,
  MAX_CARRY_SECONDS,
  MIN_CARRY_SECONDS,
  carryFor,
  classify,
  computeDutyCycle,
} from '../src/utilization/services/duty-cycle';
import { SIGNALS } from '../src/common/signals';
import { WindowReading } from '../src/alert/services/alert-rules';

/**
 * Duty cycle from sampled status (task P4-05).
 *
 * The tests that matter here are the ones about time nobody observed. Every other
 * property of this function is arithmetic; the one that decides whether the report is
 * honest is what it does with a gap, and that is what most of this file is about.
 */

const START = new Date('2026-03-02T00:00:00Z');
const HOUR = 3600 * 1000;

const at = (offsetSeconds: number, signal: string, value: number, unit: string | null = null): WindowReading => ({
  signal,
  value,
  unit,
  sourceTimestamp: new Date(START.getTime() + offsetSeconds * 1000).toISOString(),
});

/** A machine reporting every minute for `minutes`, at a constant state. */
const steady = (minutes: number, signal: string, value: number, fromMinute = 0): WindowReading[] =>
  Array.from({ length: minutes }, (_, i) => at((fromMinute + i) * 60, signal, value));

const end = (hours: number) => new Date(START.getTime() + hours * HOUR);

describe('classify', () => {
  const snap = (entries: [string, number][]) => new Map(entries);

  it('says nothing when the machine said nothing', () => {
    expect(classify(snap([]), DEFAULT_LOAD_THRESHOLD)).toBe('unknown');
    // Load alone cannot decide: a load figure with no running status could be a stale
    // reading from a stopped engine, and inferring "on" from it would invent uptime.
    expect(classify(snap([[SIGNALS.engineLoad, 80]]), DEFAULT_LOAD_THRESHOLD)).toBe('unknown');
  });

  it('prefers running status over ignition', () => {
    // Key on, engine not turning. Not idling — idling is an engine burning fuel.
    expect(classify(
      snap([[SIGNALS.engineRunningStatus, 0], [SIGNALS.ignitionStatus, 1]]),
      DEFAULT_LOAD_THRESHOLD,
    )).toBe('off');
  });

  it('falls back to ignition when running status is absent', () => {
    expect(classify(snap([[SIGNALS.ignitionStatus, 1]]), DEFAULT_LOAD_THRESHOLD))
      .toBe('running-unclassified');
    expect(classify(snap([[SIGNALS.ignitionStatus, 0]]), DEFAULT_LOAD_THRESHOLD)).toBe('off');
  });

  it('lets the fleet\'s own utilization flag overrule an inference from load', () => {
    // A loaded engine the machine itself calls unutilized. The machine wins; the
    // threshold is our guess about its behaviour, and this is its report of it.
    expect(classify(
      snap([
        [SIGNALS.engineRunningStatus, 1],
        [SIGNALS.utilizationStatus, 0],
        [SIGNALS.engineLoad, 95],
      ]),
      DEFAULT_LOAD_THRESHOLD,
    )).toBe('idle');
  });

  it('reads load against the threshold when there is no utilization flag', () => {
    const running = (load: number) => classify(
      snap([[SIGNALS.engineRunningStatus, 1], [SIGNALS.engineLoad, load]]),
      DEFAULT_LOAD_THRESHOLD,
    );
    expect(running(DEFAULT_LOAD_THRESHOLD)).toBe('productive');
    expect(running(DEFAULT_LOAD_THRESHOLD - 0.1)).toBe('idle');
  });

  it('admits it cannot tell working from idling when nothing reports either', () => {
    expect(classify(snap([[SIGNALS.engineRunningStatus, 1]]), DEFAULT_LOAD_THRESHOLD))
      .toBe('running-unclassified');
  });
});

describe('carryFor', () => {
  it('uses the default when there is nothing to measure a cadence from', () => {
    expect(carryFor([])).toBe(DEFAULT_CARRY_SECONDS);
    expect(carryFor([1000])).toBe(DEFAULT_CARRY_SECONDS);
  });

  it('takes the median so one outage cannot enlarge its own tolerance', () => {
    // Four one-minute gaps and one six-hour hole. A mean would return well over the
    // cap and let the hole describe itself as uptime.
    const times = [0, 60, 120, 180, 240, 240 + 6 * 3600].map((s) => s * 1000);
    expect(carryFor(times)).toBe(60 * CARRY_FACTOR);
  });

  it('clamps at both ends', () => {
    const every = (seconds: number) =>
      carryFor([0, seconds, seconds * 2, seconds * 3].map((s) => s * 1000));
    expect(every(1)).toBe(MIN_CARRY_SECONDS);
    expect(every(3600)).toBe(MAX_CARRY_SECONDS);
  });

  it('honours an explicit override', () => {
    expect(carryFor([0, 60_000], { carrySeconds: 42 })).toBe(42);
  });
});

describe('computeDutyCycle', () => {
  it('attributes a fully reported shift with nothing left over', () => {
    const readings = [
      ...steady(60, SIGNALS.engineRunningStatus, 1),
      ...steady(60, SIGNALS.utilizationStatus, 1),
    ];
    const duty = computeDutyCycle(readings, START, end(1));

    expect(duty.totalSeconds).toBe(3600);
    // Every second of it, with nothing unobserved: the last sample lands at minute
    // 59 and its carry covers the remaining minute, clipped at the window's end.
    expect(duty.productiveSeconds).toBe(3600);
    expect(duty.unknownSeconds).toBe(0);
    expect(
      duty.productiveSeconds + duty.idleSeconds + duty.runningUnclassifiedSeconds
      + duty.offSeconds + duty.unknownSeconds,
    ).toBe(duty.totalSeconds);
  });

  it('refuses to let one sample describe an outage', () => {
    // The failure this whole module exists to prevent: one `running` sample, then the
    // logger drops off the network for the rest of the shift.
    const duty = computeDutyCycle(
      [at(0, SIGNALS.engineRunningStatus, 1), at(0, SIGNALS.utilizationStatus, 1)],
      START,
      end(8),
    );

    expect(duty.productiveSeconds).toBe(DEFAULT_CARRY_SECONDS);
    expect(duty.unknownSeconds).toBe(8 * 3600 - DEFAULT_CARRY_SECONDS);
    expect(duty.coverage).toBeLessThan(0.02);
    // And the rate is still 1: it worked for every second anybody watched. The
    // thinness is in `coverage`, where a caller can act on it, rather than smuggled
    // into the rate where it would read as an idle machine.
    expect(duty.utilizationRate).toBe(1);
  });

  it('calls an unreported shift unknown rather than off', () => {
    const duty = computeDutyCycle([], START, end(8));
    expect(duty.unknownSeconds).toBe(8 * 3600);
    expect(duty.offSeconds).toBe(0);
    expect(duty.coverage).toBe(0);
    expect(duty.utilizationRate).toBeNull();
    expect(duty.productiveRate).toBeNull();
  });

  it('separates the shift the machine slept through from the one it missed', () => {
    const slept = computeDutyCycle(steady(480, SIGNALS.engineRunningStatus, 0), START, end(8));
    expect(slept.offSeconds).toBeGreaterThan(8 * 3600 * 0.99);
    expect(slept.utilizationRate).toBe(0);
    expect(slept.coverage).toBeGreaterThan(0.99);
    // Both are "no productive hours". Only one of them is a fact about the machine.
    const missed = computeDutyCycle([], START, end(8));
    expect(missed.utilizationRate).toBeNull();
  });

  it('splits a shift that started working and then stopped', () => {
    const readings = [
      ...steady(120, SIGNALS.engineRunningStatus, 1),
      ...steady(120, SIGNALS.utilizationStatus, 1),
      ...steady(120, SIGNALS.engineRunningStatus, 0, 120),
      ...steady(120, SIGNALS.utilizationStatus, 0, 120),
    ];
    const duty = computeDutyCycle(readings, START, end(4));

    expect(duty.productiveSeconds).toBe(120 * 60);
    expect(duty.offSeconds).toBeGreaterThan(119 * 60);
    expect(duty.utilizationRate).toBeCloseTo(0.5, 2);
    expect(duty.productiveRate).toBe(1);
  });

  it('keeps idling apart from working, which is the number the customer is paying for', () => {
    const readings = [
      ...steady(240, SIGNALS.engineRunningStatus, 1),
      ...steady(60, SIGNALS.engineLoad, 70),
      ...steady(180, SIGNALS.engineLoad, 3, 60),
    ];
    const duty = computeDutyCycle(readings, START, end(4));

    expect(duty.productiveSeconds).toBe(60 * 60);
    expect(duty.idleSeconds).toBeGreaterThan(179 * 60);
    expect(duty.idleRate).toBeGreaterThan(0.74);
    expect(duty.runningUnclassifiedSeconds).toBe(0);
  });

  it('does not invent idling for a fleet that reports no load signal', () => {
    const duty = computeDutyCycle(steady(240, SIGNALS.engineRunningStatus, 1), START, end(4));
    expect(duty.runningUnclassifiedSeconds).toBeGreaterThan(239 * 60);
    expect(duty.idleSeconds).toBe(0);
    expect(duty.productiveSeconds).toBe(0);
    // It ran all shift. How much of that was work is a question this fleet cannot
    // answer, and the rate says so rather than guessing.
    expect(duty.utilizationRate).toBe(1);
    expect(duty.productiveRate).toBeNull();
  });

  it('expires a stale signal without discarding the fresh ones around it', () => {
    // Running status every minute; the utilization flag reported once and never again.
    const readings = [
      ...steady(60, SIGNALS.engineRunningStatus, 1),
      at(0, SIGNALS.utilizationStatus, 1),
    ];
    const duty = computeDutyCycle(readings, START, end(1));

    // Productive only while the flag was still entitled to speak; running-unclassified
    // after that, because the engine was demonstrably on and nothing said what it was
    // doing. Carrying the old flag forward would bill the whole hour as work.
    expect(duty.productiveSeconds).toBeGreaterThan(0);
    expect(duty.productiveSeconds).toBeLessThanOrEqual(180);
    expect(duty.runningUnclassifiedSeconds).toBeGreaterThan(0);
    // And no minute is lost between the two: a signal going stale hands the shift
    // over to the ones still reporting rather than punching a hole in it.
    expect(duty.engineOnSeconds).toBe(3600);
  });

  it('leaves the head of the shift unknown rather than extrapolating backwards', () => {
    const duty = computeDutyCycle(steady(50, SIGNALS.engineRunningStatus, 0, 10), START, end(1));
    expect(duty.unknownSeconds).toBeGreaterThanOrEqual(600);
    expect(duty.offSeconds).toBeGreaterThan(49 * 60);
  });

  it('ignores readings that fall outside the window', () => {
    const before: WindowReading = {
      signal: SIGNALS.engineRunningStatus,
      value: 1,
      unit: null,
      sourceTimestamp: new Date(START.getTime() - HOUR).toISOString(),
    };
    const duty = computeDutyCycle([before], START, end(1));
    expect(duty.samples).toBe(0);
    expect(duty.unknownSeconds).toBe(3600);
  });

  it('ignores signals it has no opinion about', () => {
    const duty = computeDutyCycle(
      [...steady(60, SIGNALS.engineRunningStatus, 1), ...steady(60, SIGNALS.coolantTemperature, 88)],
      START, end(1),
    );
    expect(duty.signalsPresent).toEqual([SIGNALS.engineRunningStatus]);
  });

  it('reports the hour meter delta in the unit it arrived in', () => {
    const duty = computeDutyCycle(
      [
        ...steady(60, SIGNALS.engineRunningStatus, 1),
        at(0, SIGNALS.engineRuntime, 1200.0, 'h'),
        at(3000, SIGNALS.engineRuntime, 1200.8, 'h'),
      ],
      START, end(1),
    );
    expect(duty.runtimeDelta).toBeCloseTo(0.8, 5);
    expect(duty.runtimeUnit).toBe('h');
    expect(duty.runtimeCounterReset).toBe(false);
  });

  it('refuses a negative hour meter delta and says why', () => {
    // A replaced logger, not four hundred hours of un-worked time credited back.
    const duty = computeDutyCycle(
      [at(0, SIGNALS.engineRuntime, 1200, 'h'), at(3000, SIGNALS.engineRuntime, 4, 'h')],
      START, end(1),
    );
    expect(duty.runtimeDelta).toBeNull();
    expect(duty.runtimeCounterReset).toBe(true);
  });

  it('keeps the hour meter out of the timeline', () => {
    // A runtime sample is not a status report, so it must not create coverage.
    const duty = computeDutyCycle(
      [at(0, SIGNALS.engineRuntime, 10, 'h'), at(1800, SIGNALS.engineRuntime, 10.5, 'h')],
      START, end(1),
    );
    expect(duty.unknownSeconds).toBe(3600);
    expect(duty.coverage).toBe(0);
    expect(duty.runtimeDelta).toBeCloseTo(0.5, 5);
  });

  it('handles a zero-length window without dividing by it', () => {
    const duty = computeDutyCycle([], START, START);
    expect(duty.totalSeconds).toBe(0);
    expect(duty.coverage).toBe(0);
    expect(duty.utilizationRate).toBeNull();
  });
});
