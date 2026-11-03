import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { LayoutInput, SiteTwinService } from './site-twin.service';

/**
 * The demo sites' digital twins, for the demo streams: `seed-demo --top-up --follow`
 * (what Railway's demo-stream runs) and `scripts/stream-demo-telemetry.ts`.
 *
 * Demo only. Each demo site with machines gets its layout once, if nobody has laid it
 * out yet — composed from the machines assigned to it and their categories, so the
 * twin shows only plant the site has — and from then on each tick does two things
 * through the same paths a real site uses:
 *
 * - writes `engine_load` for every machine on the site that is reporting, in a
 *   working/idle cycle, so the twin's activity comes out of duty-cycle's `classify`
 *   exactly as it would for a real logger — the twin animates a machine because its
 *   data says it is working, not because this script says so;
 * - reports a little more progress on the structures built in stages, through
 *   `SiteTwinService.reportProgress`, dated and attributed to `demo-stream`.
 *
 * A site an admin has already laid out is never overwritten; only its progress moves,
 * and only on the composer's own keys.
 */

const DEMO_USER = 'demo-stream';

/** The seed demo tenant (seed-demo's DEMO_TENANT). Its twin is drawn as a simulation —
 * every machine at a work front moves and tippers haul — and says so on screen. No real
 * customer's twin is: theirs moves only on their own live data. */
export const SIMULATED_TENANTS: ReadonlySet<string> = new Set(['demo-construction']);

/** Progress per tick, in percentage points, for what the composer builds in stages. The
 * road is laid section by section: B until it is done, then C. */
const PROGRESS_ORDER: { keys: string[]; step: number }[] = [
  { keys: ['road-b', 'road-c'], step: 0.5 },
  { keys: ['building'], step: 0.4 },
];

const scopeFor = (tenantId: string): RequestScope => ({ tenantId, userId: DEMO_USER, roles: ['super admin'], isPlatformRole: false });

/** Lay out every demo site that has machines, from those machines
 * (`SiteTwinService.propose`). A site with no machines is left empty: there is nothing
 * on it to draw.
 *
 * A layout this script made is re-composed when the site's equipment changes — a machine
 * assigned, moved away, or into or out of the breakdown bay — keeping the progress
 * already reported on each structure. A layout anybody else saved is never touched.
 * Safe to call on every tick. */
export async function ensureSiteTwinDemo(ds: DataSource, tenantId: string): Promise<void> {
  const twins = new SiteTwinService(ds);
  const scope = scopeFor(tenantId);
  const plants: { id: string; code: string }[] = await ds.query(
    `SELECT id, code FROM plant WHERE tenant_id = $1 AND status = 'active'`, [tenantId],
  );
  for (const plant of plants) {
    const current = await twins.read(scope, plant.id);
    if (!current.machines.length) continue;
    if (current.saved && current.updatedBy !== DEMO_USER) continue;
    const layout = await twins.propose(scope, plant.id);
    if (current.saved && sameShape(current, layout)) continue;
    // Progress is the site's report, not the composer's: carry it across.
    const reported = new Map(current.zones.map((z) => [z.key, z.progressPct]));
    layout.zones = layout.zones.map((z) => (reported.has(z.key) && reported.get(z.key) !== null
      ? { ...z, progressPct: reported.get(z.key)! } : z));
    await twins.save(scope, plant.id, layout);
    console.log(`[SiteTwin] ${current.saved ? 'Re-composed' : 'Laid out'} ${plant.code} from its ${current.machines.length} machines: ${layout.zones.length} zones.`);
    // A first day on a demo site is not day one of the project: the building has risen
    // a little. Reported, like any other progress, once.
    if (!current.saved && layout.zones.some((z) => z.key === 'building')) {
      await twins.reportProgress(scope, plant.id, 'building', 25);
    }
  }
}

/** Whether a saved layout already has the zones and machine spots a proposal would. */
function sameShape(current: Awaited<ReturnType<SiteTwinService['read']>>, proposal: LayoutInput): boolean {
  const zones = (keys: string[]) => [...keys].sort().join(',');
  if (zones([...current.zones.map((z) => z.key), ...current.hiddenZones]) !== zones(proposal.zones.map((z) => z.key))) return false;
  const spot = (k: string, p: { x: number; z: number }) => `${k}@${p.x},${p.z}`;
  const now = [...current.placements].map(([k, p]) => spot(k, p)).sort().join(';');
  const next = proposal.placements.map((p) => spot(`${p.sourceSystem}/${p.externalId}`, p)).sort().join(';');
  return now === next;
}

/**
 * Machines the demo sets up as well as streams, by external id. Asked for by name (Tapas,
 * 2026-11-03): two test machines on plant 0483 that showed "Not set up" on the twin — one
 * with a class and no bindings, one with no class. Named rather than "every unbound
 * machine", because some demo machines are unbound on purpose (EX-06 is "partly unbound"
 * so its page shows what that looks like).
 */
export const TWIN_DEMO_ONBOARD = ['TEST-DIPPY-LIB-01', 'TEST-DIPPY-NOLIB-01'];
const ONBOARD_CLASS = 'demo-excavator';

