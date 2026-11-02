import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { PAIRING_TOLERANCE_MS } from '../catalog/formula/geofence';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { withTenantSession } from '../scope/tenant-session';
import { GeofenceZone } from './entities/geofence-zone.entity';
import { zoneAppliesTo } from './geofence.service';
import { insideZone, violates, ZoneKind, ZoneShape } from './geometry';

/** A position older than this is shown, but as stale: where it was, not where it is. */
export const LIVE_POSITION_SECONDS = 15 * 60;
/** How far back a latest position is looked for. Older than a day is no position at all. */
export const POSITION_LOOKBACK_HOURS = 24;

export interface FleetZone {
  key: string;
  id: string | null;
  source: 'zone' | 'site-boundary';
  code: string;
  name: string;
  kind: ZoneKind;
  shape: ZoneShape;
  appliesTo: string;
}

export interface FleetMachineStatus {
  sourceSystem: string;
  externalId: string;
  name: string | null;
  site: { id: string; code: string; name: string } | null;
  /** Null when no paired latitude and longitude arrived in the last day. */
  position: { lng: number; lat: number; at: string; ageSeconds: number; imei: string } | null;
  positionStatus: 'live' | 'stale' | 'none';
  /** Every zone that applies to the machine, by key into `zones`; empty without a position. */
  zones: { key: string; inside: boolean; violation: boolean }[];
  /** Any zone broken at the latest position. False without a position — unknown is not "fine", */
  /** so read it with `positionStatus`. */
  violating: boolean;
}

export interface FleetStatus {
  asOf: string;
  /** Every zone any listed machine has, shapes included, so a map draws in one call. */
  zones: FleetZone[];
  machines: FleetMachineStatus[];
  summary: { machines: number; live: number; stale: number; noPosition: number; violating: number };
}

/**
 * Where every machine is now, against its fences (task QGEO2, fleet map). Computed from the
 * latest readings on each request rather than from visits: visits are derived on shift
 * boundaries (D12), and a map that waits for the shift to end shows where machines were.
 *
 * Read-only and bounded: one query each for machines, sites, zones, loggers and the latest
 * positions within a day. Scope as the zone API: a machine outside the caller's scope is not
 * listed, and a site they cannot see is neither named nor drawn.
 */
@Injectable()
export class FleetStatusService {
  constructor(private readonly ds: DataSource) {}

