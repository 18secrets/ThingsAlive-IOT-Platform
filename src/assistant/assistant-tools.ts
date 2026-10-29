import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Capability, can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { AlertService } from '../alert/services/alert.service';
import { DeviceHealthService } from '../device-health/services/device-health.service';
import { LinkState } from '../device-health/services/link-health';
import { EquipmentService } from '../equipment/services/equipment.service';
import { GeofenceTracker } from '../geofence/geofence-tracker.service';
import { GeofenceService } from '../geofence/geofence.service';
import { violates } from '../geofence/geometry';
import { PlantService } from '../equipment/services/plant.service';
import { IncidentStatus } from '../incident/entities/incident.entity';
import { IncidentRecordService } from '../incident/incident-record.service';
import { InventoryService } from '../inventory/services/inventory.service';
import { OnboardingStatusService } from '../onboarding/onboarding-status.service';
import { PageService } from '../page/page.service';
import { WorkOrderService } from '../work/services/work-order.service';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { withTenantSession } from '../scope/tenant-session';
import { ToolDeclaration } from './assistant-model';
import { AssistantProposal, ProposalKind } from './assistant-proposal.entity';
import { AssistantProposalService, PROPOSAL_CAPABILITY } from './assistant-proposal.service';

/** Which chat a tool belongs to. Ask AI reads; onboarding reads and proposes. */
export type AssistantProfile = 'ask' | 'onboarding';

/** What one chat request accumulates while its tools run. */
export interface RunContext {
  profile: AssistantProfile;
  proposals: AssistantProposal[];
}

