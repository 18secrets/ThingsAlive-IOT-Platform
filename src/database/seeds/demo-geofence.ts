import { DataSource } from 'typeorm';
import { SiteBoundary } from '../../catalog/formula/geofence';
import { CircleShape, LngLat } from '../../geofence/geometry';
import { withTenantId } from '../../scope/tenant-session';

/**
 * Simulated GPS for the demo account (task QGEO2, fleet map). The demo loggers report
 * engine, fluid and load signals but never a position, so no fence could be crossed and a
 * map would show every machine as "no position". Like every other demo signal these are
 * `simulated` readings, deterministic per machine and minute, and they exist only where
 * the demo stream runs.
 *
 * The layout is invented, not surveyed: each site gets a centre near Pune derived from its
 * code, a square boundary about 1.8 km across, and one restricted circle inside it. A
 * boundary somebody has already drawn is never replaced.
 *
 * Movement follows what the machine is, read from its type (and name, as a fallback):
 * - mobile — tippers, trucks, graders: a haul cycle, about 8 minutes parked at the loading
 *   point and 12 driving a ~3.2 km loop round the site (~16 km/h), clear of the no-go area;
 * - working — excavators, loaders, cranes, piling rigs: slow moves within a few tens of
 *   metres of their spot;
 * - stationary — generators, concrete pumps and placing booms, compressors: where they were
 *   set down, with only a GPS fix's few metres of jitter.
 * So the map has something to show: some tippers make a haul trip off site from 13:00 to
 * 15:00 India time, and some mobile or working machines stand in the no-go area from 10:00
 * to 11:00. A generator never does either — it cannot.
 */

const PUNE: LngLat = [73.8567, 18.5204];
const HALF_SIDE_DEG = 0.008; // about 890 m of latitude
const NO_GO_OFFSET_DEG = 0.004;
export const DEMO_NO_GO_RADIUS_M = 150;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** A stable small hash: the same code always lands in the same place. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function demoSiteCentre(plantCode: string): LngLat {
  return [PUNE[0] + (hash(`lng:${plantCode}`) - 0.5) * 0.5, PUNE[1] + (hash(`lat:${plantCode}`) - 0.5) * 0.5];
}

export function demoSiteBoundary([lng, lat]: LngLat): SiteBoundary {
  const dLng = HALF_SIDE_DEG / Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [
    [lng - dLng, lat - HALF_SIDE_DEG], [lng + dLng, lat - HALF_SIDE_DEG], [lng + dLng, lat + HALF_SIDE_DEG],
    [lng - dLng, lat + HALF_SIDE_DEG], [lng - dLng, lat - HALF_SIDE_DEG],
  ].map(([x, y]) => [round(x), round(y)] as [number, number]);
  return { type: 'Polygon', coordinates: [ring] };
}

export function demoNoGoZone([lng, lat]: LngLat): CircleShape {
  return { type: 'Circle', center: [round(lng + NO_GO_OFFSET_DEG), round(lat)], radiusM: DEMO_NO_GO_RADIUS_M };
}

export type DemoMobility = 'mobile' | 'working' | 'stationary';

/**
 * What a machine's type says about how it moves. Stationary first: "concrete pump" and
 * "placing boom" must not read as mobile for containing a vehicle word, and a truck-mounted
 * crane drives between lifts but stands still for each, so cranes are working before
 * "truck" is mobile. Unknown is working: neither still nor driving is the safer guess.
 */
export function demoMobility(typeText: string): DemoMobility {
  const t = typeText.toLowerCase();
  if (/generator|genset|\bdg\b|pump|placer|placing|compressor|shutter|batching|lighting|tower-light|welding/.test(t)) {
    return 'stationary';
  }
  if (/crane|piling|vibro|excavator|loader|backhoe|dozer|roller|compactor|paver|drill/.test(t)) return 'working';
  if (/tipper|dumper|truck|hauler|mixer|transit|tractor|grader|trailer/.test(t)) return 'mobile';
  return 'working';
}

/** How far a working machine roams from its spot, in degrees (~0.0005° ≈ 55 m). */
function workingRange(typeText: string): number {
  return /crane|piling|vibro/.test(typeText.toLowerCase()) ? 0.0002 : 0.0005;
}

export type DemoMovement = 'on_site' | 'leaves_site' | 'enters_no_go';

/** Which scripted event, if any, a machine takes part in — never one its mobility rules out. */
export function demoMovement(externalId: string, mobility: DemoMobility = 'working'): DemoMovement {
  if (mobility === 'stationary') return 'on_site';
  const bucket = Math.floor(hash(`move:${externalId}`) * 5);
  if (bucket === 0 && mobility === 'mobile') return 'leaves_site';
  if (bucket === 1) return 'enters_no_go';
  return 'on_site';
}

const CYCLE_MS = 20 * 60_000; // a tipper's load-and-haul cycle
const PARKED_MS = 8 * 60_000; // of which, at the loading point
const HAUL_TRIP_KM = 2.5;
const KM_PER_DEG_LAT = 111.2;

