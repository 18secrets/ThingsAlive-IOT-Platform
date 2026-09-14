import {
  HIGH_AGREEMENT,
  MIN_COVERAGE,
  MIN_ENGINE_ON_SECONDS,
  MIN_WINDOWS,
  SECONDS_PER_UNIT,
  calibrateRuntimeUnit,
  meterToHours,
  unitForRatio,
  CalibrationWindow,
  RuntimeUnit,
} from '../src/service/services/runtime-unit';

/**
 * Calibrating the hour meter against the duty cycle (task P4-07).
 *
 * The tests worth having here are the refusals. Getting the right unit from clean
 * data is arithmetic; the question that decides whether a service schedule can be
 * built on this is what the function does when the data cannot support an answer.
 */

const EIGHT_HOURS = 8 * 3600;

/** A well-observed shift whose meter advanced by the right amount for `unit`. */
const window = (
  unit: RuntimeUnit,
  engineOnSeconds = EIGHT_HOURS,
  overrides: Partial<CalibrationWindow> = {},
): CalibrationWindow => ({
  engineOnSeconds,
  coverage: 1,
  runtimeDelta: engineOnSeconds / SECONDS_PER_UNIT[unit],
  runtimeCounterReset: false,
  ...overrides,
});

const many = (n: number, unit: RuntimeUnit, overrides: Partial<CalibrationWindow> = {}) =>
  Array.from({ length: n }, () => window(unit, EIGHT_HOURS, overrides));

describe('unitForRatio', () => {
  it('recognises each unit from its exact ratio', () => {
    expect(unitForRatio(1 / 3600)).toBe('hours');
    expect(unitForRatio(1 / 60)).toBe('minutes');
    expect(unitForRatio(1)).toBe('seconds');
  });

  it('allows a quarter either side, relative to the unit', () => {
    // A relative tolerance, because a quarter of 1/3600 and a quarter of 1 are wildly
    // different absolute distances. An absolute one would make hours unreachable and
    // seconds indiscriminate.
    expect(unitForRatio(1.2 / 3600)).toBe('hours');
    expect(unitForRatio(0.8 / 3600)).toBe('hours');
    expect(unitForRatio(1.5 / 3600)).toBeNull();
  });

  it('refuses a ratio that is near nothing', () => {
    // A meter counting kilometres, or a mis-mapped signal. Snapping to the nearest
    // unit would bury the evidence under a plausible number.
    expect(unitForRatio(1 / 400)).toBeNull();
    expect(unitForRatio(0)).toBeNull();
    expect(unitForRatio(-1)).toBeNull();
    expect(unitForRatio(Number.NaN)).toBeNull();
  });
});

describe('calibrateRuntimeUnit', () => {
  it.each(['hours', 'minutes', 'seconds'] as RuntimeUnit[])(
    'reads a fleet reporting in %s', (unit) => {
      const c = calibrateRuntimeUnit(many(10, unit));
      expect(c.unit).toBe(unit);
      expect(c.confidence).toBe('high');
      expect(c.agreement).toBe(1);
      expect(c.usable).toBe(10);
    },
  );

  it('tolerates ordinary noise between the meter and the measurement', () => {
    // The two never agree exactly: the meter ticks at its own resolution and the
    // status signals are sampled. A calibration that needed them equal would never fire.
    const noisy = Array.from({ length: 12 }, (_, i) => ({
      ...window('hours'),
      runtimeDelta: (EIGHT_HOURS / 3600) * (1 + (i % 5 - 2) * 0.03),
    }));
    expect(calibrateRuntimeUnit(noisy)).toMatchObject({ unit: 'hours', confidence: 'high' });
  });

  it('ignores a poorly observed window, where the two numbers are not comparable', () => {
    // The meter counts through an outage; the status signals do not. So half a shift
    // of coverage reports half the engine-on seconds against a full delta, and the
    // ratio is inflated by an arbitrary amount.
    const thin = many(10, 'hours').map((w) => ({ ...w, coverage: MIN_COVERAGE - 0.01 }));
    expect(calibrateRuntimeUnit(thin)).toMatchObject({
      unit: null, confidence: 'none', reason: 'no-usable-windows', usable: 0, considered: 10,
    });
  });

  it('ignores a window too short for the meter\'s own rounding', () => {
    const brief = many(10, 'hours').map(() => window('hours', MIN_ENGINE_ON_SECONDS - 1));
    expect(calibrateRuntimeUnit(brief).reason).toBe('no-usable-windows');
  });

  it('ignores a reset meter and a delta that cannot be one', () => {
    const bad: CalibrationWindow[] = [
      { ...window('hours'), runtimeCounterReset: true },
      { ...window('hours'), runtimeDelta: null },
      { ...window('hours'), runtimeDelta: 0 },
      { ...window('hours'), runtimeDelta: -4 },
    ];
    expect(calibrateRuntimeUnit(bad)).toMatchObject({ usable: 0, considered: 4 });
  });

  it('will not convert a maintenance schedule on the strength of four shifts', () => {
    const few = calibrateRuntimeUnit(many(MIN_WINDOWS - 1, 'hours'));
    expect(few.unit).toBeNull();
    expect(few.reason).toBe('too-few-windows');
    // The ratio is still reported. It is probably right; it is just not yet something
    // to act on, and hiding it would make the wait unexplainable.
    expect(few.medianRatio).toBeCloseTo(1 / 3600, 8);
  });

  it('says so when the meter is counting something that is not time', () => {
    const odd = many(10, 'hours').map(() => ({
      ...window('hours'), runtimeDelta: EIGHT_HOURS / 400,
    }));
    expect(calibrateRuntimeUnit(odd)).toMatchObject({
      unit: null, confidence: 'none', reason: 'no-unit-matches',
    });
  });

  it('refuses a fleet split between two conventions rather than averaging across it', () => {
    // Half in hours and half in minutes. A median lands between them and is right for
    // nobody — which is the failure this reason code exists to name.
    const split = [...many(6, 'hours'), ...many(6, 'minutes')];
    const c = calibrateRuntimeUnit(split);
    expect(c.unit).toBeNull();
    expect(c.reason).toBe('disagreement');
  });

  it('reports low confidence when a minority disagrees', () => {
    // Eight in hours, one odd. The median is firmly hours, but something in the fleet
    // does not match and a caller should be able to see that before trusting it.
    const mostly = [
      ...many(8, 'hours'),
      { ...window('hours'), runtimeDelta: EIGHT_HOURS / 400 },
    ];
    const c = calibrateRuntimeUnit(mostly);
    expect(c.unit).toBe('hours');
    expect(c.confidence).toBe('low');
    expect(c.agreement).toBeLessThan(HIGH_AGREEMENT);
  });

  it('counts what it kept and what it was given', () => {
    const mixed = [...many(6, 'seconds'), ...many(4, 'seconds').map((w) => ({ ...w, coverage: 0.2 }))];
    const c = calibrateRuntimeUnit(mixed);
    expect(c).toMatchObject({ unit: 'seconds', usable: 6, considered: 10 });
  });

  it('says nothing at all about an empty fleet', () => {
    expect(calibrateRuntimeUnit([])).toMatchObject({
      unit: null, confidence: 'none', reason: 'no-usable-windows', usable: 0, considered: 0,
      medianRatio: null, agreement: null,
    });
  });
});

describe('meterToHours', () => {
  it('converts each unit to the hours a service interval is written in', () => {
    expect(meterToHours(250, 'hours')).toBe(250);
    expect(meterToHours(250 * 60, 'minutes')).toBe(250);
    expect(meterToHours(250 * 3600, 'seconds')).toBe(250);
  });
});
