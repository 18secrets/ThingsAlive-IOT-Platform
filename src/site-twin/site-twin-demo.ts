import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { SiteTwinService } from './site-twin.service';

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

/** Progress per tick, in percentage points, for what the composer builds in stages. The
 * road is laid section by section: B until it is done, then C. */
const PROGRESS_ORDER: { keys: string[]; step: number }[] = [
  { keys: ['road-b', 'road-c'], step: 0.5 },
  { keys: ['building'], step: 0.4 },
];

const scopeFor = (tenantId: string): RequestScope => ({ tenantId, userId: DEMO_USER, roles: ['super admin'], isPlatformRole: false });

/** Lay out every demo site nobody has laid out yet, from the machines assigned to it
 * (`SiteTwinService.propose`). A site with no machines is left empty: there is nothing
 * on it to draw. Safe to call on every tick. */
export async function ensureSiteTwinDemo(ds: DataSource, tenantId: string): Promise<void> {
  const twins = new SiteTwinService(ds);
  const scope = scopeFor(tenantId);
  const plants: { id: string; code: string }[] = await ds.query(
    `SELECT id, code FROM plant WHERE tenant_id = $1 AND status = 'active'`, [tenantId],
  );
  for (const plant of plants) {
    const current = await twins.read(scope, plant.id);
    if (current.saved || !current.machines.length) continue;
    const layout = await twins.propose(scope, plant.id);
    await twins.save(scope, plant.id, layout);
    console.log(`[SiteTwin] Laid out ${plant.code} from its ${current.machines.length} machines: ${layout.zones.length} zones.`);
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
       VALUES ($1, $2, $3, $4, '%', $5, $5, 'live')`,
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
