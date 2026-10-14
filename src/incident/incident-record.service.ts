import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { can, Capability } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { Severity, SEVERITY_ORDER } from '../common/severity';
import { AppUser } from '../identity/entities/app-user.entity';
import { runTenantSpanning, withTenantSession } from '../scope/tenant-session';
import { WorkOrder, WorkOrderPriority } from '../work/entities/work-order.entity';
import { WorkOrderService } from '../work/services/work-order.service';
import { Incident, IncidentStatus } from './entities/incident.entity';
import { IncidentAlert, IncidentEvent, IncidentEventKind, IncidentSlaPolicy } from './entities/incident-link.entities';

const OPEN_WORK = ['created', 'in-progress'];
const UNRESOLVED_ALERT = ['open', 'acknowledged'];

/** Where a clock stands. `no_policy` is an answer, not an absence: nobody promised a time. */
export type SlaState = 'no_policy' | 'on_track' | 'met' | 'breached';

export interface IncidentRecord {
  id: string;
  machine: { sourceSystem: string; externalId: string };
  severity: Severity;
  status: IncidentStatus;
  ownerUserId: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  escalationLevel: number;
  sla: {
    acknowledge: { dueAt: string | null; state: SlaState };
    resolve: { dueAt: string | null; state: SlaState };
  };
}

export interface IncidentDetail extends IncidentRecord {
  alerts: { id: string; severity: string; state: string; firedAt: string; summary: string }[];
  workOrders: { id: string; title: string; status: string; priority: string; assignedToUserId: string | null; alertId: string | null }[];
  timeline: { kind: IncidentEventKind; actor: string; at: string; detail: Record<string, unknown> }[];
}

export function slaState(dueAt: Date | null, doneAt: Date | null, now: Date): SlaState {
  if (!dueAt) return 'no_policy';
  if (doneAt) return doneAt <= dueAt ? 'met' : 'breached';
  return now > dueAt ? 'breached' : 'on_track';
}

export function toRecord(i: Incident, now: Date): IncidentRecord {
  return {
    id: i.id, machine: { sourceSystem: i.sourceSystem, externalId: i.externalId },
    severity: i.severity, status: i.status, ownerUserId: i.ownerUserId,
    openedAt: i.openedAt.toISOString(), acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: i.resolvedAt?.toISOString() ?? null, resolutionNote: i.resolutionNote, escalationLevel: i.escalationLevel,
    sla: {
      acknowledge: { dueAt: i.ackDueAt?.toISOString() ?? null, state: slaState(i.ackDueAt, i.acknowledgedAt, now) },
      resolve: { dueAt: i.resolveDueAt?.toISOString() ?? null, state: slaState(i.resolveDueAt, i.resolvedAt, now) },
    },
  };
}

/**
 * The incident entity's lifecycle (phase 2): open → acknowledged → resolved, with an
 * owner, an SLA clock from the account's own policy, and escalation when a clock runs
 * out. Opening is not here — `absorbAlerts` does that where alerts fire.
 *
 * Integrated rather than parallel: acknowledging an incident acknowledges its alerts,
 * resolving it resolves them with the same note, and its work is the work raised on
 * its alerts. So the alert list, the machine page and the incident view never disagree
 * with the incident about whether something is still wrong.
 */
@Injectable()
export class IncidentRecordService {
  private readonly logger = new Logger(IncidentRecordService.name);

  constructor(private readonly ds: DataSource, private readonly work: WorkOrderService) {}

