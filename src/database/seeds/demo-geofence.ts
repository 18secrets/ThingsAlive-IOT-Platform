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
 * The layout is invented but placed on the ground. The first version put a square near Pune
 * wherever a hash landed — on a forested hill, across a river — and on a real base map it
 * read as fake. Each demo site now has a chosen place, checked against OpenStreetMap: the
 * expressway package lies along the Pune Ring Road alignment as a long corridor, the
 * equipment yard on the construction plots west of the railway at Ghorawadi, the plants on
 * open land beside Chakan, Ranjangaon and Khed. Its outline is an irregular parcel, not a
 * square; a code with no chosen place falls back to one near Pune, shaped the same way.
 *
 * Movement is laid out in the site's own frame — across its width and along its length,
 * in fractions of each — so the same rules keep a tipper on a 2 km corridor and in a
 * 400 m yard, and nothing lands outside by accident:
 * - mobile — tippers, trucks, graders: a haul cycle, about 8 minutes parked at the loading
 *   point and 12 driving a loop round the site, clear of the no-go area;
 * - working — excavators, loaders, cranes, piling rigs: slow moves within a few tens of
 *   metres of their spot;
 * - stationary — generators, concrete pumps and placing booms, compressors: where they were
 *   set down, with only a GPS fix's few metres of jitter.
 * So the map has something to show: some tippers make a haul trip off site from 13:00 to
 * 15:00 India time, and some mobile or working machines stand in the no-go area from 10:00
 * to 11:00. A generator never does either — it cannot.
 */

const IST_OFFSET_MS = 5.5 * 3_600_000;
const M_PER_DEG_LAT = 110_574;
const m_per_deg_lng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/**
 * A stable hash in [0, 1). FNV-1a, then murmur3's finaliser: FNV alone barely moves its
 * high bits when only the last character changes, so EX-01, EX-02 and EX-03 — ids that
 * differ in one digit — all landed within a metre of each other on the first map.
 */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A site's place and shape: half its width across, half its length along `bearingDeg`. */
interface DemoSite { centre: LngLat; halfWidthM: number; halfLengthM: number; bearingDeg: number; seed: string }

/**
 * Where each demo site is, chosen on OpenStreetMap (29 Oct 2026). Invented sites on real,
 * plausible ground: open or construction land, clear of rivers, lakes and existing towns.
 */
const CHOSEN: Record<string, Omit<DemoSite, 'seed'>> = {
  // Pune Metro Expressway Package 04: a works corridor along the Ring Road alignment.
  'PUNE-01': { centre: [73.6570, 18.5680], halfWidthM: 340, halfLengthM: 1100, bearingDeg: 142 },
  // Talegaon Heavy Equipment Yard: the construction plots west of the railway, Ghorawadi.
  'PUNE-02': { centre: [73.6941, 18.7155], halfWidthM: 380, halfLengthM: 560, bearingDeg: 10 },
  '0483': { centre: [73.7990, 18.7640], halfWidthM: 560, halfLengthM: 700, bearingDeg: 25 },
  // The fleet's main yard (most machines are here): larger, and west of the industrial park.
  '0556': { centre: [74.2462, 18.7665], halfWidthM: 800, halfLengthM: 1050, bearingDeg: 70 },
  '0616': { centre: [74.2330, 18.7820], halfWidthM: 560, halfLengthM: 660, bearingDeg: 120 },
  // Facing south-east, so its no-go area falls on open ground, not the SH54 or Davadi road.
  '0624': { centre: [73.9060, 18.8280], halfWidthM: 560, halfLengthM: 800, bearingDeg: 130 },
};

const PUNE: LngLat = [73.8567, 18.5204];
const byCentre = new Map<string, DemoSite>();
const keyOf = ([lng, lat]: LngLat) => `${lng.toFixed(6)},${lat.toFixed(6)}`;

function siteFor(code: string): DemoSite {
  const chosen = CHOSEN[code];
  const site: DemoSite = chosen ? { ...chosen, seed: code } : {
    centre: [round(PUNE[0] + (hash(`lng:${code}`) - 0.5) * 0.4), round(PUNE[1] + (hash(`lat:${code}`) - 0.5) * 0.4)],
    halfWidthM: 700, halfLengthM: 700 + hash(`len:${code}`) * 300, bearingDeg: hash(`brg:${code}`) * 180, seed: code,
  };
  byCentre.set(keyOf(site.centre), site);
  return site;
}

/** The site at a centre this module handed out; a centre it did not, as a plain site of its own. */
function siteAt(centre: LngLat): DemoSite {
  return byCentre.get(keyOf(centre))
    ?? { centre, halfWidthM: 600, halfLengthM: 700, bearingDeg: 0, seed: keyOf(centre) };
}

