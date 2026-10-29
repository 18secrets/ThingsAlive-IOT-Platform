import { insideBoundary, SiteBoundary } from '../catalog/formula/geofence';

/**
 * Zone geometry (task QGEO2). Pure functions, no PostGIS — QGEO1's decision, and site
 * scale needs nothing it provides. Polygons are QGEO1's `insideBoundary`, unchanged, so a
 * zone and a site boundary cannot disagree about the same polygon.
 *
 * Positions are `[longitude, latitude]` throughout, as GeoJSON has them. On an edge
 * counts as inside everywhere, as QGEO1 decided for sites: a machine on the line has not
 * crossed it.
 */

export type LngLat = [number, number];

export interface CircleShape { type: 'Circle'; center: LngLat; radiusM: number }
/** A path and its full width: inside is within half the width of the nearest segment. */
export interface CorridorShape { type: 'Corridor'; path: LngLat[]; widthM: number }
export type ZoneShape = SiteBoundary | CircleShape | CorridorShape;

export type ZoneKind = 'allowed' | 'restricted' | 'corridor';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Metres from a point to the nearest segment of a path. Each segment is measured on a flat
 * projection centred on the point — off by well under a metre across the few kilometres a
 * corridor segment spans, which is far inside any GPS fix.
 */
export function distanceToPathM(path: LngLat[], point: LngLat): number {
  const [lng0, lat0] = point;
  const k = Math.cos(rad(lat0));
  const flat = ([lng, lat]: LngLat) => [rad(lng - lng0) * k * EARTH_RADIUS_M, rad(lat - lat0) * EARTH_RADIUS_M];
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const [ax, ay] = flat(path[i]);
    const [bx, by] = flat(path[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // The point is the origin; t is where its foot falls along the segment, clamped to it.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

export function insideZone(shape: ZoneShape, point: LngLat): boolean {
  switch (shape.type) {
    case 'Polygon': return insideBoundary(shape, point[0], point[1]);
    case 'Circle': return haversineM(shape.center, point) <= shape.radiusM;
    case 'Corridor': return distanceToPathM(shape.path, point) <= shape.widthM / 2;
  }
}

/** An allowed area or a corridor is broken by being outside it; a restricted one by being in it. */
export function violates(kind: ZoneKind, inside: boolean): boolean {
  return kind === 'restricted' ? inside : !inside;
}
