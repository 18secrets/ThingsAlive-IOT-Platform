import { Reading } from './baseline-operators';

/** A GeoJSON Polygon as `plant.boundary` stores it (task QGEO1): `[longitude, latitude]`
 * positions, the outer ring first, then holes. Its shape is guaranteed by the database. */
export interface SiteBoundary {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface Position { at: Date; lng: number; lat: number }

/** How far apart a latitude and its longitude may be and still be one position. */
export const PAIRING_TOLERANCE_MS = 5 * 60_000;

/**
 * Latitude and longitude arrive as two signals with their own timestamps. Each
 * latitude takes the latest longitude at or before it, within the tolerance;
 * anything unpaired is dropped — half a position is not a position.
 */
export function pairPositions(latitude: Reading[], longitude: Reading[]): Position[] {
  const lngs = [...longitude].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: Position[] = [];
  let j = 0;
  for (const lat of [...latitude].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    while (j + 1 < lngs.length && lngs[j + 1].at.getTime() <= lat.at.getTime()) j += 1;
    const lng = lngs[j];
    if (!lng || lng.at.getTime() > lat.at.getTime()) continue;
    if (lat.at.getTime() - lng.at.getTime() > PAIRING_TOLERANCE_MS) continue;
    out.push({ at: lat.at, lat: lat.value, lng: lng.value });
  }
  return out;
}

/**
 * Inside the outer ring and in no hole. Planar ray casting over longitude/latitude —
 * accurate at the scale a site has; no site here crosses the antimeridian. A point
 * on an edge counts as inside: a site is drawn generously, and a machine parked on
 * the line has not left.
 */
export function insideBoundary(boundary: SiteBoundary, lng: number, lat: number): boolean {
  const [outer, ...holes] = boundary.coordinates;
  if (!outer || !inRing(outer, lng, lat, true)) return false;
  return !holes.some((hole) => inRing(hole, lng, lat, false));
}

function inRing(ring: [number, number][], x: number, y: number, edgeCounts: boolean): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (onSegment(xi, yi, xj, yj, x, y)) return edgeCounts;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onSegment(x1: number, y1: number, x2: number, y2: number, x: number, y: number): boolean {
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
}
