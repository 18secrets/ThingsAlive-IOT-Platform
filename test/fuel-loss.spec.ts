import { detectFuelLoss, validateFuelLoss } from '../src/alert/services/fuel-loss';
import { evaluateRule } from '../src/alert/services/alert-rules';
import { SIGNALS } from '../src/common/signals';

/**
 * Fuel leaving a machine that was not running (task P4-04).
 *
 * First in Things Alive's build order because it needs nothing — no baseline, no
 * model, no history. Every clause of the conjunction is load-bearing, and each test
 * below removes exactly one of them.
 */
const at = (minutes: number) =>
  new Date(new Date('2026-09-14T22:00:00Z').getTime() + minutes * 60_000).toISOString();

const r = (signal: string, value: number, minutes: number) =>
  ({ signal, value, unit: null, sourceTimestamp: at(minutes) });

const PARKED = [
  r(SIGNALS.ignitionStatus, 0, 0), r(SIGNALS.ignitionStatus, 0, 30),
  r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 12.9716, 30),
  r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.5946, 30),
];

const RULE = { dropAtLeast: 20, withinMinutes: 60 };

describe('detecting fuel loss', () => {
  it('catches a tank emptying overnight with the key out', () => {
    const finding = detectFuelLoss([
      ...PARKED, r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);

    expect(finding).toMatchObject({ droppedBy: 85, overMinutes: 30 });
    // The evidence is the point: somebody is going to be accused of something.
    expect(finding!.from).toMatchObject({ value: 180 });
    expect(finding!.to).toMatchObject({ value: 95 });
  });

  it('says nothing about fuel the engine was burning', () => {
    // Fuel falling while the engine runs is the engine. Without this clause the rule
    // fires on every working shift and nobody reads it again.
    const finding = detectFuelLoss([
      r(SIGNALS.ignitionStatus, 1, 15),
      r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 12.9716, 30),
      r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.5946, 30),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);
    expect(finding).toBeNull();
  });

  it('treats engine_running_status as proof the engine was on, like ignition', () => {
    const finding = detectFuelLoss([
      r(SIGNALS.engineRunningStatus, 1, 15),
      r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 12.9716, 30),
      r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.5946, 30),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);
    expect(finding).toBeNull();
  });

  it('says nothing about a machine that moved', () => {
    // Fuel falling while a machine moves is a refuelling stop, a different tank, or a
    // sloshing sender producing level readings that were never true.
    const finding = detectFuelLoss([
      r(SIGNALS.ignitionStatus, 0, 0), r(SIGNALS.ignitionStatus, 0, 30),
      r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 13.4200, 30),
      r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.5946, 30),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);
    expect(finding).toBeNull();
  });

  it('tolerates a parked machine\'s GPS wandering', () => {
    // A stationary receiver drifts by tens of metres. A zero tolerance is a rule that
    // never fires.
    const finding = detectFuelLoss([
      r(SIGNALS.ignitionStatus, 0, 0), r(SIGNALS.ignitionStatus, 0, 30),
      r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 12.97162, 30),
      r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.59461, 30),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);
    expect(finding).not.toBeNull();
  });

  it('will not call a fleet with no GPS stationary for free', () => {
    // Absent position is not the same as not having moved, and treating it as such
    // turns a three-clause rule into a two-clause one without anybody choosing that.
    const finding = detectFuelLoss([
      r(SIGNALS.ignitionStatus, 0, 0), r(SIGNALS.ignitionStatus, 0, 30),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30),
    ], RULE);
    expect(finding).toBeNull();
  });

  it('ignores ordinary consumption spread across a shift', () => {
    // Eighty litres over eight hours is a working day. The same eighty in half an hour
    // is not, and the window is the whole difference.
    const readings = [
      r(SIGNALS.ignitionStatus, 0, 0), r(SIGNALS.ignitionStatus, 0, 480),
      r(SIGNALS.latitude, 12.9716, 0), r(SIGNALS.latitude, 12.9716, 480),
      r(SIGNALS.longitude, 77.5946, 0), r(SIGNALS.longitude, 77.5946, 480),
      r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 100, 480),
    ];
    expect(detectFuelLoss(readings, RULE)).toBeNull();
  });

  it('catches a careful thief taking it in small steps', () => {
    // A siphon shows up as a sequence of small drops as often as one large one. A rule
    // that only compares neighbours misses exactly the person being careful.
    const finding = detectFuelLoss([
      ...PARKED, r(SIGNALS.ignitionStatus, 0, 45),
      r(SIGNALS.latitude, 12.9716, 45), r(SIGNALS.longitude, 77.5946, 45),
      r(SIGNALS.fuelLevel, 180, 0),
      r(SIGNALS.fuelLevel, 172, 15),
      r(SIGNALS.fuelLevel, 163, 30),
      r(SIGNALS.fuelLevel, 152, 45),
    ], RULE);
    expect(finding).toMatchObject({ droppedBy: 28, overMinutes: 45 });
  });

  it('reports the worst drop when there are several', () => {
    const finding = detectFuelLoss([
      ...PARKED, r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 150, 10),
      r(SIGNALS.fuelLevel, 60, 30),
    ], RULE);
    expect(finding!.droppedBy).toBe(120);
  });

  it('is reachable as an alert rule', () => {
    const firing = evaluateRule({
      trigger: 'fuel-loss', params: RULE, predictions: [],
      readings: [...PARKED, r(SIGNALS.fuelLevel, 180, 0), r(SIGNALS.fuelLevel, 95, 30)],
    });
    expect(firing!.summary).toMatch(/85 of fuel gone in 30 minutes/);
    expect(firing!.evidence).toMatchObject({ droppedBy: 85 });
  });

  describe('what a rule must say', () => {
    it('refuses a window long enough to measure a working day', () => {
      // Over a long enough window every machine loses fuel, and the rule stops
      // describing theft.
      expect(validateFuelLoss({ dropAtLeast: 20, withinMinutes: 2000 }))
        .toMatch(/consumption rather than theft/);
    });

    it('refuses a rule with no threshold to cross', () => {
      expect(validateFuelLoss({ dropAtLeast: 0, withinMinutes: 60 })).toMatch(/worth investigating/);
      expect(validateFuelLoss({ dropAtLeast: 20, withinMinutes: 0 })).toMatch(/window to measure/);
    });
  });
});
