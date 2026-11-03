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

export type Front = 'earthmoving' | 'transport' | 'power' | 'pneumatic' | 'concrete' | 'lifting' | 'foundation' | 'other';

/** Which work front a machine belongs to, from its category, falling back to its slug. */
export function frontOf(m: Pick<ComposeMachine, 'classSlug' | 'category'>): Front {
  const s = `${m.category ?? ''} ${m.classSlug ?? ''}`;
  if (/power|generat|genset/i.test(s)) return 'power';
  if (/pneumatic|compress/i.test(s)) return 'pneumatic';
  if (/transport|tipper|dumper|truck|haul|transit/i.test(s)) return 'transport';
  if (/concrete|batching|mixer/i.test(s)) return 'concrete';
  if (/crane|lifting/i.test(s)) return 'lifting';
  if (/pil(e|ing)|foundation|drill|vibro/i.test(s)) return 'foundation';
  if (/excavat|earthmov|loader|grader|dozer|breaker/i.test(s)) return 'earthmoving';
  return 'other';
}

/** Metres between machines in a zone: a 20 t excavator's swing, with room to walk. */
const GAP = 12;
/** The site's width bounds. Within them it follows what is on it: a four-machine yard
 * drawn 280 m wide is a speck in a field. Its depth follows from what has to fit. */
const MIN_WIDTH = 160;
const MAX_WIDTH = 320;
const MARGIN = 10;
const BAND = 22;

const round = (n: number) => Math.round(n * 10) / 10;

/** A zone's size for `n` machines: at least `w` x `d`, and big enough for them in rows. */
function sized(w: number, d: number, n: number): { widthM: number; depthM: number } {
  if (n <= 1) return { widthM: w, depthM: d };
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.6))));
  const rows = Math.ceil(n / cols);
  return { widthM: Math.max(w, cols * GAP + 6), depthM: Math.max(d, rows * GAP + 6) };
}

/** `n` points in a zone, `GAP` apart in rows, centred. The zone was sized to hold them. */
function slots(z: ZoneInput, n: number): [number, number][] {
  const cols = Math.max(1, Math.min(n, Math.floor((z.widthM - 4) / GAP) || 1));
  const rows = Math.ceil(n / cols);
  const gx = Math.min(GAP, (z.widthM - 4) / cols);
  const gz = Math.min(GAP, (z.depthM - 4) / Math.max(1, rows));
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols; const r = Math.floor(i / cols);
    return [round(z.x + (c - (cols - 1) / 2) * gx), round(z.z + (r - (rows - 1) / 2) * gz)] as [number, number];
  });
}

interface Lot { zone: Omit<ZoneInput, 'x' | 'z'>; machines: ComposeMachine[]; route?: (have: Set<string>) => string[]; heading?: number }

/**
 * A first layout for a site, from the machines assigned to it and nothing else.
 *
 * Every structure is either the site's own infrastructure (gate, offices, the access
 * road, parking, the maintenance and breakdown bay) or exists because an assigned machine
 * needs it: a quarry and a road front for excavators, a haul fleet for tippers, a
 * generator room for generators, a batching plant for concrete plant, a building with a
 * lifting pad for cranes, a piling area for rigs. No machine, no structure — a site with
 * only excavators gets no batching plant, however typical one would be.
 *
 * Zones are sized to the machines they hold and packed in rows; the site is as deep as
 * that takes. A machine that needs attention goes to the maintenance and breakdown bay.
 * Tippers get a route between the fronts that exist — quarry to batching plant to
 * building — which they travel only while their own data says they are working.
 *
 * Progress is not composed: road sections start laid, started and not yet, and a
 * building at zero; the site reports from there.
 *
 * Deterministic: the same machines give the same layout.
 */
