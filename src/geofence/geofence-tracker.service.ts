import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

export interface TimeInZoneRow {
  sourceSystem: string;
  externalId: string;
  zoneKey: string;
  zoneCode: string;
  zoneName: string;
  zoneKind: string;
  /** The local day, YYYY-MM-DD, in the time zone asked for. */
  day: string;
  hours: number;
}

/** A report range is bounded (D12: no unbounded query); a quarter covers any monthly view. */
export const MAX_REPORT_DAYS = 92;

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

  /**
   * Hours inside each zone, per machine, zone and local day (task QGEO2, stage 3), from
   * the visits. A visit still open counts up to now, never past it — time not yet
   * happened is not time spent. Days are cut in the time zone asked for, since a shift
   * report in Pune and the server's UTC disagree about where a day ends.
   */
  async timeInZone(
    scope: RequestScope,
    q: { from: Date; to: Date; timezone?: string; sourceSystem?: string; externalId?: string; zoneId?: string },
    now = new Date(),
  ): Promise<TimeInZoneRow[]> {
    if (!(q.to > q.from)) throw new BadRequestException('to comes after from.');
    if (q.to.getTime() - q.from.getTime() > MAX_REPORT_DAYS * 86_400_000) {
      throw new BadRequestException(`A report covers at most ${MAX_REPORT_DAYS} days.`);
    }
    // One without the other would quietly widen the report to every machine.
    if (!q.sourceSystem !== !q.externalId) throw new BadRequestException('sourceSystem and externalId go together.');
    if (q.zoneId) await this.zones.get(scope, q.zoneId);
    const tz = q.timezone ?? 'UTC';
    return withTenantSession(this.ds, scope, async (m) => {
      // Asked of Postgres, which knows every zone name it can convert with.
      const [{ ok }] = await m.query(`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS ok`, [tz]);
      if (!ok) throw new BadRequestException(`"${tz}" is not a time zone name, e.g. Asia/Kolkata.`);
      const rows: (TimeInZoneRow & { zoneSource: string })[] = await m.query(
        `WITH v AS (
           SELECT source_system, external_id, zone_key, zone_code, zone_name, zone_kind, zone_source,
                  greatest(entered_at, $2::timestamptz) AS s,
                  least(coalesce(left_at, $4::timestamptz), $3::timestamptz, $4::timestamptz) AS e
             FROM geofence_visit
            WHERE tenant_id = $1 AND entered_at < $3 AND coalesce(left_at, $4) > $2
              AND ($6::text IS NULL OR (source_system = $6 AND external_id = $7))
              AND ($8::uuid IS NULL OR zone_id = $8)
         ), d AS (
           SELECT v.*, gs AS day_local
             FROM v, generate_series(date_trunc('day', v.s AT TIME ZONE $5),
                                     date_trunc('day', (v.e - interval '1 microsecond') AT TIME ZONE $5),
                                     interval '1 day') gs
            WHERE v.e > v.s
         )
         SELECT source_system AS "sourceSystem", external_id AS "externalId", zone_key AS "zoneKey",
                zone_code AS "zoneCode", zone_name AS "zoneName", zone_kind AS "zoneKind", zone_source AS "zoneSource",
                to_char(day_local, 'YYYY-MM-DD') AS day,
                round((sum(extract(epoch FROM least(e, (day_local + interval '1 day') AT TIME ZONE $5)
                                         - greatest(s, day_local AT TIME ZONE $5))) / 3600)::numeric, 4)::float8 AS hours
           FROM d
          GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
          ORDER BY day, "externalId", "zoneCode"`,
        [scope.tenantId, q.from, q.to, now, tz, q.sourceSystem ?? null, q.externalId ?? null, q.zoneId ?? null],
      );
      return rows
        .filter((r) => visibleVisit(scope, { externalId: r.externalId, zoneSource: r.zoneSource, zoneKey: r.zoneKey } as GeofenceVisit))
        .map(({ zoneSource: _s, ...r }) => r);
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
