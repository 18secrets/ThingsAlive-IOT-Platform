import { pairPositions, Position } from '../catalog/formula/geofence';
import { insideZone, LngLat, ZoneShape } from './geometry';

/**
 * Turning a window's positions into visits (task QGEO2, stage 2). Pure: the tracker
 * reads and writes, this decides.
 *
 * A window `(start, end]` decides only what happened inside it. It knows whether the
 * machine was in each zone at `start` (the visit carried in from the window before), and
 * walks its own positions in time order; each crossing opens or closes a visit at the
 * reading that showed it. Nothing after `end` is its to say — a visit still open at `end`
 * is closed, if at all, by a later window.
 */

export interface PlanZone { key: string; shape: ZoneShape }

export interface PlannedVisit {
  key: string;
  /** Null for the visit carried in from before the window: its entry is not this window's. */
  enteredAt: Date | null;
  entry: LngLat | null;
  leftAt: Date | null;
  exit: LngLat | null;
}

export interface WindowReading { imei: string; signal: string; value: number; sourceTimestamp: string }

/**
 * Positions in the window, in time order. Paired per logger: a machine with two loggers
 * has two GPS fixes, and pairing one's latitude with the other's longitude would invent a
 * place neither reported.
 */
export function windowPositions(readings: WindowReading[], window: { start: Date; end: Date }): Position[] {
  const byImei = new Map<string, { lat: { at: Date; value: number }[]; lng: { at: Date; value: number }[] }>();
  for (const r of readings) {
    if (r.signal !== 'latitude' && r.signal !== 'longitude') continue;
    const at = new Date(r.sourceTimestamp);
    // The runner's own rule for what belongs to a window: after the start, up to the end.
    if (!(at.getTime() > window.start.getTime() && at.getTime() <= window.end.getTime())) continue;
    const slot = byImei.get(r.imei) ?? { lat: [], lng: [] };
    (r.signal === 'latitude' ? slot.lat : slot.lng).push({ at, value: r.value });
    byImei.set(r.imei, slot);
  }
  return [...byImei.values()]
    .flatMap((s) => pairPositions(s.lat, s.lng))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function planVisits(zones: PlanZone[], insideAtStart: ReadonlySet<string>, positions: Position[]): PlannedVisit[] {
  const out: PlannedVisit[] = [];
  for (const zone of zones) {
    let current: PlannedVisit | null = insideAtStart.has(zone.key)
      ? { key: zone.key, enteredAt: null, entry: null, leftAt: null, exit: null }
      : null;
    if (current) out.push(current);
    for (const p of positions) {
      const point: LngLat = [p.lng, p.lat];
      const inside = insideZone(zone.shape, point);
      if (inside && !current) {
        current = { key: zone.key, enteredAt: p.at, entry: point, leftAt: null, exit: null };
        out.push(current);
      } else if (!inside && current) {
        current.leftAt = p.at;
        current.exit = point;
        current = null;
      }
    }
  }
  return out;
}
