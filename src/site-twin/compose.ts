import { LayoutInput, PlacementInput, ZoneInput } from './site-twin.service';

/** One machine assigned to the site, as the composer sees it. */
export interface ComposeMachine {
  sourceSystem: string;
  externalId: string;
  classSlug: string | null;
  /** The tenant's class category, e.g. "Excavators & Earthmoving". */
  category: string | null;
  /** Needs a person: an open breakdown, an alert, no recent data, a sensor missing. */
  attention: boolean;
}

type Front = 'earthmoving' | 'power' | 'pneumatic' | 'concrete' | 'lifting' | 'other';

/** Which work front a machine belongs to, from its category, falling back to its slug. */
export function frontOf(m: Pick<ComposeMachine, 'classSlug' | 'category'>): Front {
  const s = `${m.category ?? ''} ${m.classSlug ?? ''}`;
  if (/power|generat|genset/i.test(s)) return 'power';
  if (/pneumatic|compress/i.test(s)) return 'pneumatic';
  if (/concrete|batching|mixer/i.test(s)) return 'concrete';
  if (/crane|lifting/i.test(s)) return 'lifting';
  if (/excavat|earthmov|loader|grader|dozer|breaker|tipper|dumper/i.test(s)) return 'earthmoving';
  return 'other';
}

/** `n` points in a zone, in rows `gap` metres apart, centred, inside its edge. */
function slots(z: ZoneInput, n: number, gap = 12): [number, number][] {
  const cols = Math.max(1, Math.min(n, Math.floor((z.widthM - 4) / gap) || 1));
  const rows = Math.ceil(n / cols);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const c = i % cols; const r = Math.floor(i / cols);
    const x = z.x + (c - (cols - 1) / 2) * Math.min(gap, (z.widthM - 4) / Math.max(1, cols));
    const zz = z.z + (r - (rows - 1) / 2) * Math.min(gap, (z.depthM - 4) / Math.max(1, rows));
    out.push([Math.round(x * 10) / 10, Math.round(zz * 10) / 10]);
  }
  return out;
}

/**
 * A first layout for a site, from the machines assigned to it and nothing else.
 *
 * Every structure here is either the site's own infrastructure (gate, offices, the
 * access road, parking, the maintenance and breakdown bay) or exists because an assigned
 * machine needs it: a generator room for each site with a generator, a quarry and a road
 * front for excavators, a batching plant for concrete plant, a building with a lifting
 * pad for cranes. No machine, no structure — a site with only excavators gets no batching
 * plant, however typical one would be.
 *
 * A machine that needs attention goes to the maintenance and breakdown bay rather than
 * its work front: that is where it is, or should be.
 *
 * Progress is not composed. Road sections start as the site would report them on day
 * one — the first laid, the next started, the last not yet — and a building starts at
 * zero; the site reports from there.
 *
 * Deterministic: the same machines give the same layout, so a proposal can be compared.
 */
