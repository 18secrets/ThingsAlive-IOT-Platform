import { SIGNALS } from '../../common/signals';
import { WindowReading } from './alert-rules';

/**
 * Fuel leaving a machine that was not running (task P4-04).
 *
 * First in Things Alive's build order, and it earns the place: it is a pure rule with
 * no baseline, no model and no history, and on a genset or plant fleet it is the
 * highest-value thing the telemetry can say.
 *
 * The rule is a conjunction, and every clause is load-bearing:
 *
 *  - Fuel fell by more than a threshold, within a short window. A slow drift down over
 *    a shift is consumption; a step is a siphon.
 *  - The ignition was off. Fuel falling while the engine runs is the engine.
 *  - The machine did not move. Fuel falling while it moves is a refuelling stop or a
 *    different machine's tank, and a sloshing tank on a moving vehicle produces false
 *    level readings all by itself.
 *
 * Drop any one clause and this becomes a rule that cries wolf, which on a detector
 * whose whole value is that somebody acts on it is the same as not having it.
 *
 * Deliberately not asking whether fuel "should" have fallen. That question needs a
 * consumption model; this one needs a tank, a key and a GPS fix.
 */
export interface FuelLossParams {
  /** Litres, or whatever unit the fleet reports level in. */
  dropAtLeast: number;
  /** How short "a short window" is. A siphon is minutes; consumption is hours. */
  withinMinutes: number;
  /**
   * How far the machine may drift and still count as stationary.
   *
   * Degrees. A parked machine's GPS wanders by tens of metres, so zero would mean the
   * rule never fires. Roughly 0.0005 degrees is fifty metres.
   */
  movementTolerance?: number;
}

export const DEFAULT_MOVEMENT_TOLERANCE = 0.0005;

export interface FuelLossFinding {
  droppedBy: number;
  overMinutes: number;
  from: { value: number; at: string };
  to: { value: number; at: string };
  movedBy: number;
  ignitionSamples: number;
}

const sortByTime = (readings: WindowReading[]): WindowReading[] =>
  [...readings].sort((a, b) =>
    new Date(a.sourceTimestamp).getTime() - new Date(b.sourceTimestamp).getTime());

const valueNear = (readings: WindowReading[], at: number): number | null => {
  let best: WindowReading | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of readings) {
    const gap = Math.abs(new Date(r.sourceTimestamp).getTime() - at);
    if (gap < bestGap) { best = r; bestGap = gap; }
  }
  return best ? best.value : null;
};

/**
 * The worst qualifying drop in this window, or nothing.
 *
 * Every pair of fuel readings within the time limit is considered rather than only
 * consecutive ones, because a siphon shows up as a sequence of small steps as often as
 * one large one, and a rule that only looks at neighbours misses exactly the thief who
 * is being careful.
 */
export function detectFuelLoss(
  readings: WindowReading[], params: FuelLossParams,
): FuelLossFinding | null {
  const fuel = sortByTime(readings.filter((r) => r.signal === SIGNALS.fuelLevel));
  if (fuel.length < 2) return null;

  const ignition = readings.filter((r) => r.signal === SIGNALS.ignitionStatus);
  const running = readings.filter((r) => r.signal === SIGNALS.engineRunningStatus);
  const lat = readings.filter((r) => r.signal === SIGNALS.latitude);
  const lon = readings.filter((r) => r.signal === SIGNALS.longitude);

  const limitMs = params.withinMinutes * 60_000;
  const tolerance = params.movementTolerance ?? DEFAULT_MOVEMENT_TOLERANCE;

  let worst: FuelLossFinding | null = null;

  for (let i = 0; i < fuel.length; i += 1) {
    const from = fuel[i];
    const fromAt = new Date(from.sourceTimestamp).getTime();

    for (let j = i + 1; j < fuel.length; j += 1) {
      const to = fuel[j];
      const toAt = new Date(to.sourceTimestamp).getTime();
      if (toAt - fromAt > limitMs) break;

      const dropped = from.value - to.value;
      if (dropped < params.dropAtLeast) continue;

      // The engine must have been off for the whole span. One sample of it running
      // inside the window is enough to explain the fuel, and explained fuel is not
      // theft.
      const engineOn = [...ignition, ...running].some((r) => {
        const at = new Date(r.sourceTimestamp).getTime();
        return at >= fromAt && at <= toAt && r.value !== 0;
      });
      if (engineOn) continue;

      // And it must not have moved. Fuel falling while a machine moves is a refuelling
      // stop, a different tank, or a sloshing sender.
      const movedBy = Math.max(
        distance(valueNear(lat, fromAt), valueNear(lat, toAt)),
        distance(valueNear(lon, fromAt), valueNear(lon, toAt)),
      );
      if (movedBy > tolerance) continue;

      const finding: FuelLossFinding = {
        droppedBy: Math.round(dropped * 100) / 100,
        overMinutes: Math.round((toAt - fromAt) / 60_000),
        from: { value: from.value, at: from.sourceTimestamp },
        to: { value: to.value, at: to.sourceTimestamp },
        movedBy: Math.round(movedBy * 1e6) / 1e6,
        ignitionSamples: ignition.length + running.length,
      };
      if (!worst || finding.droppedBy > worst.droppedBy) worst = finding;
    }
  }
  return worst;
}

/**
 * No position reported is not the same as not having moved.
 *
 * A fleet without GPS would otherwise pass the stationary clause for free, which turns
 * a three-clause rule into a two-clause one without anybody choosing that.
 */
function distance(a: number | null, b: number | null): number {
  if (a === null || b === null) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b);
}

export function validateFuelLoss(params: FuelLossParams): string | null {
  if (!(params?.dropAtLeast > 0)) return 'A fuel-loss rule needs a drop worth investigating.';
  if (!(params?.withinMinutes > 0)) return 'A fuel-loss rule needs a window to measure the drop over.';
  if (params.withinMinutes > 24 * 60) {
    // Over a long enough window every machine loses fuel, and the rule stops
    // describing theft and starts describing a working day.
    return 'A window longer than a day measures consumption rather than theft.';
  }
  return null;
}