/** Where a demo machine is at time `t` (ms), given its site centre and what it is. */
export function demoPosition(externalId: string, centre: LngLat, t: number, typeText = ''): LngLat {
  const mobility = demoMobility(typeText);
  const movement = demoMovement(externalId, mobility);
  const hourIst = new Date(t + IST_OFFSET_MS).getUTCHours();
  const k = 1 / Math.cos((centre[1] * Math.PI) / 180); // degrees of longitude per degree of latitude
  // A GPS fix wanders a couple of metres even on a machine that has not moved.
  const minute = Math.floor(t / 60_000);
  const jitter = (axis: string) => (hash(`j${axis}:${externalId}:${minute}`) - 0.5) * 0.00004;

  if (movement === 'enters_no_go' && hourIst === 10) {
    const z = demoNoGoZone(centre);
    return [round(z.center[0] + jitter('x')), round(z.center[1] + jitter('y'))];
  }

  // Each machine's own spot on the west half of the site, clear of the no-go circle east.
  const home: LngLat = [
    centre[0] + (-0.001 - hash(`hx:${externalId}`) * 0.004) * k,
    centre[1] + (hash(`hy:${externalId}`) - 0.5) * 0.008,
  ];

  if (mobility === 'stationary') return [round(home[0] + jitter('x')), round(home[1] + jitter('y'))];

  if (mobility === 'working') {
    const range = workingRange(typeText);
    // A slow drift, a full circuit in about an hour and a half: walking pace at most.
    const phase = t / 900_000 + hash(`ph:${externalId}`) * 10;
    return [
      round(home[0] + Math.sin(phase) * range * k + jitter('x')),
      round(home[1] + Math.cos(phase * 0.7) * range + jitter('y')),
    ];
  }

  // Mobile. A haul trip off site: out north and back over the two hours.
  if (movement === 'leaves_site' && hourIst >= 13 && hourIst < 15) {
    const into = (t + IST_OFFSET_MS) % 86_400_000 - 13 * 3_600_000; // ms since 13:00
    const out = into < 3_600_000 ? into / 3_600_000 : 2 - into / 3_600_000; // 0 → 1 → 0
    const exitPoint: LngLat = [centre[0], centre[1] + HALF_SIDE_DEG];
    return [round(exitPoint[0] + jitter('x')), round(exitPoint[1] + (out * HAUL_TRIP_KM) / KM_PER_DEG_LAT + jitter('y'))];
  }

  // The haul cycle: parked at the loading point, then once round the loop and back to it.
  const loadingPoint: LngLat = [centre[0] - 0.003 * k, centre[1] - 0.004];
  const inCycle = (t + hash(`cy:${externalId}`) * CYCLE_MS) % CYCLE_MS;
  if (inCycle < PARKED_MS) return [round(loadingPoint[0] + jitter('x')), round(loadingPoint[1] + jitter('y'))];
  const along = (inCycle - PARKED_MS) / (CYCLE_MS - PARKED_MS);
  // The loop, anticlockwise from the loading point: lng -0.005..+0.0015, lat ±0.004.
  const corners: LngLat[] = [
    [-0.003, -0.004], [0.0015, -0.004], [0.0015, 0.004], [-0.005, 0.004], [-0.005, -0.004], [-0.003, -0.004],
  ];
  const legs = corners.slice(1).map((c, i) => Math.hypot((c[0] - corners[i][0]) * KM_PER_DEG_LAT, (c[1] - corners[i][1]) * KM_PER_DEG_LAT));
  let d = along * legs.reduce((a, b) => a + b, 0);
  let i = 0;
  while (i < legs.length - 1 && d > legs[i]) { d -= legs[i]; i += 1; }
  const f = legs[i] ? d / legs[i] : 0;
  const [ax, ay] = corners[i];
  const [bx, by] = corners[i + 1];
  return [
    round(centre[0] + (ax + (bx - ax) * f) * k + jitter('x')),
    round(centre[1] + ay + (by - ay) * f + jitter('y')),
  ];
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Draws each demo site's boundary where none is drawn, and its no-go zone where none
 * exists. Idempotent: run on every stream start, it changes nothing the second time and
 * never touches a boundary or zone somebody set by hand.
 */
export async function ensureDemoGeofences(
  ds: DataSource, tenantId: string, plants: { id: string; code: string }[],
): Promise<{ boundaries: number; zones: number }> {
  let boundaries = 0;
  let zones = 0;
  await withTenantId(ds, tenantId, async (m) => {
    for (const p of plants) {
      const centre = demoSiteCentre(p.code);
      const [, set] = await m.query(
        `UPDATE plant SET boundary = $1::jsonb WHERE tenant_id = $2 AND id = $3 AND boundary IS NULL`,
        [JSON.stringify(demoSiteBoundary(centre)), tenantId, p.id],
      );
      boundaries += Number(set) || 0;
      const inserted = await m.query(
        `INSERT INTO geofence_zone (tenant_id, code, name, kind, shape, applies_to, plant_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'restricted', $4::jsonb, 'plant', $5, 'seed-demo', 'seed-demo')
         ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`,
        [tenantId, `DEMO-NOGO-${p.code}`.replace(/[^A-Za-z0-9._-]/g, '-'), `No-go area (demo), ${p.code}`,
          JSON.stringify(demoNoGoZone(centre)), p.id],
      );
      zones += inserted.length;
    }
  });
  return { boundaries, zones };
}

/** How far back a position top-up fills, at most: a laptop asleep for a week gets a day. */
const MAX_BACKFILL_MS = 24 * 3_600_000;
/** A logger silent for longer than this is offline, and an offline machine does not move. */
const ONLINE_WITHIN_MS = 3_600_000;

/**
 * Carries each online demo machine's simulated GPS on to now, at the demo's cadence, and
 * draws its site's fences where missing. Separate from `topUpDemo`, whose readings and
 * counts are the six modelled signals; this writes `latitude` and `longitude` only.
 *
 * Online means its bound logger reported anything in the last hour, so EX-04, quiet on
 * purpose, stays where it was, and a machine whose logger never reported gets nothing.
 * Safe to run twice at once: the reading dedupe index refuses a repeat, and the insert
 * skips it.
 */
export async function topUpDemoPositions(
  ds: DataSource, opts: { tenantId: string; stepMs: number; now?: Date },
): Promise<{ positions: Record<string, number>; boundaries: number; zones: number }> {
  const nowMs = Math.floor((opts.now ?? new Date()).getTime() / opts.stepMs) * opts.stepMs;
  const machines: { externalId: string; imei: string; plantId: string | null; plantCode: string | null; typeText: string }[] =
    await withTenantId(ds, opts.tenantId, (m) => m.query(
      `SELECT DISTINCT ON (b.external_id) b.external_id AS "externalId", b.imei, p.id AS "plantId", p.code AS "plantCode",
              concat_ws(' ', e.equipment_class_slug, c.name, e.name) AS "typeText"
         FROM signal_binding_version b
         JOIN equipment_profile e ON e.tenant_id = b.tenant_id AND e.source_system = b.source_system
                                 AND e.external_id = b.external_id
         LEFT JOIN plant p ON p.id = e.plant_id
         LEFT JOIN client_equipment_class c ON c.tenant_id = e.tenant_id AND c.slug = e.equipment_class_slug
        WHERE b.tenant_id = $1 AND b.status = 'active' AND b.is_primary AND b.valid_to IS NULL AND b.imei IS NOT NULL
          AND EXISTS (SELECT 1 FROM telemetry_reading r WHERE r.tenant_id = b.tenant_id AND r.imei = b.imei
                        AND r.signal NOT IN ('latitude', 'longitude')
                        AND r.source_timestamp > $2 AND r.source_timestamp <= $3)
        ORDER BY b.external_id, b.imei`,
      [opts.tenantId, new Date(nowMs - ONLINE_WITHIN_MS), new Date(nowMs)],
    ));

  const plants = new Map(machines.filter((x) => x.plantId && x.plantCode).map((x) => [x.plantId!, x.plantCode!]));
  const drawn = await ensureDemoGeofences(ds, opts.tenantId, [...plants].map(([id, code]) => ({ id, code })));

  const positions: Record<string, number> = {};
  for (const machine of machines) {
    const centre = demoSiteCentre(machine.plantCode ?? `machine:${machine.externalId}`);
    positions[machine.externalId] = await withTenantId(ds, opts.tenantId, async (m) => {
      const [{ last }] = await m.query(
        `SELECT max(source_timestamp) AS last FROM telemetry_reading
          WHERE tenant_id = $1 AND imei = $2 AND signal = 'latitude' AND source_timestamp <= $3`,
        [opts.tenantId, machine.imei, new Date(nowMs)],
      );
      const from = last ? Math.max(new Date(last).getTime() + opts.stepMs, nowMs - MAX_BACKFILL_MS) : nowMs;
      const times: number[] = [];
      for (let t = from; t <= nowMs; t += opts.stepMs) times.push(t);
      if (!times.length) return 0;
      for (const month of new Set(times.map((t) => new Date(t).toISOString().slice(0, 7)))) {
        await m.query(`SELECT ensure_telemetry_partition($1::date)`, [`${month}-01`]);
      }
      const at = times.flatMap((t) => [new Date(t).toISOString(), new Date(t).toISOString()]);
      const signal = times.flatMap(() => ['latitude', 'longitude']);
      const value = times.flatMap((t) => {
        const [lng, lat] = demoPosition(machine.externalId, centre, t, machine.typeText);
        return [lat, lng];
      });
      const rows: unknown[] = await m.query(
        `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
           SELECT $1, $2, u.signal, u.v, 'deg', u.ts, u.ts, 'simulated'
             FROM unnest($3::text[], $4::double precision[], $5::timestamptz[]) AS u(signal, v, ts)
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [opts.tenantId, machine.imei, signal, value, at],
      );
      return rows.length;
    });
  }
  return { positions, ...drawn };
}

