import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { LayoutInput, SiteTwinService, ZoneInput } from '../src/site-twin/site-twin.service';

/**
 * The demo sites' digital twins, for `stream-demo-telemetry.ts`.
 *
 * Demo only. Each demo site gets its own layout once, if nobody has laid it out yet,
 * and from then on each tick does two things through the same paths a real site uses:
 *
 * - writes `engine_load` for every machine on the site that is reporting, in a
 *   working/idle cycle, so the twin's activity comes out of duty-cycle's `classify`
 *   exactly as it would for a real logger — the twin animates a machine because its
 *   data says it is working, not because this script says so;
 * - reports a little more progress on the structures built in stages, through
 *   `SiteTwinService.reportProgress`, dated and attributed to `demo-stream`.
 *
 * A site an admin has already laid out is never overwritten; only its progress moves,
 * and only on structures whose key this script owns.
 */

const DEMO_USER = 'demo-stream';

interface Scenario {
  extent: { widthM: number; depthM: number };
  zones: ZoneInput[];
  /** externalId → where it works, and the zones it shuttles between when it does. */
  placements: Record<string, { x: number; z: number; headingDeg: number; route?: string[] }>;
  /** zone key → percentage points added per tick, up to 100. */
  progressPerTick: Record<string, number>;
}

/** A ring-road package: offices by the gate, the batching plant and workshop in the
 * middle, the road being laid along the north edge, a block going up, a substation. */
const CONSTRUCTION: Scenario = {
  extent: { widthM: 240, depthM: 150 },
  zones: [
    { key: 'gate', label: 'Main gate', kind: 'gate', x: -114, z: 55, widthM: 10, depthM: 14 },
    { key: 'haul-road', label: 'Site haul road', kind: 'road', x: 0, z: 55, widthM: 210, depthM: 10, progressPct: 100 },
    { key: 'ring-road', label: 'Ring road – chainage 4+200 to 4+400', kind: 'road', x: 10, z: -62, widthM: 200, depthM: 12, progressPct: 35 },
    { key: 'head-office', label: 'Head office', kind: 'head_office', x: -95, z: -30, widthM: 28, depthM: 18 },
    { key: 'site-office', label: 'Site office', kind: 'site_office', x: -95, z: 10, widthM: 26, depthM: 10 },
    { key: 'parking', label: 'Staff parking', kind: 'parking', x: -95, z: 32, widthM: 26, depthM: 12 },
    { key: 'batching-plant', label: 'Batching plant', kind: 'batching_plant', x: -45, z: 20, widthM: 34, depthM: 26 },
    { key: 'material-yard', label: 'Aggregate yard', kind: 'material_yard', x: -45, z: -20, widthM: 30, depthM: 22 },
    { key: 'workshop', label: 'Maintenance workshop', kind: 'maintenance_workshop', x: 5, z: 25, widthM: 30, depthM: 22 },
    { key: 'block-a', label: 'Admin block A', kind: 'building', x: 50, z: -15, widthM: 34, depthM: 24, floors: 8, progressPct: 40 },
    { key: 'excavation-b', label: 'Excavation – Block B', kind: 'work_area', x: 50, z: 25, widthM: 34, depthM: 22 },
    { key: 'substation', label: '33/11 kV substation', kind: 'substation', x: 100, z: 15, widthM: 24, depthM: 30, progressPct: 60 },
    { key: 'fuel-store', label: 'Fuel store', kind: 'restricted', x: 100, z: -30, widthM: 24, depthM: 24 },
  ],
  placements: {
    'EX-01': { x: 46, z: 25, headingDeg: 30 },
    'EX-02': { x: -30, z: -62, headingDeg: 0, route: ['ring-road', 'material-yard'] },
    'EX-03': { x: 50, z: -2, headingDeg: 270 },
    'EX-04': { x: 2, z: 26, headingDeg: 90 },
    'EX-05': { x: -48, z: -20, headingDeg: 180, route: ['material-yard', 'batching-plant'] },
    'EX-06': { x: 96, z: 26, headingDeg: 0 },
  },
  progressPerTick: { 'ring-road': 0.5, 'block-a': 0.4, substation: 0.3 },
};

/** A depot: receiving gate, offices, workshop, container stacks and a yard. */
const DEPOT: Scenario = {
  extent: { widthM: 160, depthM: 100 },
  zones: [
    { key: 'gate', label: 'Depot gate', kind: 'gate', x: -74, z: 30, widthM: 10, depthM: 14 },
    { key: 'yard-road', label: 'Yard road', kind: 'road', x: 0, z: 30, widthM: 140, depthM: 9, progressPct: 100 },
    { key: 'site-office', label: 'Depot office', kind: 'site_office', x: -55, z: -25, widthM: 26, depthM: 10 },
    { key: 'workshop', label: 'Maintenance workshop', kind: 'maintenance_workshop', x: -10, z: -20, widthM: 30, depthM: 24 },
    { key: 'containers', label: 'Container stacks', kind: 'container_yard', x: 45, z: -20, widthM: 50, depthM: 30 },
    { key: 'material-yard', label: 'Steel and formwork yard', kind: 'material_yard', x: 45, z: 12, widthM: 50, depthM: 18 },
  ],
  placements: {},
  progressPerTick: {},
};