/** A point in the site's frame — x across its width, y along its length, each in -1..1 — on the ground. */
function place(site: DemoSite, x: number, y: number): LngLat {
  const a = (site.bearingDeg * Math.PI) / 180;
  const across = x * site.halfWidthM;
  const along = y * site.halfLengthM;
  // The length runs along the bearing (clockwise from north); the width at right angles to it.
  const east = along * Math.sin(a) + across * Math.cos(a);
  const north = along * Math.cos(a) - across * Math.sin(a);
  return [round(site.centre[0] + east / m_per_deg_lng(site.centre[1])), round(site.centre[1] + north / M_PER_DEG_LAT)];
}

export function demoSiteCentre(plantCode: string): LngLat {
  return siteFor(plantCode).centre;
}

/**
 * An irregular parcel of nine corners, each 0.88 to 1.05 of the way out in the site's
 * frame. The nearest edge is never closer than about 0.83 of the half-width or half-length,
 * which is the room the movement below is laid out to stay inside.
 */
export function demoSiteBoundary(centre: LngLat): SiteBoundary {
  const site = siteAt(centre);
  const corners = 9;
  const ring: [number, number][] = [];
  for (let i = 0; i < corners; i += 1) {
    const angle = ((i + (hash(`ang:${site.seed}:${i}`) - 0.5) * 0.5) / corners) * 2 * Math.PI;
    const r = 0.88 + hash(`rad:${site.seed}:${i}`) * 0.17;
    ring.push(place(site, Math.sin(angle) * r, Math.cos(angle) * r));
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Half-way along the site, on its centre line; a fifth of its width across, at most 120 m. */
export function demoNoGoZone(centre: LngLat): CircleShape {
  const site = siteAt(centre);
  return { type: 'Circle', center: place(site, 0, 0.5), radiusM: Math.round(Math.min(120, 0.2 * site.halfWidthM)) };
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

/** How far a working machine roams from its spot, in metres. */
function workingRangeM(typeText: string): number {
  return /crane|piling|vibro/.test(typeText.toLowerCase()) ? 20 : 55;
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
const HAUL_TRIP_M = 2500;
// The haul loop in the site's frame: anticlockwise from the loading point, across ±0.45 and
// from -0.6 to 0.2 along — inside the parcel, and short of the no-go circle at 0.5.
const LOOP: [number, number][] = [[-0.3, -0.6], [0.45, -0.6], [0.45, 0.2], [-0.45, 0.2], [-0.45, -0.6], [-0.3, -0.6]];

/** Where a demo machine is at time `t` (ms), given its site centre and what it is. */
export function demoPosition(externalId: string, centre: LngLat, t: number, typeText = ''): LngLat {
  const site = siteAt(centre);
  const mobility = demoMobility(typeText);
  const movement = demoMovement(externalId, mobility);
  const hourIst = new Date(t + IST_OFFSET_MS).getUTCHours();
  // A GPS fix wanders a couple of metres even on a machine that has not moved.
  const minute = Math.floor(t / 60_000);
  const jitter = ([lng, lat]: LngLat): LngLat => [
    round(lng + ((hash(`jx:${externalId}:${minute}`) - 0.5) * 4) / m_per_deg_lng(lat)),
    round(lat + ((hash(`jy:${externalId}:${minute}`) - 0.5) * 4) / M_PER_DEG_LAT),
  ];

  if (movement === 'enters_no_go' && hourIst === 10) return jitter(demoNoGoZone(centre).center);

  // Each machine's own spot: within 0.6 of the centre and on the near side of the no-go area.
  const hx = (hash(`hx:${externalId}`) - 0.5) * 1.1;
  const hy = -0.6 + hash(`hy:${externalId}`) * 0.75;
  const shrink = Math.min(1, 0.6 / Math.hypot(hx, hy));
  const home = place(site, hx * shrink, hy * shrink);

  if (mobility === 'stationary') return jitter(home);

  if (mobility === 'working') {
    // A slow drift, a full circuit in about an hour and a half: walking pace at most.
    const range = workingRangeM(typeText);
    const phase = t / 900_000 + hash(`ph:${externalId}`) * 10;
    return jitter([
      home[0] + (Math.sin(phase) * range) / m_per_deg_lng(home[1]),
      home[1] + (Math.cos(phase * 0.7) * range) / M_PER_DEG_LAT,
    ]);
  }

  // Mobile. A haul trip off site: out past the far end and back over the two hours.
  if (movement === 'leaves_site' && hourIst >= 13 && hourIst < 15) {
    const into = (t + IST_OFFSET_MS) % 86_400_000 - 13 * 3_600_000; // ms since 13:00
    const out = into < 3_600_000 ? into / 3_600_000 : 2 - into / 3_600_000; // 0 → 1 → 0
    return jitter(place(site, 0, 1 + (out * HAUL_TRIP_M) / site.halfLengthM));
  }

  // The haul cycle: parked at the loading point, then once round the loop and back to it.
  const inCycle = (t + hash(`cy:${externalId}`) * CYCLE_MS) % CYCLE_MS;
  if (inCycle < PARKED_MS) return jitter(place(site, LOOP[0][0], LOOP[0][1]));
  const along = (inCycle - PARKED_MS) / (CYCLE_MS - PARKED_MS);
  const metres = (a: [number, number], b: [number, number]) =>
    Math.hypot((b[0] - a[0]) * site.halfWidthM, (b[1] - a[1]) * site.halfLengthM);
  const legs = LOOP.slice(1).map((c, i) => metres(LOOP[i], c));
  let d = along * legs.reduce((a, b) => a + b, 0);
  let i = 0;
  while (i < legs.length - 1 && d > legs[i]) { d -= legs[i]; i += 1; }
  const f = legs[i] ? d / legs[i] : 0;
  return jitter(place(site, LOOP[i][0] + (LOOP[i + 1][0] - LOOP[i][0]) * f, LOOP[i][1] + (LOOP[i + 1][1] - LOOP[i][1]) * f));
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * The boundary the first version drew: a square ±0.008° around a hashed centre near Pune.
 * Kept only to recognise one in the database and replace it — it is the seed's own, and no
 * person drew it, so replacing it takes nothing from anybody.
 */
export function legacyDemoBoundary(plantCode: string): SiteBoundary {
  const fnv = (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967295;
  };
  const lng = PUNE[0] + (fnv(`lng:${plantCode}`) - 0.5) * 0.5;
  const lat = PUNE[1] + (fnv(`lat:${plantCode}`) - 0.5) * 0.5;
  const dLng = 0.008 / Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [
    [lng - dLng, lat - 0.008], [lng + dLng, lat - 0.008], [lng + dLng, lat + 0.008], [lng - dLng, lat + 0.008], [lng - dLng, lat - 0.008],
  ].map(([x, y]) => [round(x), round(y)] as [number, number]);
  return { type: 'Polygon', coordinates: [ring] };
}

const sameShape = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Draws each demo site's boundary where none is drawn, and its no-go zone where none exists.
 * Replaces only what the seed itself drew: a boundary still exactly the first version's
 * square, and a no-go zone nobody but the seed has updated. Idempotent: the second run
 * changes nothing, and a boundary or zone a person set is never touched.
 */
export async function ensureDemoGeofences(
  ds: DataSource, tenantId: string, plants: { id: string; code: string }[],
): Promise<{ boundaries: number; zones: number }> {
  let boundaries = 0;
  let zones = 0;
  await withTenantId(ds, tenantId, async (m) => {
    for (const p of plants) {
      const centre = demoSiteCentre(p.code);
      const [row] = await m.query(`SELECT boundary FROM plant WHERE tenant_id = $1 AND id = $2`, [tenantId, p.id]);
      const current = row?.boundary ?? null;
      const ours = current === null || sameShape(current, legacyDemoBoundary(p.code));
      if (ours && !sameShape(current, demoSiteBoundary(centre))) {
        await m.query(`UPDATE plant SET boundary = $1::jsonb WHERE tenant_id = $2 AND id = $3`,
          [JSON.stringify(demoSiteBoundary(centre)), tenantId, p.id]);
        boundaries += 1;
      }
      const code = `DEMO-NOGO-${p.code}`.replace(/[^A-Za-z0-9._-]/g, '-');
      const shape = JSON.stringify(demoNoGoZone(centre));
      const inserted = await m.query(
        `INSERT INTO geofence_zone (tenant_id, code, name, kind, shape, applies_to, plant_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'restricted', $4::jsonb, 'plant', $5, 'seed-demo', 'seed-demo')
         ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`,
        [tenantId, code, `No-go area (demo), ${p.code}`, shape, p.id],
      );
      if (inserted.length) { zones += 1; continue; }
      const [, moved] = await m.query(
        `UPDATE geofence_zone SET shape = $1::jsonb, updated_at = now()
          WHERE tenant_id = $2 AND code = $3 AND updated_by = 'seed-demo' AND shape <> $1::jsonb`,
        [shape, tenantId, code],
      );
      zones += Number(moved) || 0;
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