interface AssistantTool extends ToolDeclaration {
  /** The capability the matching HTTP route requires. The same one, not a new one. */
  capability: Capability;
  profiles: AssistantProfile[];
  run(scope: RequestScope, args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}

/**
 * One chat's worth of proposals. More than this in one answer is a model looping on
 * "propose", and ten cards to read is already more than anyone checks carefully.
 */
export const MAX_PROPOSALS_PER_CHAT = 10;

const MAX_LIST_ITEMS = 50;
const MAX_RESULT_CHARS = 12_000;

/** What each onboarding reason code means to the person onboarding, and who acts on it. */
const STEP_REASON_MEANING: Record<string, string> = {
  unclassified: 'The machine has no machine type. Set one by editing the machine on Administration > Equipment.',
  // No tool or field names in here: the model passes these on to people word for word,
  // and "(my_loggers)" reached the onboarding chat on Development, 29 Oct.
  no_device_claimed: 'No logger is fitted. Fit one of this account\'s free loggers to it.',
  no_requirements: 'The machine type lists no required signals, so there is nothing to map. The customer '
    + 'cannot fix this: Things Alive has to add required signals to the machine type and publish it. '
    + 'Readings, scenario and later steps wait on it.',
  unbound: 'A required signal is not bound yet. Bind it on Administration > Equipment > Signal Bindings.',
  mapping_required: 'A required signal needs mapping. Map it on Administration > Equipment > Signal Bindings.',
  stale: 'The signals are bound but readings stopped arriving. Check the logger is powered and online.',
  no_readings: 'The signals are bound but no readings have arrived yet. Check the logger is powered and online.',
  no_active_scenario: 'No prediction scenario is switched on. Switch one on from the Scenarios page.',
  no_alert_rule: 'No enabled alert rule covers the machine. Add one on the Alerts page.',
  no_user_access: 'Only super admins can see the machine. Give people access on Client Users.',
  blocked_by_step: 'Waiting on an earlier step; that step\'s meaning says what to do.',
};

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
 * There is no write tool. G09 lets AI propose; doing is the normal services' job. The
 * onboarding profile's `propose_*` tools write only a proposal row
 * (`AssistantProposalService`); nothing happens until a person confirms it, and then
 * it happens as them.
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
    onboarding: OnboardingStatusService,
    plants: PlantService,
    inventory: InventoryService,
    proposals: AssistantProposalService,
    ds: DataSource,
    geofences: GeofenceService,
    visits: GeofenceTracker,
  ) {
    /**
     * Site and machine-type names, keyed by the id and slug a machine carries. Without
     * them the chat printed "4ee4adc1-…" for a site and "ashokleyland-genset-180-test"
     * for a type, unless the model happened to make a second lookup. A site the caller
     * may not see stays unnamed, as the onboarding summary leaves it: naming it would
     * leak it.
     */
    const namesFor = async (scope: RequestScope) => {
      const [sites, classes] = await Promise.all([
        plants.list(scope, true),
        withTenantSession(ds, scope, (m) => m.getRepository(ClientEquipmentClass).find({ where: { tenantId: scope.tenantId } })),
      ]);
      const visible = sites.filter((p) => scope.plantIds === undefined || scope.plantIds.includes(p.id));
      const site = new Map(visible.map((p) => [p.id, { code: p.code, name: p.name }]));
      const type = new Map(classes.map((c) => [c.slug, c.name]));
      return {
        site: (id: string | null) => (id ? site.get(id) ?? null : null),
        type: (slug: string | null) => (slug ? type.get(slug) ?? slug : null),
      };
    };

    const BOTH: AssistantProfile[] = ['ask', 'onboarding'];
    const ASK: AssistantProfile[] = ['ask'];
    const ONBOARDING: AssistantProfile[] = ['onboarding'];

    /** A tool that proposes, and does nothing else. */
    const proposer = (
      kind: ProposalKind, description: string, properties: Record<string, unknown>, required: string[],
    ): AssistantTool => ({
      name: `propose_${kind}`,
      description: `${description} This only proposes: the person sees it as a card and confirms or rejects it. `
        + 'Never tell them it is done.',
      parameters: { type: 'object', properties, required },
      capability: PROPOSAL_CAPABILITY[kind],
      profiles: ONBOARDING,
      run: async (scope, a, ctx) => {
        if (ctx.proposals.length >= MAX_PROPOSALS_PER_CHAT) {
          return { error: `At most ${MAX_PROPOSALS_PER_CHAT} proposals per answer. Ask the person to confirm these first.` };
        }
        const p = await proposals.propose(scope, kind, a);
        ctx.proposals.push(p);
        return { proposalId: p.id, proposed: p.summary, status: 'waiting for the person to confirm' };
      },
    });

    this.tools = [
      {
        name: 'onboarding_status',
        description: 'Onboarding progress per site: for each of the seven steps (equipment, device, mapping, '
          + 'validation, activation, alerts, access) how many machines are done, pending or blocked.',
        parameters: { type: 'object', properties: {} },
        capability: 'equipment.write',
        profiles: ONBOARDING,
        run: (scope) => onboarding.summary(scope),
      },
      {
        name: 'machine_onboarding',
        description: 'One machine\'s seven onboarding steps: state, the reason code, what it means, and the '
          + 'step it waits on.',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            sourceSystem: { type: 'string', description: 'From list_equipment. Leave out to find the machine by code.' },
          },
          required: ['code'],
        },
        capability: 'equipment.write',
        profiles: ONBOARDING,
        run: async (scope, a) => {
          const code = str(a.code) ?? '';
          // The model guessed the source system when it had to give one, and a wrong
          // guess reads as "no such machine". By code alone, the one machine with it.
          const sourceSystem = str(a.sourceSystem)
            ?? (await equipment.list(scope, {})).find((e) => e.externalId === code)?.sourceSystem
            ?? '';
          const result = await onboarding.machine(scope, sourceSystem, code);
          // The reason codes alone let the model guess, and it guessed wrong (TC_131): a
          // class with no required signals came back as "complete the mapping on the
          // mapping screen", where there was nothing to map. Each step carries what its
          // reason means and who can act on it.
          return {
            ...result,
            steps: result.steps.map((s) => ({ ...s, meaning: s.reason ? STEP_REASON_MEANING[s.reason] ?? null : null })),
          };
        },
      },
      {
        name: 'unfinished_machines',
        description: 'The machines not yet fully onboarded, each with its site and type names, the steps not '
          + 'done, and the first step it waits on with what that means. One call for the whole fleet, or one site.',
        parameters: {
          type: 'object',
          properties: { site: { type: 'string', description: 'Only machines at this site, by its name or code as the person said it.' } },
        },
        capability: 'equipment.write',
        profiles: ONBOARDING,
        run: async (scope, a) => {
          const [machines, names] = await Promise.all([onboarding.machines(scope), namesFor(scope)]);
          // Filtered here, not by the model: asked about one site, it read the whole fleet
          // and listed a vizag machine under Tata-manfacturing on one run in two.
          const wanted = str(a.site)?.toLowerCase().replace(/[^a-z0-9]/g, '');
          const atWantedSite = (plantId: string | null) => {
            if (!wanted) return true;
            const site = names.site(plantId);
            return !!site && [site.name, site.code].some((v) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
          };
          return machines.filter((r) => r.overall !== 'done' && atWantedSite(r.machine.plantId)).map((r) => {
            const open = r.steps.filter((s) => s.state !== 'done');
            const site = names.site(r.machine.plantId);
            return {
              code: r.machine.externalId, name: r.machine.name, site: site?.name ?? null, siteCode: site?.code ?? null,
              type: names.type(r.machine.classSlug), notDone: open.map((s) => s.step),
              waitingOn: open[0]?.step ?? null,
              meaning: open[0]?.reason ? STEP_REASON_MEANING[open[0].reason] ?? null : null,
              hasLogger: !open.some((s) => s.step === 'device'),
            };
          });
        },
      },
      {
        name: 'list_sites',
        description: 'The sites in this account: code and name.',
        parameters: { type: 'object', properties: {} },
        capability: 'catalog.read',
        profiles: ONBOARDING,
        run: async (scope) => (await plants.list(scope)).map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status })),
      },
      {
        name: 'my_loggers',
        description: 'The loggers assigned to this account, and which machine each is fitted to (null when free).',
        parameters: { type: 'object', properties: {} },
        capability: 'device.read',
        profiles: ONBOARDING,
        run: async (scope) => (await inventory.mine(scope)).map((d) => ({
          imei: d.imei, model: d.model, state: d.state, fittedTo: d.equipmentExternalId,
        })),
      },
      proposer('create_site', 'Propose adding a site.', {
        code: { type: 'string', description: 'Short code, letters/digits/.-_ only.' }, name: { type: 'string' },
      }, ['code', 'name']),
      // Every field the Add Equipment form takes (TC_128): with only code, name, site,
      // maker and model the assistant created machines with no class, so every later
      // onboarding step showed blocked.
      proposer('create_equipment', 'Propose adding a machine to the register.', {
        code: { type: 'string', description: 'The machine code, letters/digits/.-_ only; it cannot change later.' },
        name: { type: 'string' },
        siteCode: { type: 'string', description: 'An existing site code, or one proposed in this answer.' },
        classSlug: { type: 'string', description: 'The machine type: a slug from list_equipment_classes.' },
        manufacturer: { type: 'string' }, modelNumber: { type: 'string' },
        serialNumber: { type: 'string' },
        description: { type: 'string' },
        tier: { type: 'string', enum: ['basic', 'standard', 'advanced', 'full'], description: 'Service tier; basic when not given.' },
        commissionedAt: { type: 'string', description: 'Commissioning date, YYYY-MM-DD.' },
        serviceIntervalHours: { type: 'integer', description: 'Running hours between services.' },
      }, ['code', 'name']),
      {
        name: 'list_equipment_classes',
        description: 'The machine types this account can use: slug, name and description.',
        parameters: { type: 'object', properties: {} },
        capability: 'catalog.read',
        profiles: ONBOARDING,
        run: (scope) => withTenantSession(ds, scope, async (m) => (await m.getRepository(ClientEquipmentClass).find({
          where: { tenantId: scope.tenantId }, order: { name: 'ASC' },
        })).filter((c) => c.status === 'active').map((c) => ({ slug: c.slug, name: c.name, description: c.description }))),
      },
      proposer('fit_logger', 'Propose fitting a logger already in this account (from my_loggers) to a machine.', {
        imei: { type: 'string' },
        equipmentCode: { type: 'string' },
        sourceSystem: { type: 'string', description: 'From list_equipment. Leave out for machines created in 2.0.' },
      }, ['imei', 'equipmentCode']),
      {
        name: 'list_equipment',
        description: 'The machines in this account: code, name, type, site and status. Show people `site` and '
          + '`type`, the names; the ids and slugs are for other tools.',
        parameters: { type: 'object', properties: { siteId: { type: 'string', description: 'Only machines at this site id.' } } },
        capability: 'catalog.read',
        profiles: BOTH,
        run: async (scope, a) => {
          const [machines, names] = await Promise.all([equipment.list(scope, { plantId: str(a.siteId) }), namesFor(scope)]);
          return machines.map((e) => {
            const site = names.site(e.plantId);
            return {
              sourceSystem: e.sourceSystem, code: e.externalId, name: e.name,
              type: names.type(e.equipmentClassSlug), typeSlug: e.equipmentClassSlug,
              site: site?.name ?? null, siteCode: site?.code ?? null, siteId: e.plantId,
              status: e.status, manufacturer: e.manufacturer, model: e.modelNumber,
            };
          });
        },
      },
      {
        name: 'list_alerts',
        description: 'Alerts on the machines the person can see, newest first.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'array', items: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] } },
            equipmentCode: { type: 'string', description: 'Only alerts on this machine code.' },
            firedSince: { type: 'string', description: 'Only alerts fired on or after this day, YYYY-MM-DD (UTC).' },
            firedBefore: { type: 'string', description: 'Only alerts fired before this day, YYYY-MM-DD (UTC).' },
          },
        },
        capability: 'prediction.read',
        profiles: ASK,
        run: async (scope, a) => {
          // Without a window "how many alerts this week" could not be answered (Dev, 29
          // Oct). A date the model garbled goes back to it as an error: dropping it would
          // answer about every alert ever, as if it were the week asked about.
          const firedSince = day(a.firedSince);
          const firedBefore = day(a.firedBefore);
          if (firedSince === null || firedBefore === null) {
            return { error: 'firedSince and firedBefore are days written YYYY-MM-DD.' };
          }
          return (await alerts.listEvents(scope, {
            state: strs(a.state), externalId: str(a.equipmentCode), limit: MAX_LIST_ITEMS, firedSince, firedBefore,
          })).map((e) => ({
          machine: e.externalId, rule: e.ruleName, severity: e.severity, state: e.state,
          summary: e.summary, firedAt: e.firedAt, acknowledgedAt: e.acknowledgedAt, resolvedAt: e.resolvedAt,
          }));
        },
      },
      {
        name: 'logger_health',
        description: 'The newest link verdict per logger (online, late, silent and so on), worst first.',
        parameters: { type: 'object', properties: { state: { type: 'array', items: { type: 'string' } } } },
        capability: 'device.read',
        profiles: BOTH,
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
        profiles: ASK,
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
        profiles: ASK,
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
        profiles: ASK,
        run: (scope, a) => pages.machinePage(scope, { sourceSystem: str(a.sourceSystem) ?? '', externalId: str(a.code) ?? '' }),
      },
      {
        name: 'machine_geofences',
        description: 'One machine\'s geofence zones, its site boundary included, and its visits to them in the last '
          + '7 days: when it entered and left, and whether that broke the zone\'s rule (entering a restricted zone, '
          + 'leaving an allowed zone or a corridor).',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'The machine code, from list_equipment.' },
            sourceSystem: { type: 'string', description: 'From list_equipment. Leave out to find the machine by code.' },
          },
          required: ['code'],
        },
        capability: 'catalog.read',
        profiles: ASK,
        run: async (scope, a, _ctx) => {
          const code = str(a.code) ?? '';
          const sourceSystem = str(a.sourceSystem)
            ?? (await equipment.list(scope, {})).find((e) => e.externalId === code)?.sourceSystem
            ?? '';
          const since = new Date(Date.now() - 7 * 24 * 3_600_000);
          const [zones, recent] = await Promise.all([
            geofences.zonesFor(scope, sourceSystem, code),
            visits.visits(scope, { sourceSystem, externalId: code }, { from: since }),
          ]);
          // Shapes left out: coordinates spend tokens and answer nothing a person asks here.
          return {
            zones: zones.map((z) => ({ code: z.code, name: z.name, kind: z.kind, isSiteBoundary: z.source === 'site-boundary' })),
            visits: recent.slice(0, 20).map((v) => ({
              zone: v.zoneName, zoneCode: v.zoneCode, kind: v.zoneKind, enteredAt: v.enteredAt,
              leftAt: v.leftAt, stillInside: v.leftAt === null,
              brokeRule: violates(v.zoneKind, true) || (v.leftReason === 'exited' && violates(v.zoneKind, false)),
            })),
          };
        },
      },
    ];
  }

  /** The declarations this caller may use in this chat. */
  available(scope: RequestScope, profile: AssistantProfile = 'ask'): ToolDeclaration[] {
    return this.tools.filter((t) => t.profiles.includes(profile) && can(scope, t.capability))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /**
   * Runs one call. A failure goes back to the model as the result rather than failing
   * the chat: "no such machine" is something to tell the person, not a 500.
   */
  async run(
    scope: RequestScope, name: string, args: Record<string, unknown>,
    ctx: RunContext = { profile: 'ask', proposals: [] },
  ): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    // Checked again here, not only when offered: the model's call is input, and input
    // naming a tool it was never given is exactly what a prompt injection looks like.
    // That includes a propose_* call made from the Ask AI chat.
    if (!tool || !tool.profiles.includes(ctx.profile) || !can(scope, tool.capability)) {
      return { error: `No tool "${name}" is available.` };
    }
    try {
      return bound(await tool.run(scope, args ?? {}, ctx));
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'The lookup failed.' };
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** A YYYY-MM-DD day as UTC midnight; undefined when absent, null when not a real day. */
function day(v: unknown): Date | undefined | null {
  const s = str(v);
  if (s === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  // Date rolls 2026-02-31 over to 3 March rather than refusing it.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
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