  async status(scope: RequestScope, filter: { plantId?: string } = {}, now = new Date()): Promise<FleetStatus> {
    return withTenantSession(this.ds, scope, async (m) => {
      const machineWhere: Record<string, unknown> = { tenantId: scope.tenantId };
      if (filter.plantId) machineWhere.plantId = filter.plantId;
      if (scope.equipmentIds !== undefined) machineWhere.externalId = In([...scope.equipmentIds]);
      const machines = scope.equipmentIds?.length === 0 ? [] : await m.getRepository(EquipmentProfile).find({
        where: machineWhere, order: { externalId: 'ASC' },
      });

      const plantIds = [...new Set(machines.map((e) => e.plantId).filter((p): p is string => !!p))]
        .filter((p) => scope.plantIds === undefined || scope.plantIds.includes(p));
      const plants = plantIds.length
        ? await m.getRepository(Plant).find({ where: { tenantId: scope.tenantId, id: In(plantIds) } })
        : [];
      const plantById = new Map(plants.map((p) => [p.id, p]));
      const zoneRows = await m.getRepository(GeofenceZone).find({ where: { tenantId: scope.tenantId, enabled: true }, order: { code: 'ASC' } });

      // The inventory keys a claim by external id alone (see OnboardingStatusService).
      const claims: { imei: string; externalId: string }[] = machines.length ? await m.query(
        `SELECT imei, equipment_external_id AS "externalId" FROM device_inventory
          WHERE tenant_id = $1 AND state = 'assigned' AND equipment_external_id = ANY($2::text[])`,
        [scope.tenantId, machines.map((e) => e.externalId)],
      ) : [];
      const latest: { imei: string; signal: string; value: number; at: Date }[] = claims.length ? await m.query(
        `SELECT DISTINCT ON (imei, signal) imei, signal, value, source_timestamp AS at
           FROM telemetry_reading
          WHERE tenant_id = $1 AND imei = ANY($2::text[]) AND signal IN ('latitude', 'longitude')
            AND source_timestamp > $3 AND source_timestamp <= $4
          ORDER BY imei, signal, source_timestamp DESC`,
        [scope.tenantId, claims.map((c) => c.imei), new Date(now.getTime() - POSITION_LOOKBACK_HOURS * 3_600_000), now],
      ) : [];

      const zones = new Map<string, FleetZone>();
      const out: FleetMachineStatus[] = machines.map((e) => {
        const plant = e.plantId ? plantById.get(e.plantId) ?? null : null;
        const applied: FleetZone[] = [];
        if (plant?.boundary) {
          applied.push({
            key: `site:${plant.id}`, id: null, source: 'site-boundary', code: `site:${plant.code}`, name: plant.name,
            kind: 'allowed', shape: plant.boundary, appliesTo: 'plant',
          });
        }
        for (const z of zoneRows.filter((r) => zoneAppliesTo(r, e) && visibleZone(scope, r))) {
          applied.push({ key: `zone:${z.id}`, id: z.id, source: 'zone', code: z.code, name: z.name, kind: z.kind, shape: z.shape, appliesTo: z.appliesTo });
        }
        for (const z of applied) zones.set(z.key, z);

        const position = freshestPosition(claims.filter((c) => c.externalId === e.externalId).map((c) => c.imei), latest, now);
        const checks = position
          ? applied.map((z) => {
            const inside = insideZone(z.shape, [position.lng, position.lat]);
            return { key: z.key, inside, violation: violates(z.kind, inside) };
          })
          : [];
        return {
          sourceSystem: e.sourceSystem, externalId: e.externalId, name: e.name,
          site: plant ? { id: plant.id, code: plant.code, name: plant.name } : null,
          position,
          positionStatus: !position ? 'none' : position.ageSeconds <= LIVE_POSITION_SECONDS ? 'live' : 'stale',
          zones: checks,
          violating: checks.some((c) => c.violation),
        };
      });

      return {
        asOf: now.toISOString(),
        zones: [...zones.values()],
        machines: out,
        summary: {
          machines: out.length,
          live: out.filter((s) => s.positionStatus === 'live').length,
          stale: out.filter((s) => s.positionStatus === 'stale').length,
          noPosition: out.filter((s) => s.positionStatus === 'none').length,
          violating: out.filter((s) => s.violating).length,
        },
      };
    });
  }
}

/**
 * The newest position among a machine's loggers: a latitude and a longitude from the same
 * logger, within QGEO1's pairing tolerance of each other — half a position is not one.
 */
function freshestPosition(
  imeis: string[], latest: { imei: string; signal: string; value: number; at: Date }[], now: Date,
): FleetMachineStatus['position'] {
  let best: FleetMachineStatus['position'] = null;
  for (const imei of imeis) {
    const lat = latest.find((r) => r.imei === imei && r.signal === 'latitude');
    const lng = latest.find((r) => r.imei === imei && r.signal === 'longitude');
    if (!lat || !lng) continue;
    const latAt = new Date(lat.at).getTime();
    const lngAt = new Date(lng.at).getTime();
    if (Math.abs(latAt - lngAt) > PAIRING_TOLERANCE_MS) continue;
    const at = Math.max(latAt, lngAt);
    if (best && Date.parse(best.at) >= at) continue;
    best = {
      lng: Number(lng.value), lat: Number(lat.value), at: new Date(at).toISOString(),
      ageSeconds: Math.max(0, Math.round((now.getTime() - at) / 1000)), imei,
    };
  }
  return best;
}

function visibleZone(scope: RequestScope, z: GeofenceZone): boolean {
  if (z.appliesTo === 'plant') return scope.plantIds === undefined || scope.plantIds.includes(z.plantId!);
  if (z.appliesTo === 'equipment') return scope.equipmentIds === undefined || scope.equipmentIds.includes(z.externalId!);
  return true;
}