/** A plausible reading for a role on a working excavator, with a little noise. */
function workingValue(role: string, minute: number, i: number): number {
  const n = ((minute * 7 + i * 13) % 10) / 10 - 0.5;
  switch (role) {
    case 'engine_running_status': return 1;
    case 'engine_load': return 62 + 8 * n;
    case 'engine_coolant_temperature': return 84 + 3 * n;
    case 'engine_oil_pressure': return 390 + 12 * n;
    case 'hydraulic_oil_temperature': return 61 + 2 * n;
    case 'fuel_level': return 58 + 4 * n;
    default: return 50 + 5 * n;
  }
}

/**
 * Set up the named machines and keep them reporting: a class where they have none, a
 * primary binding for every signal their class requires, each on a demo device
 * `TWIN-DEMO-<id>`, and a reading per signal on every call. Idempotent: a machine that
 * already has a class keeps it, a role that is already bound is not bound again.
 */
export async function onboardTwinDemoMachines(ds: DataSource, tenantId: string, now: Date): Promise<void> {
  const machines: { source_system: string; external_id: string; equipment_class_slug: string | null; class_version: number | null }[] =
    await ds.query(
      `SELECT source_system, external_id, equipment_class_slug, class_version FROM equipment_profile
        WHERE tenant_id = $1 AND external_id = ANY($2::text[])`, [tenantId, TWIN_DEMO_ONBOARD],
    );
  const minute = Math.floor(now.getTime() / 60_000);
  for (const [i, m] of machines.entries()) {
    const [cls] = await ds.query(
      `SELECT template_slug, template_version FROM client_equipment_class WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, m.equipment_class_slug ?? ONBOARD_CLASS],
    );
    if (!cls?.template_slug) continue;
    if (!m.equipment_class_slug) {
      await ds.query(
        `UPDATE equipment_profile SET equipment_class_slug = $4, class_version = $5, updated_by = $6, updated_at = now()
          WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3 AND equipment_class_slug IS NULL`,
        [tenantId, m.source_system, m.external_id, ONBOARD_CLASS, cls.template_version, DEMO_USER],
      );
    }
    const version = m.class_version ?? cls.template_version;
    const roles: { measurement_role: string; canonical_unit: string }[] = await ds.query(
      `SELECT measurement_role, canonical_unit FROM equipment_class_sensor_requirement WHERE class_slug = $1 AND class_version = $2`,
      [cls.template_slug, version],
    );
    const imei = `TWIN-DEMO-${m.external_id}`;
    for (const r of roles) {
      await ds.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
           origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
         SELECT $1, $2, $3, $4, $4, '', 'physical', $5, $4, $6, $7::timestamptz - interval '1 day', true, 'active', 'manual', $8, $7
          WHERE NOT EXISTS (
            SELECT 1 FROM signal_binding_version b
             WHERE b.tenant_id = $1 AND b.source_system = $2 AND b.external_id = $3 AND b.measurement_role = $4
               AND b.status = 'active' AND b.is_primary)`,
        [tenantId, m.source_system, m.external_id, r.measurement_role, imei, r.canonical_unit, now, DEMO_USER],
      );
      await ds.query(
        `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'live') ON CONFLICT DO NOTHING`,
        [tenantId, imei, r.measurement_role, workingValue(r.measurement_role, minute, i), r.canonical_unit, now],
      );
    }
  }
}

/** One tick of site life: progress on what is being built and, with `writeLoad`, engine
 * load for the reporting machines. `seed-demo`'s top-up already writes engine load, so it
 * passes false; a second writer would put two values on one machine's minute. */
export async function tickSiteTwinDemo(ds: DataSource, tenantId: string, now: Date, opts: { writeLoad?: boolean } = {}): Promise<void> {
  if (opts.writeLoad ?? true) await writeEngineLoad(ds, tenantId, now);
  await advanceProgress(ds, tenantId, now);
}

async function writeEngineLoad(ds: DataSource, tenantId: string, now: Date): Promise<void> {
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
       VALUES ($1, $2, $3, $4, '%', $5, $5, 'live') ON CONFLICT DO NOTHING`,
      [tenantId, b.imei, b.signal_key, load, now],
    );
  }

}

async function advanceProgress(ds: DataSource, tenantId: string, now: Date): Promise<void> {
  const twins = new SiteTwinService(ds);
  const scope = scopeFor(tenantId);
  const plants: { id: string; code: string }[] = await ds.query(
    `SELECT id, code FROM plant WHERE tenant_id = $1 AND status = 'active'`, [tenantId],
  );
  for (const plant of plants) {
    const { zones, saved } = await twins.read(scope, plant.id);
    if (!saved) continue;
    for (const { keys, step } of PROGRESS_ORDER) {
      // The first unfinished stage that has started, else the first not yet started.
      const stages = keys.map((k) => zones.find((z) => z.key === k)).filter((z): z is NonNullable<typeof z> => !!z && z.progressPct !== null);
      const zone = stages.find((z) => z.progressPct! > 0 && z.progressPct! < 100) ?? stages.find((z) => z.progressPct! < 100);
      if (!zone) continue;
      const next = Math.min(100, Math.round((zone.progressPct! + step) * 10) / 10);
      await twins.reportProgress(scope, plant.id, zone.key, next, now);
    }
  }
}