  async list(
    scope: RequestScope, filter: { status?: IncidentStatus | 'live'; externalId?: string } = {}, now = new Date(),
  ): Promise<IncidentRecord[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const qb = m.getRepository(Incident).createQueryBuilder('i').where('i.tenant_id = :t', { t: scope.tenantId });
      if (filter.status === 'live') qb.andWhere(`i.status <> 'resolved'`);
      else if (filter.status) qb.andWhere('i.status = :s', { s: filter.status });
      if (filter.externalId) qb.andWhere('i.external_id = :e', { e: filter.externalId });
      if (scope.equipmentIds !== undefined) qb.andWhere('i.external_id = ANY(:ids)', { ids: [...scope.equipmentIds] });
      const rows = await qb.getMany();
      const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
      // Live before resolved, worst first, then oldest — what to look at next.
      rows.sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved')
        || rank(b.severity) - rank(a.severity) || a.openedAt.getTime() - b.openedAt.getTime());
      return rows.map((r) => toRecord(r, now));
    });
  }

  async get(scope: RequestScope, id: string, now = new Date()): Promise<IncidentDetail> {
    return withTenantSession(this.ds, scope, async (m) => {
      const incident = await this.load(m, scope, id);
      const alertIds = (await m.getRepository(IncidentAlert).find({ where: { incidentId: id } })).map((l) => l.alertEventId);
      const [alerts, orders, timeline] = await Promise.all([
        alertIds.length ? m.getRepository(AlertEvent).find({ where: { id: In(alertIds) }, order: { firedAt: 'ASC' } }) : [],
        alertIds.length && can(scope, 'action.work')
          ? m.getRepository(WorkOrder).find({ where: { tenantId: scope.tenantId, alertId: In(alertIds) } }) : [],
        m.getRepository(IncidentEvent).find({ where: { incidentId: id }, order: { at: 'ASC' } }),
      ]);
      return {
        ...toRecord(incident, now),
        alerts: alerts.map((a) => ({
          id: a.id, severity: a.severity, state: a.state, firedAt: a.firedAt.toISOString(), summary: a.summary,
        })),
        workOrders: orders.map((o) => ({
          id: o.id, title: o.title, status: o.status, priority: o.priority, assignedToUserId: o.assignedToUserId, alertId: o.alertId,
        })),
        timeline: timeline.map((e) => ({ kind: e.kind, actor: e.actor, at: e.at.toISOString(), detail: e.detail })),
      };
    });
  }

  /** Somebody is on it. Its unacknowledged alerts are acknowledged with it. Repeating it is a no-op. */
  async acknowledge(scope: RequestScope, id: string, now = new Date()): Promise<IncidentRecord> {
    this.require(scope, 'action.work', 'acknowledge an incident');
    return withTenantSession(this.ds, scope, async (m) => {
      const incident = await this.load(m, scope, id, true);
      if (incident.status === 'resolved') throw new ConflictException('That incident is already resolved.');
      if (incident.status === 'acknowledged') return toRecord(incident, now);
      incident.status = 'acknowledged';
      incident.acknowledgedAt = now;
      incident.acknowledgedBy = scope.userId;
      await m.getRepository(Incident).save(incident);
      await m.query(
        `UPDATE "alert_event" SET "state" = 'acknowledged', "acknowledged_by" = $2, "acknowledged_at" = $3
          WHERE "state" = 'open' AND "id" IN (SELECT "alert_event_id" FROM "incident_alert" WHERE "incident_id" = $1)`,
        [id, scope.userId, now],
      );
      await this.event(m, incident, 'acknowledged', scope.userId, now, {});
      return toRecord(incident, now);
    });
  }

  /** Give it to somebody in the account, or to nobody. */
  async assign(scope: RequestScope, id: string, userId: string | null, now = new Date()): Promise<IncidentRecord> {
    this.require(scope, 'action.assign', 'assign an incident');
    return withTenantSession(this.ds, scope, async (m) => {
      const incident = await this.load(m, scope, id, true);
      if (incident.status === 'resolved') throw new ConflictException('That incident is already resolved.');
      if (userId !== null) {
        const user = await m.getRepository(AppUser).findOne({ where: { id: userId, tenantId: scope.tenantId, status: 'active' } });
        if (!user) throw new BadRequestException('No active user by that id in this account.');
      }
      const from = incident.ownerUserId;
      incident.ownerUserId = userId;
      await m.getRepository(Incident).save(incident);
      await this.event(m, incident, 'assigned', scope.userId, now, { from, to: userId });
      return toRecord(incident, now);
    });
  }

  /**
   * Done, with what was found. Refused while work raised on its alerts is unfinished —
   * an incident closed over a job still in progress is a fault reported fixed before it
   * is. Its unresolved alerts are resolved with the same note.
   */
  async resolve(scope: RequestScope, id: string, note: string, now = new Date()): Promise<IncidentRecord> {
    this.require(scope, 'action.work', 'resolve an incident');
    if (!note?.trim()) throw new BadRequestException('A note is required to resolve an incident: what was found and done.');
    return withTenantSession(this.ds, scope, async (m) => {
      const incident = await this.load(m, scope, id, true);
      if (incident.status === 'resolved') throw new ConflictException('That incident is already resolved.');
      const unfinished: { title: string }[] = await m.query(
        `SELECT w."title" FROM "work_order" w
          WHERE w."status" = ANY($2::text[])
            AND w."alert_id" IN (SELECT "alert_event_id" FROM "incident_alert" WHERE "incident_id" = $1)`,
        [id, OPEN_WORK],
      );
      if (unfinished.length) {
        throw new ConflictException(
          `Work on this incident is still open: ${unfinished.map((w) => `"${w.title}"`).join(', ')}. Finish or cancel it first.`,
        );
      }
      incident.acknowledgedAt = incident.acknowledgedAt ?? now;
      incident.acknowledgedBy = incident.acknowledgedBy ?? scope.userId;
      incident.status = 'resolved';
      incident.resolvedAt = now;
      incident.resolvedBy = scope.userId;
      incident.resolutionNote = note.trim();
      await m.getRepository(Incident).save(incident);
      await m.query(
        `UPDATE "alert_event"
            SET "state" = 'resolved', "resolved_by" = $2, "resolved_at" = $3, "resolution_note" = $4,
                "acknowledged_by" = coalesce("acknowledged_by", $2), "acknowledged_at" = coalesce("acknowledged_at", $3)
          WHERE "state" = ANY($5::text[])
            AND "id" IN (SELECT "alert_event_id" FROM "incident_alert" WHERE "incident_id" = $1)`,
        [id, scope.userId, now, note.trim(), UNRESOLVED_ALERT],
      );
      await this.event(m, incident, 'resolved', scope.userId, now, { note: note.trim() });
      return toRecord(incident, now);
    });
  }

  /**
   * Raise a job for it, through the work-order service's own `raise` — same checks, same
   * history — against its worst unresolved alert, which is what makes the job the
   * incident's. The timeline entry follows in its own transaction once the job exists.
   */
  async raiseWork(
    scope: RequestScope, id: string,
    input: { title: string; description?: string | null; priority?: WorkOrderPriority; assignedToUserId?: string | null; dueAt?: Date | null },
    now = new Date(),
  ): Promise<WorkOrder> {
    this.require(scope, 'action.assign', 'raise work on an incident');
    const { incident, alertId } = await withTenantSession(this.ds, scope, async (m) => {
      const found = await this.load(m, scope, id);
      if (found.status === 'resolved') throw new ConflictException('That incident is already resolved.');
      const [worst] = await m.query(
        `SELECT a."id" FROM "alert_event" a JOIN "incident_alert" l ON l."alert_event_id" = a."id"
          WHERE l."incident_id" = $1 AND a."state" = ANY($2::text[])
          ORDER BY array_position(ARRAY['none','low','medium','high','critical'], a."severity") DESC, a."fired_at" ASC
          LIMIT 1`, [id, UNRESOLVED_ALERT],
      );
      if (!worst) throw new ConflictException('Every alert on this incident is resolved; resolve the incident instead.');
      return { incident: found, alertId: worst.id as string };
    });
    const order = await this.work.raise(scope, {
      sourceSystem: incident.sourceSystem, externalId: incident.externalId, alertId, ...input,
    }, now);
    await withTenantSession(this.ds, scope, (m) =>
      this.event(m, incident, 'work_raised', scope.userId, now, { workOrderId: order.id, alertId }));
    return order;
  }

  // ------------------------------------------------------------------- SLA policy

  listPolicies(scope: RequestScope): Promise<IncidentSlaPolicy[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(IncidentSlaPolicy).find({ where: { tenantId: scope.tenantId } }));
  }

  /** Applies to incidents opened from now on; one already open keeps the promise made when it opened. */
  async setPolicy(
    scope: RequestScope, severity: Severity, ackWithinMinutes: number, resolveWithinMinutes: number,
  ): Promise<IncidentSlaPolicy> {
    this.require(scope, 'parameters.write', 'set incident response times');
    if (!SEVERITY_ORDER.includes(severity)) throw new BadRequestException(`severity must be one of ${SEVERITY_ORDER.join(', ')}.`);
    return withTenantSession(this.ds, scope, async (m) => {
      try {
        return await m.getRepository(IncidentSlaPolicy).save({
          tenantId: scope.tenantId, severity, ackWithinMinutes, resolveWithinMinutes, updatedBy: scope.userId, updatedAt: new Date(),
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23514') {
          throw new BadRequestException('Both times must be whole minutes above 0, and resolving cannot be due before acknowledging.');
        }
        throw err;
      }
    });
  }

  async deletePolicy(scope: RequestScope, severity: Severity): Promise<void> {
    this.require(scope, 'parameters.write', 'remove incident response times');
    await withTenantSession(this.ds, scope, (m) =>
      m.getRepository(IncidentSlaPolicy).delete({ tenantId: scope.tenantId, severity }));
  }

  // -------------------------------------------------------------------- escalation

  /**
   * Every account, one pass: a live incident whose acknowledgement is overdue goes to
   * level 1, one whose resolution is overdue to level 2. Each level once — the level is
   * stored, so a second pass finds nothing new — and each escalation is a timeline entry
   * and an `incident.escalated.v1` in the outbox for whatever notifies people.
   */
  async escalateOverdue(now = new Date()): Promise<number> {
    return runTenantSpanning(this.ds, 'incident escalation sweep', async (m) => {
      const due: Incident[] = await m.getRepository(Incident).createQueryBuilder('i')
        .where(`i.status <> 'resolved'`)
        .andWhere(`((i.status = 'open' AND i.ack_due_at < :now AND i.escalation_level < 1)
                 OR (i.resolve_due_at < :now AND i.escalation_level < 2))`, { now })
        .setLock('pessimistic_write').setOnLocked('skip_locked')
        .getMany();
      for (const incident of due) {
        const level = incident.resolveDueAt && incident.resolveDueAt < now ? 2 : 1;
        const reason = level === 2 ? 'resolution_overdue' : 'acknowledgement_overdue';
        incident.escalationLevel = level;
        await m.getRepository(Incident).save(incident);
        await this.event(m, incident, 'escalated', 'system', now, { level, reason });
        await m.query(
          `INSERT INTO "domain_event" ("event_type", "tenant_id", "subject", "payload", "occurred_at")
           VALUES ('incident.escalated.v1', $1, $2, $3::jsonb, $4)`,
          [incident.tenantId, incident.id, JSON.stringify({
            incidentId: incident.id, level, reason, severity: incident.severity,
            machine: { sourceSystem: incident.sourceSystem, externalId: incident.externalId },
            ownerUserId: incident.ownerUserId,
          }), now],
        );
      }
      if (due.length) this.logger.log(`Escalated ${due.length} incident(s).`);
      return due.length;
    });
  }

  // ------------------------------------------------------------------------- inside

  private require(scope: RequestScope, capability: Capability, what: string): void {
    if (!can(scope, capability)) throw new ForbiddenException(`You may not ${what}.`);
  }

  private async load(m: EntityManager, scope: RequestScope, id: string, lock = false): Promise<Incident> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('No such incident in this account.');
    const qb = m.getRepository(Incident).createQueryBuilder('i')
      .where('i.id = :id AND i.tenant_id = :t', { id, t: scope.tenantId });
    if (lock) qb.setLock('pessimistic_write');
    const incident = await qb.getOne();
    // Out of an operator's machines reads as absent, the same rule as every other record.
    if (!incident || (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(incident.externalId))) {
      throw new NotFoundException('No such incident in this account.');
    }
    return incident;
  }

  private event(
    m: EntityManager, incident: Incident, kind: IncidentEventKind, actor: string, at: Date, detail: Record<string, unknown>,
  ) {
    return m.getRepository(IncidentEvent).insert({ tenantId: incident.tenantId, incidentId: incident.id, kind, actor, at, detail });
  }
}