export function composeLayout(machines: ComposeMachine[], expectedVersion: number): LayoutInput {
  const fronts = new Map<Front, ComposeMachine[]>();
  const bay: ComposeMachine[] = [];
  const all = [...machines].sort((a, b) => a.externalId.localeCompare(b.externalId));
  for (const m of all) {
    if (m.attention) { bay.push(m); continue; }
    const f = frontOf(m);
    fronts.set(f, [...(fronts.get(f) ?? []), m]);
  }
  const at = (f: Front) => fronts.get(f) ?? [];
  // A front exists if any machine of it is assigned, even one that is in the bay today.
  const has = (f: Front) => all.some((m) => frontOf(m) === f);

  const earth = at('earthmoving');
  const onRoad = earth.slice(0, Math.min(3, Math.ceil(earth.length / 3)));
  const inQuarry = earth.slice(onRoad.length, onRoad.length + Math.min(4, Math.ceil((earth.length - onRoad.length) / 2)));
  const digging = earth.slice(onRoad.length + inQuarry.length);

  const lots: Lot[] = [
    { zone: { key: 'head-office', label: 'Head office', kind: 'head_office', widthM: 26, depthM: 18 }, machines: [] },
    { zone: { key: 'site-office', label: 'Site office', kind: 'site_office', widthM: 26, depthM: 12 }, machines: [] },
    { zone: { key: 'parking', label: 'Staff parking', kind: 'parking', widthM: 22, depthM: 14 }, machines: [] },
  ];
  if (inQuarry.length) {
    lots.push({ zone: { key: 'quarry', label: 'Quarry – boulder breaking', kind: 'quarry', ...sized(40, 30, inQuarry.length) }, machines: inQuarry, heading: 45 });
  }
  if (digging.length) {
    lots.push({ zone: { key: 'excavation', label: 'Excavation', kind: 'work_area', ...sized(40, 26, digging.length) }, machines: digging, heading: 300 });
  }
  if (has('concrete')) {
    lots.push({ zone: { key: 'batching-plant', label: 'Batching plant', kind: 'batching_plant', ...sized(34, 26, at('concrete').length) }, machines: at('concrete') });
  }
  if (has('lifting')) {
    lots.push({ zone: { key: 'building', label: 'Building under construction', kind: 'building', widthM: 34, depthM: 26, floors: 8, progressPct: 0 }, machines: [] });
    lots.push({ zone: { key: 'lifting-pad', label: 'Crane lifting pad', kind: 'work_area', ...sized(26, 24, at('lifting').length) }, machines: at('lifting') });
  }
  if (has('foundation')) {
    lots.push({ zone: { key: 'piling', label: 'Piling – foundations', kind: 'work_area', ...sized(26, 22, at('foundation').length) }, machines: at('foundation') });
  }
  if (has('power')) {
    lots.push({ zone: { key: 'generator-room', label: 'Generator room', kind: 'generator_room', ...sized(22, 14, at('power').length) }, machines: at('power') });
  }
  if (has('pneumatic')) {
    lots.push({ zone: { key: 'compressor-house', label: 'Compressor house', kind: 'compressor_house', ...sized(20, 12, at('pneumatic').length) }, machines: at('pneumatic') });
  }
  if (has('transport')) {
    lots.push({
      zone: { key: 'haul-park', label: 'Haul fleet park', kind: 'parking', ...sized(26, 16, at('transport').length) },
      machines: at('transport'),
      // Load at the quarry, deliver to the batching plant and the building — the fronts
      // this site has. With none of them, the road front.
      route: (have) => {
        const stops = ['quarry', 'batching-plant', 'building'].filter((k) => have.has(k));
        if (stops.length >= 2) return stops;
        return ['gate', have.has('road-b') ? 'road-b' : 'access-road', ...stops].filter((k) => have.has(k));
      },
    });
  }
  if (at('other').length) {
    lots.push({ zone: { key: 'equipment-yard', label: 'Equipment yard', kind: 'parking', ...sized(28, 14, at('other').length) }, machines: at('other') });
  }
  lots.push({ zone: { key: 'workshop', label: 'Maintenance & breakdown bay', kind: 'maintenance_workshop', ...sized(36, 22, bay.length) }, machines: bay, heading: 90 });

  // Wide enough for the lots in a little under two parts width to one part depth, the
  // proportion a screen shows best, and never narrower than the widest lot.
  const area = lots.reduce((a, l) => a + (l.zone.widthM + 8) * (l.zone.depthM + 8), 0);
  const widest = Math.max(...lots.map((l) => l.zone.widthM)) + 2 * MARGIN;
  const WIDTH = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widest, Math.ceil(Math.sqrt(area * 1.8) / 10) * 10));

  // Pack the lots in rows, left to right, between the road bands.
  const usable = WIDTH - 2 * MARGIN;
  const placed: { lot: Lot; x: number; y: number }[] = [];
  let x = 0; let y = 0; let rowDepth = 0;
  for (const lot of lots) {
    const w = Math.min(lot.zone.widthM, usable);
    if (x > 0 && x + w > usable) { y += rowDepth + 8; x = 0; rowDepth = 0; }
    placed.push({ lot, x, y });
    x += w + 8;
    rowDepth = Math.max(rowDepth, lot.zone.depthM);
  }
  const middle = y + rowDepth;
  const depth = Math.max(90, round(middle + 2 * BAND + 2 * MARGIN));
  // Centred between the bands, so a short site has its slack on both sides, not one.
  const top = round(-middle / 2);

  const zones: ZoneInput[] = [];
  const placements: PlacementInput[] = [];
  const pending: { zone: ZoneInput; lot: Lot }[] = [];
  for (const { lot, x: lx, y: ly } of placed) {
    const w = Math.min(lot.zone.widthM, usable);
    const zone: ZoneInput = { ...lot.zone, widthM: w, x: round(-WIDTH / 2 + MARGIN + lx + w / 2), z: round(top + ly + lot.zone.depthM / 2) };
    zones.push(zone);
    pending.push({ zone, lot });
  }

  // The bands: the road being built along the north edge in three sections, the access
  // road and gate along the south.
  const north = -depth / 2 + MARGIN + 6;
  const south = depth / 2 - MARGIN - 5;
  const third = (WIDTH - 2 * MARGIN) / 3;
  if (has('earthmoving')) {
    ['a', 'b', 'c'].forEach((s, i) => zones.push({
      key: `road-${s}`, label: `Main road – section ${s.toUpperCase()}`, kind: 'road',
      x: round(-WIDTH / 2 + MARGIN + third * (i + 0.5)), z: round(north), widthM: round(third - 2), depthM: 12,
      progressPct: [100, 45, 0][i],
    }));
  }
  zones.push(
    { key: 'gate', label: 'Main gate', kind: 'gate', x: -WIDTH / 2 + 7, z: round(south), widthM: 10, depthM: 12 },
    { key: 'access-road', label: 'Site access road', kind: 'road', x: 6, z: round(south), widthM: WIDTH - 2 * MARGIN - 14, depthM: 9, progressPct: 100 },
  );

  const have = new Set(zones.map((z) => z.key));
  for (const { zone, lot } of pending) {
    const route = lot.route?.(have) ?? [];
    slots(zone, lot.machines.length).forEach(([px, pz], i) => placements.push({
      sourceSystem: lot.machines[i].sourceSystem, externalId: lot.machines[i].externalId,
      x: px, z: pz, headingDeg: lot.heading ?? 0, route,
    }));
  }
  // The road front: excavators along section B, shuttling on to C as it is cut.
  const roadB = zones.find((z) => z.key === 'road-b');
  if (roadB) {
    slots({ ...roadB, depthM: 4 }, onRoad.length).forEach(([px], i) => placements.push({
      sourceSystem: onRoad[i].sourceSystem, externalId: onRoad[i].externalId,
      x: px, z: roadB.z, headingDeg: 0, route: ['road-b', 'road-c'],
    }));
  }

  return { expectedVersion, extent: { widthM: WIDTH, depthM: depth }, zones, placements };
}