/** Which scenario each demo site gets, by site code; any other site gets the depot. */
const SCENARIO_BY_CODE: Record<string, Scenario> = { 'PUNE-01': CONSTRUCTION, 'PUNE-02': DEPOT };

const scopeFor = (tenantId: string): RequestScope => ({ tenantId, userId: DEMO_USER, roles: ['super admin'], isPlatformRole: false });

/** Lay out every demo site nobody has laid out yet. Safe to call on every tick. */
export async function ensureSiteTwinDemo(ds: DataSource, tenantId: string): Promise<void> {
  const twins = new SiteTwinService(ds);
  const scope = scopeFor(tenantId);
  const plants: { id: string; code: string }[] = await ds.query(
    `SELECT id, code FROM plant WHERE tenant_id = $1 AND status = 'active'`, [tenantId],
  );
  for (const plant of plants) {
    const current = await twins.read(scope, plant.id);
    if (current.saved) continue;
    const scenario = SCENARIO_BY_CODE[plant.code] ?? DEPOT;
    const layout: LayoutInput = {
      expectedVersion: current.version,
      extent: scenario.extent,
      zones: scenario.zones,
      placements: current.machines.flatMap((e) => {
        const p = scenario.placements[e.externalId];
        return p ? [{ sourceSystem: e.sourceSystem, externalId: e.externalId, ...p }] : [];
      }),
    };
    await twins.save(scope, plant.id, layout);
    console.log(`[SiteTwin] Laid out ${plant.code}: ${layout.zones.length} zones, ${layout.placements.length} machines placed.`);
  }
}

/** One tick of site life: engine load for the reporting machines, progress on what is
 * being built. */
export async function tickSiteTwinDemo(ds: DataSource, tenantId: string, now: Date): Promise<void> {
  // Engine load through each machine's own bound device, only for machines that
  // reported their engine running in the last two minutes — a machine that has gone
  // quiet stays quiet rather than coming back to life on load alone.
  const bound: { imei: string; signal_key: string; external_id: string }[] = await ds.query(
    `SELECT b.imei, b.signal_key, b.external_id
       FROM signal_binding_version b
       JOIN equipment_profile e ON e.tenant_id = b.tenant_id AND e.source_system = b.source_system AND e.external_id = b.external_id
      WHERE b.tenant_id = $1 AND b.measurement_role = 'engine_load' AND b.is_primary AND b.status = 'active'
        AND b.imei IS NOT NULL AND e.plant_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM signal_binding_version rs
            JOIN telemetry_reading r ON r.tenant_id = rs.tenant_id AND r.imei = rs.imei AND r.signal = rs.signal_key
           WHERE rs.tenant_id = b.tenant_id AND rs.source_system = b.source_system AND rs.external_id = b.external_id
             AND rs.measurement_role = 'engine_running_status' AND rs.is_primary AND rs.status = 'active'
             AND r.value <> 0 AND r.source_timestamp > $2::timestamptz - interval '2 minutes' AND r.source_timestamp <= $2)`,
    [tenantId, now],
  );
  const minute = Math.floor(now.getTime() / 60_000);
  for (const [i, b] of bound.entries()) {
    // Ten-minute cycle, seven working and three idling, staggered so the site never
    // stops all at once. 20% is duty-cycle's working threshold.
    const working = (minute + i * 3) % 10 < 7;
    const load = working ? 55 + ((minute * 7 + i * 13) % 20) : 8 + ((minute + i) % 6);
    await ds.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ($1, $2, $3, $4, '%', $5, $5, 'live')`,
      [tenantId, b.imei, b.signal_key, load, now],
    );
  }

  const twins = new SiteTwinService(ds);
  const scope = scopeFor(tenantId);
  const plants: { id: string; code: string }[] = await ds.query(
    `SELECT id, code FROM plant WHERE tenant_id = $1 AND status = 'active'`, [tenantId],
  );
  for (const plant of plants) {
    const scenario = SCENARIO_BY_CODE[plant.code];
    if (!scenario) continue;
    const { zones } = await twins.read(scope, plant.id);
    for (const [key, step] of Object.entries(scenario.progressPerTick)) {
      const zone = zones.find((z) => z.key === key);
      if (!zone || zone.progressPct === null || zone.progressPct >= 100) continue;
      const next = Math.min(100, Math.round((zone.progressPct + step) * 10) / 10);
      await twins.reportProgress(scope, plant.id, key, next, now);
    }
  }
}
