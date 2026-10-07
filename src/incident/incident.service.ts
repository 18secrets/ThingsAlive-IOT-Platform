import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { AlertService } from '../alert/services/alert.service';
import { can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { Severity, SEVERITY_ORDER } from '../common/severity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { AlertRow } from '../page/page-widgets';
import { ruleSignal } from '../page/page.service';
import { withTenantSession } from '../scope/tenant-session';
import { WorkOrderService } from '../work/services/work-order.service';

/** The same two sets the machine page reads, so a machine is "in an incident" here
 * exactly when its page shows an open alert. */
const OPEN_ALERT_STATES = ['open', 'acknowledged'];
const OPEN_WORK_STATES = ['created', 'in-progress'];

export interface IncidentWorkOrder {
  id: string; status: string; title: string; priority: string; assignedTo: string | null; dueAt: string | null;
  alertId: string | null;
}

export interface Incident {
  machine: { sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null };
  /** The worst among the machine's open alerts. Work orders carry a priority, not a
   * severity, and are not mapped onto this scale — a mapping nobody decided is a guess. */
  worstSeverity: Severity;
  latestRaisedAt: string;
  openAlerts: AlertRow[];
  /** `null` when the caller does not hold `action.work`: the jobs exist, this caller
   * may not read them, and an empty list would claim there are none. */
  openWorkOrders: IncidentWorkOrder[] | null;
}

export interface IncidentList {
  status: 'open';
  incidents: Incident[];
}

/**
 * Incident Management, phase 1 (closeout §4): a view over what already exists, not a
 * new object. One row per machine with an open alert — its open alerts, the open work
 * orders against it, and the worst severity among the alerts.
 *
 * No table, no lifecycle, no SLA clock. Acknowledging and resolving stay on the alert;
 * assigning and completing stay on the work order. An incident entity is phase 2, once
 * somebody has used alerts in anger and can say what this view is missing — designing
 * that workflow now would be designing against no evidence.
 *
 * Visibility is the producers' own: `listEvents` and `WorkOrderService.list` already
 * narrow to the caller's machines, so this adds no scope rule of its own to drift.
 */
@Injectable()
export class IncidentService {
  constructor(
    private readonly ds: DataSource,
    private readonly alerts: AlertService,
    private readonly workOrders: WorkOrderService,
  ) {}

  async list(scope: RequestScope): Promise<IncidentList> {
    const events = await this.alerts.listEvents(scope, { state: OPEN_ALERT_STATES, limit: null });
    if (!events.length) return { status: 'open', incidents: [] };

    const keyOf = (r: { sourceSystem: string; externalId: string }) => `${r.sourceSystem}/${r.externalId}`;
    const externalIds = [...new Set(events.map((e) => e.externalId))];
    const ruleIds = [...new Set(events.map((e) => e.ruleId))];

    const { profiles, rules } = await withTenantSession(this.ds, scope, async (m) => ({
      profiles: await m.getRepository(EquipmentProfile).find({ where: { tenantId: scope.tenantId, externalId: In(externalIds) } }),
      rules: await m.getRepository(AlertRule).find({ where: { tenantId: scope.tenantId, id: In(ruleIds) } }),
    }));
    const profileByKey = new Map(profiles.map((p) => [keyOf(p), p]));
    const signalOfRule = new Map(rules.map((r) => [r.id, ruleSignal(r)]));

    const orders = can(scope, 'action.work')
      ? await this.workOrders.list(scope, { status: OPEN_WORK_STATES })
      : null;
    const ordersByKey = new Map<string, IncidentWorkOrder[]>();
    for (const o of orders ?? []) {
      const list = ordersByKey.get(keyOf(o)) ?? [];
      list.push({
        id: o.id, status: o.status, title: o.title, priority: o.priority,
        assignedTo: o.assignedToUserId, dueAt: o.dueAt?.toISOString() ?? null, alertId: o.alertId,
      });
      ordersByKey.set(keyOf(o), list);
    }

    // `listEvents` returns newest first, so each machine's list is already in that order.
    const byKey = new Map<string, typeof events>();
    for (const e of events) {
      const list = byKey.get(keyOf(e)) ?? [];
      list.push(e);
      byKey.set(keyOf(e), list);
    }

    const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
    const incidents: Incident[] = [...byKey.entries()].map(([key, machineEvents]) => {
      const first = machineEvents[0];
      const profile = profileByKey.get(key);
      return {
        machine: {
          sourceSystem: first.sourceSystem, externalId: first.externalId,
          name: profile?.name ?? null, classSlug: profile?.equipmentClassSlug ?? null, plantId: profile?.plantId ?? null,
        },
        worstSeverity: machineEvents.reduce<Severity>((w, e) => (rank(e.severity) > rank(w) ? e.severity : w), Severity.None),
        latestRaisedAt: first.firedAt.toISOString(),
        openAlerts: machineEvents.map((e) => ({
          id: e.id, severity: e.severity, raisedAt: e.firedAt.toISOString(),
          signal: signalOfRule.get(e.ruleId) ?? null, message: e.summary, acknowledged: e.state === 'acknowledged',
        })),
        openWorkOrders: orders === null ? null : ordersByKey.get(key) ?? [],
      };
    });

    // Worst first; among equals, the most recently raised — what to look at next.
    incidents.sort((a, b) => rank(b.worstSeverity) - rank(a.worstSeverity)
      || b.latestRaisedAt.localeCompare(a.latestRaisedAt));
    return { status: 'open', incidents };
  }
}
