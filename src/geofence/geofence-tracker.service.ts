import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Between, DataSource, EntityManager, IsNull, LessThanOrEqual, MoreThan } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { DomainEvent } from '../events/domain-event.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { withTenantSession } from '../scope/tenant-session';
import { GeofenceVisit } from './entities/geofence-visit.entity';
import { AppliedZone, GeofenceService } from './geofence.service';
import { violates } from './geometry';
import { planVisits, PlannedVisit, WindowReading, windowPositions } from './visit-plan';

export interface TrackWindow {
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  start: Date;
  end: Date;
  readings: WindowReading[];
}

export interface TrackResult { positions: number; entered: number; left: number; revised: number; withdrawn: number }

/**
 * Geofence visits (task QGEO2, stage 2): derived per shift window from the readings the
 * shift runner already holds, and published through the outbox (D11) so alerts, work,
 * workflows and the assistant can act on them without this knowing they exist.
 *
 * Deriving again is the normal case, not the exception. D12 scores on shift boundaries so
 * that a late reading can revise an outcome; the runner rewinds the shift and this runs
 * again. So a run reconciles — it computes what the window says and changes only what
 * differs — and each change is one event: entered, left, revised (a time that moved) or
 * withdrawn (a visit a late reading showed never happened). The same window run twice
 * writes nothing and says nothing the second time.
 *
 * A window decides only what is timestamped inside it. A leave after `end` belongs to a
 * later window, which keeps it; a visit entered after `end` is not touched at all.
 */
@Injectable()
export class GeofenceTracker {
  private readonly logger = new Logger(GeofenceTracker.name);

  constructor(
    private readonly ds: DataSource,
    private readonly zones: GeofenceService,
  ) {}

  async trackWindow(w: TrackWindow): Promise<TrackResult> {
    const scope = systemScope(w.tenantId);
    const positions = windowPositions(w.readings, w);
    const applied = await this.zones.zonesFor(scope, w.sourceSystem, w.externalId);
    const result: TrackResult = { positions: positions.length, entered: 0, left: 0, revised: 0, withdrawn: 0 };

    await withTenantSession(this.ds, scope, async (m) => {
      // One machine at a time. Two passes over the same window (a rewind racing the
      // scheduled pass) would each see "no visit yet" and both insert; the unique index
      // would stop the second, but as an error rather than as nothing to do.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`geofence:${w.tenantId}:${w.sourceSystem}:${w.externalId}`]);
      const repo = m.getRepository(GeofenceVisit);
      const machine = { tenantId: w.tenantId, sourceSystem: w.sourceSystem, externalId: w.externalId };

      // In each zone at the start: a visit entered by then and not left by then.
      const carried = await repo.find({
        where: [
          { ...machine, enteredAt: LessThanOrEqual(w.start), leftAt: IsNull() },
          { ...machine, enteredAt: LessThanOrEqual(w.start), leftAt: MoreThan(w.start) },
        ],
      });
      const within = await repo.find({ where: { ...machine, enteredAt: Between(new Date(w.start.getTime() + 1), w.end) } });
      const plan = planVisits(applied.map((z) => ({ key: z.key, shape: z.shape })), new Set(carried.map((v) => v.zoneKey)), positions);
      const zoneByKey = new Map(applied.map((z) => [z.key, z]));
      const emit = (type: string, v: GeofenceVisit, at: Date, extra: Record<string, unknown> = {}) =>
        this.emit(m, type, v, at, extra);

      // Deletions first, then closings, then openings: the open-visit index is checked
      // row by row, and a reopened visit must not meet the one it replaces.
      const planned = new Map(plan.filter((p) => p.enteredAt).map((p) => [entryKey(p.key, p.enteredAt!), p]));
      for (const v of within) {
        if (!planned.has(entryKey(v.zoneKey, v.enteredAt)) && zoneByKey.has(v.zoneKey)) {
          await repo.delete({ id: v.id });
          await emit('geofence.visit.withdrawn.v1', v, w.end);
          result.withdrawn += 1;
        }
      }

      const updates: { v: GeofenceVisit; p: PlannedVisit }[] = [];
      for (const v of carried) {
        const p = plan.find((x) => x.key === v.zoneKey && x.enteredAt === null);
        if (p) updates.push({ v, p });
        else if (!zoneByKey.has(v.zoneKey) && v.leftAt === null) {
          // The zone was removed or switched off. The machine did not move; the fence did.
          v.leftAt = w.start;
          v.leftReason = 'zone_removed';
          await repo.save(v);
          await emit('geofence.left.v1', v, w.start, { reason: 'zone_removed', violation: false });
          result.left += 1;
        }
      }
      for (const v of within) {
        const p = planned.get(entryKey(v.zoneKey, v.enteredAt));
        if (p) updates.push({ v, p });
      }
      // Closings before reopenings, for the same index.
      updates.sort((a, b) => Number(a.p.leftAt === null) - Number(b.p.leftAt === null));
      for (const { v, p } of updates) {
        // A leave after the window's end is a later window's to decide; keep it.
        const keepLater = p.leftAt === null && v.leftAt !== null && v.leftAt.getTime() > w.end.getTime();
        const leftAt = keepLater ? v.leftAt : p.leftAt;
        if ((v.leftAt?.getTime() ?? null) === (leftAt?.getTime() ?? null)) continue;
        const before = v.leftAt;
        v.leftAt = leftAt;
        v.leftReason = leftAt ? 'exited' : null;
        v.exitLng = leftAt ? p.exit![0] : null;
        v.exitLat = leftAt ? p.exit![1] : null;
        await repo.save(v);
        if (before === null) {
          await emit('geofence.left.v1', v, leftAt!, leftExtra(v));
          result.left += 1;
        } else {
          await emit('geofence.visit.revised.v1', v, leftAt ?? before, { previousLeftAt: before.toISOString() });
          result.revised += 1;
        }
      }

      const fresh = plan.filter((p) => p.enteredAt && !within.some((v) => v.zoneKey === p.key
        && v.enteredAt.getTime() === p.enteredAt!.getTime()));
      fresh.sort((a, b) => Number(a.leftAt === null) - Number(b.leftAt === null));
      for (const p of fresh) {
        const z = zoneByKey.get(p.key)!;
        const v = await repo.save(repo.create({
          ...machine, ...snapshot(z), enteredAt: p.enteredAt!, entryLng: p.entry![0], entryLat: p.entry![1],
          leftAt: p.leftAt, exitLng: p.exit?.[0] ?? null, exitLat: p.exit?.[1] ?? null,
          leftReason: p.leftAt ? 'exited' : null,
        }));
        await emit('geofence.entered.v1', v, v.enteredAt, { violation: violates(v.zoneKind, true) });
        result.entered += 1;
        if (v.leftAt) {
          await emit('geofence.left.v1', v, v.leftAt, leftExtra(v));
          result.left += 1;
        }
      }
    });

    if (result.entered || result.left || result.revised || result.withdrawn) {
      this.logger.log(`${w.tenantId}/${w.externalId}: ${JSON.stringify(result)}`);
    }
    return result;
  }

