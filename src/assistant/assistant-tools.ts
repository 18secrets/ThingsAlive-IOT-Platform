import { Injectable } from '@nestjs/common';
import { Capability, can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { AlertService } from '../alert/services/alert.service';
import { DeviceHealthService } from '../device-health/services/device-health.service';
import { LinkState } from '../device-health/services/link-health';
import { EquipmentService } from '../equipment/services/equipment.service';
import { IncidentStatus } from '../incident/entities/incident.entity';
import { IncidentRecordService } from '../incident/incident-record.service';
import { PageService } from '../page/page.service';
import { WorkOrderService } from '../work/services/work-order.service';
import { ToolDeclaration } from './assistant-model';

interface AssistantTool extends ToolDeclaration {
  /** The capability the matching HTTP route requires. The same one, not a new one. */
  capability: Capability;
  run(scope: RequestScope, args: Record<string, unknown>): Promise<unknown>;
}

const MAX_LIST_ITEMS = 50;
const MAX_RESULT_CHARS = 12_000;

/**
 * What the assistant may look at: read-only, in-process, and only through the
 * services the screens already use (D10).
 *
 * Every tool calls an existing service with the caller's own scope, so row-level
 * security, site narrowing and every check those services make apply unchanged —
 * the adapter never implements a second permission policy. A tool is offered only
 * when the caller holds the capability its HTTP route requires, so the model cannot
 * even ask for what the person could not open themselves.
 *
 * There is no write tool. G09 lets AI propose; doing is the normal services' job,
 * behind their own approval, and nothing here proposes yet.
 *
 * Results are allowlisted to the fields an answer needs. That keeps tokens down, and
 * it means a column added to an entity later does not reach the model until somebody
 * decides it should.
 */
@Injectable()
export class AssistantTools {
  private readonly tools: AssistantTool[];

  constructor(
    equipment: EquipmentService,
    alerts: AlertService,
    health: DeviceHealthService,
    incidents: IncidentRecordService,
    work: WorkOrderService,
    pages: PageService,
  ) {
    this.tools = [
      {
        name: 'list_equipment',
        description: 'The machines in this account: code, name, class, site and status.',
        parameters: { type: 'object', properties: { siteId: { type: 'string', description: 'Only machines at this site id.' } } },
        capability: 'catalog.read',
        run: async (scope, a) => (await equipment.list(scope, { plantId: str(a.siteId) })).map((e) => ({
          sourceSystem: e.sourceSystem, code: e.externalId, name: e.name, class: e.equipmentClassSlug,
          siteId: e.plantId, status: e.status, manufacturer: e.manufacturer, model: e.modelNumber,
        })),
      },
      {
        name: 'list_alerts',
        description: 'Alerts on the machines the person can see, newest first.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'array', items: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] } },
            equipmentCode: { type: 'string', description: 'Only alerts on this machine code.' },
          },
        },
        capability: 'prediction.read',
        run: async (scope, a) => (await alerts.listEvents(scope, {
          state: strs(a.state), externalId: str(a.equipmentCode), limit: MAX_LIST_ITEMS,
        })).map((e) => ({
          machine: e.externalId, rule: e.ruleName, severity: e.severity, state: e.state,
          summary: e.summary, firedAt: e.firedAt, acknowledgedAt: e.acknowledgedAt, resolvedAt: e.resolvedAt,
        })),
      },
      {
        name: 'logger_health',
        description: 'The newest link verdict per logger (online, late, silent and so on), worst first.',
        parameters: { type: 'object', properties: { state: { type: 'array', items: { type: 'string' } } } },
        capability: 'device.read',
        run: async (scope, a) => (await health.fleet(scope, { states: strs(a.state) as LinkState[] | undefined }))
          .map((r) => ({
            imei: r.imei, machine: r.externalId, state: r.state, detail: r.detail, since: r.windowStart,
            longestGapSeconds: r.longestGapSeconds, missingSignals: r.missingSignals,
          })),
      },
      {
        name: 'list_incidents',
        description: 'Incidents, with owner, severity and whether their SLA is on track or breached.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['live', 'open', 'acknowledged', 'resolved'], description: '"live" is everything not yet resolved.' },
            equipmentCode: { type: 'string' },
          },
        },
        capability: 'prediction.read',
        run: async (scope, a) => (await incidents.list(scope, {
          status: str(a.status) as IncidentStatus | 'live' | undefined, externalId: str(a.equipmentCode),
        })).map((i) => ({
          machine: i.machine.externalId, severity: i.severity, status: i.status, openedAt: i.openedAt,
          escalationLevel: i.escalationLevel, sla: i.sla,
        })),
      },
      {
        name: 'list_work_orders',
        description: 'Jobs on the machines the person can see.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'array', items: { type: 'string' } },
            equipmentCode: { type: 'string' },
            overdue: { type: 'boolean' },
          },
        },
        capability: 'action.work',
        run: async (scope, a) => (await work.list(scope, {
          status: strs(a.status), externalId: str(a.equipmentCode), overdue: a.overdue === true,
        })).map((w) => ({
          reference: w.reference, machine: w.externalId, title: w.title, status: w.status,
          priority: w.priority, dueAt: w.dueAt, origin: w.origin,
        })),
      },
      {
        name: 'machine_page',
        description: 'One machine\'s page as its screen shows it: KPIs, latest signal values, readiness, '
          + 'open alerts and jobs, service due. Each widget says when it cannot answer and why.',
        parameters: {
          type: 'object',
          properties: {
            sourceSystem: { type: 'string', description: 'From list_equipment.' },
            code: { type: 'string', description: 'The machine code, from list_equipment.' },
          },
          required: ['sourceSystem', 'code'],
        },
        capability: 'catalog.read',
        run: (scope, a) => pages.machinePage(scope, { sourceSystem: str(a.sourceSystem) ?? '', externalId: str(a.code) ?? '' }),
      },
    ];
  }

  /** The declarations this caller may use. */
  available(scope: RequestScope): ToolDeclaration[] {
    return this.tools.filter((t) => can(scope, t.capability))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * Runs one call. A failure goes back to the model as the result rather than failing
   * the chat: "no such machine" is something to tell the person, not a 500.
   */
  async run(scope: RequestScope, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    // Checked again here, not only when offered: the model's call is input, and input
    // naming a tool it was never given is exactly what a prompt injection looks like.
    if (!tool || !can(scope, tool.capability)) return { error: `No tool "${name}" is available.` };
    try {
      return bound(await tool.run(scope, args ?? {}));
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'The lookup failed.' };
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strs(v: unknown): string[] | undefined {
  const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  return out.length ? out : undefined;
}

/**
 * Keeps one result from eating the budget. Long lists keep their first items and say
 * how many were left out — an answer built on a silently cut list states a count that
 * is wrong.
 */
export function bound(value: unknown): unknown {
  const shrink = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const kept = v.slice(0, MAX_LIST_ITEMS).map(shrink);
      return v.length > MAX_LIST_ITEMS ? [...kept, `…and ${v.length - MAX_LIST_ITEMS} more, not shown`] : kept;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
    }
    return v;
  };
  const out = shrink(value);
  const json = JSON.stringify(out);
  if (json.length <= MAX_RESULT_CHARS) return out;
  return { truncated: true, note: 'Result too large; only the start is shown.', start: json.slice(0, MAX_RESULT_CHARS) };
}