export function composeLayout(machines: ComposeMachine[], expectedVersion: number): LayoutInput {
  const byFront = new Map<Front, ComposeMachine[]>();
  const bay: ComposeMachine[] = [];
  for (const m of [...machines].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    if (m.attention) { bay.push(m); continue; }
    const f = frontOf(m);
    byFront.set(f, [...(byFront.get(f) ?? []), m]);
  }
  const has = (f: Front) => (byFront.get(f)?.length ?? 0) > 0
    || bay.some((m) => frontOf(m) === f);

  const zones: ZoneInput[] = [
    { key: 'gate', label: 'Main gate', kind: 'gate', x: -114, z: 60, widthM: 10, depthM: 14 },
    { key: 'access-road', label: 'Site access road', kind: 'road', x: -10, z: 60, widthM: 200, depthM: 10, progressPct: 100 },
    { key: 'head-office', label: 'Head office', kind: 'head_office', x: -95, z: -40, widthM: 26, depthM: 18 },
    { key: 'site-office', label: 'Site office', kind: 'site_office', x: -95, z: -6, widthM: 26, depthM: 10 },
    { key: 'parking', label: 'Staff parking', kind: 'parking', x: -95, z: 22, widthM: 26, depthM: 14 },
    { key: 'workshop', label: 'Maintenance & breakdown bay', kind: 'maintenance_workshop', x: 45, z: 30, widthM: 36, depthM: 22 },
  ];
  const placements: PlacementInput[] = [];
  const put = (z: ZoneInput, ms: ComposeMachine[], route?: string[], heading = 0) => {
    slots(z, ms.length).forEach(([x, zz], i) => placements.push({
      sourceSystem: ms[i].sourceSystem, externalId: ms[i].externalId, x, z: zz, headingDeg: heading, route: route ?? [],
    }));
  };

  // Earthmoving: the road front first (it is what the site is building), then the
  // quarry, then general excavation with whatever is left.
  const earth = byFront.get('earthmoving') ?? [];
  if (has('earthmoving')) {
    const roadA: ZoneInput = { key: 'road-a', label: 'Main road – section A', kind: 'road', x: -60, z: -68, widthM: 70, depthM: 12, progressPct: 100 };
    const roadB: ZoneInput = { key: 'road-b', label: 'Main road – section B', kind: 'road', x: 10, z: -68, widthM: 70, depthM: 12, progressPct: 45 };
    const roadC: ZoneInput = { key: 'road-c', label: 'Main road – section C', kind: 'road', x: 80, z: -68, widthM: 70, depthM: 12, progressPct: 0 };
    zones.push(roadA, roadB, roadC);
    const onRoad = earth.slice(0, Math.min(3, Math.ceil(earth.length / 3)));
    const inQuarry = earth.slice(onRoad.length, onRoad.length + Math.min(3, Math.ceil((earth.length - onRoad.length) / 2)));
    const digging = earth.slice(onRoad.length + inQuarry.length);
    put(roadB, onRoad, ['road-b', 'road-c'], 0);
    if (inQuarry.length) {
      const quarry: ZoneInput = { key: 'quarry', label: 'Quarry – boulder breaking', kind: 'quarry', x: -45, z: -30, widthM: 40, depthM: 30 };
      zones.push(quarry);
      put(quarry, inQuarry, [], 45);
    }
    if (digging.length) {
      const pit: ZoneInput = { key: 'excavation', label: 'Excavation', kind: 'work_area', x: 10, z: -25, widthM: 44, depthM: 26 };
      zones.push(pit);
      put(pit, digging, [], 300);
    }
  }
  if (has('power')) {
    const room: ZoneInput = { key: 'generator-room', label: 'Generator room', kind: 'generator_room', x: 100, z: 32, widthM: 22, depthM: 14 };
    zones.push(room);
    put(room, byFront.get('power') ?? []);
  }
  if (has('pneumatic')) {
    const house: ZoneInput = { key: 'compressor-house', label: 'Compressor house', kind: 'compressor_house', x: 100, z: 6, widthM: 20, depthM: 12 };
    zones.push(house);
    put(house, byFront.get('pneumatic') ?? []);
  }
  if (has('concrete')) {
    const plant: ZoneInput = { key: 'batching-plant', label: 'Batching plant', kind: 'batching_plant', x: -40, z: 26, widthM: 32, depthM: 24 };
    zones.push(plant);
    put(plant, byFront.get('concrete') ?? []);
  }
  if (has('lifting')) {
    const block: ZoneInput = { key: 'building', label: 'Building under construction', kind: 'building', x: 62, z: -25, widthM: 30, depthM: 22, floors: 6, progressPct: 0 };
    const pad: ZoneInput = { key: 'lifting-pad', label: 'Crane lifting pad', kind: 'work_area', x: 98, z: -25, widthM: 24, depthM: 22 };
    zones.push(block, pad);
    put(pad, byFront.get('lifting') ?? []);
  }
  const other = byFront.get('other') ?? [];
  if (other.length) {
    const yard: ZoneInput = { key: 'equipment-yard', label: 'Equipment yard', kind: 'parking', x: -40, z: 0, widthM: 30, depthM: 14 };
    zones.push(yard);
    put(yard, other);
  }
  put(zones.find((z) => z.key === 'workshop')!, bay, [], 90);

  return { expectedVersion, extent: { widthM: 240, depthM: 160 }, zones, placements };
}