  /** A machine's visits, newest first; or one zone's. Scoped as the zones are. */
  async visits(
    scope: RequestScope,
    of: { sourceSystem: string; externalId: string } | { zoneId: string },
    range: { from?: Date; to?: Date } = {},
  ): Promise<GeofenceVisit[]> {
    if ('zoneId' in of) await this.zones.get(scope, of.zoneId);
    return withTenantSession(this.ds, scope, async (m) => {
      const where: Record<string, unknown> = { tenantId: scope.tenantId };
      if ('zoneId' in of) {
        where.zoneId = of.zoneId;
      } else {
        if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(of.externalId)) {
          throw new NotFoundException('No such machine in this account.');
        }
        const found = await m.getRepository(EquipmentProfile).findOne({
          where: { tenantId: scope.tenantId, sourceSystem: of.sourceSystem, externalId: of.externalId },
        });
        if (!found) throw new NotFoundException('No such machine in this account.');
        where.sourceSystem = of.sourceSystem;
        where.externalId = of.externalId;
      }
      if (range.from && range.to) where.enteredAt = Between(range.from, range.to);
      else if (range.from) where.enteredAt = MoreThan(range.from);
      else if (range.to) where.enteredAt = LessThanOrEqual(range.to);
      const rows = await m.getRepository(GeofenceVisit).find({ where, order: { enteredAt: 'DESC' }, take: 500 });
      return rows.filter((v) => visibleVisit(scope, v));
    });
  }

  private async emit(m: EntityManager, type: string, v: GeofenceVisit, at: Date, extra: Record<string, unknown>) {
    const events = m.getRepository(DomainEvent);
    await events.save(events.create({
      eventType: type,
      tenantId: v.tenantId,
      subject: `${v.sourceSystem}/${v.externalId}/${v.zoneKey}`,
      payload: {
        visitId: v.id, zoneId: v.zoneId, zoneKey: v.zoneKey, zoneSource: v.zoneSource, zoneCode: v.zoneCode,
        zoneName: v.zoneName, zoneKind: v.zoneKind, sourceSystem: v.sourceSystem, externalId: v.externalId,
        enteredAt: v.enteredAt.toISOString(), entry: [v.entryLng, v.entryLat],
        leftAt: v.leftAt?.toISOString() ?? null, exit: v.exitLng === null ? null : [v.exitLng, v.exitLat],
        ...extra,
      },
      occurredAt: at,
      deliveryState: 'pending',
    }));
  }
}

function systemScope(tenantId: string): RequestScope {
  return { tenantId, userId: 'system:geofence', roles: ['system'], isPlatformRole: false, capabilities: [] };
}

function entryKey(key: string, at: Date): string {
  return `${key}@${at.getTime()}`;
}

function snapshot(z: AppliedZone) {
  return { zoneKey: z.key, zoneId: z.id, zoneSource: z.source, zoneCode: z.code, zoneName: z.name, zoneKind: z.kind };
}

function leftExtra(v: GeofenceVisit): Record<string, unknown> {
  return {
    reason: 'exited',
    violation: violates(v.zoneKind, false),
    dwellSeconds: Math.round((v.leftAt!.getTime() - v.enteredAt.getTime()) / 1000),
  };
}

/** A site-boundary visit names the site; hidden from someone who cannot see it. */
function visibleVisit(scope: RequestScope, v: GeofenceVisit): boolean {
  if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(v.externalId)) return false;
  if (v.zoneSource === 'site-boundary' && scope.plantIds !== undefined) {
    return scope.plantIds.includes(v.zoneKey.slice('site:'.length));
  }
  return true;
}
