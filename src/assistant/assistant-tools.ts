import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Capability, can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { AlertService } from '../alert/services/alert.service';
import { DeviceHealthService } from '../device-health/services/device-health.service';
import { LinkState } from '../device-health/services/link-health';
import { DEFAULT_LOOK_BACK_DAYS } from '../device-health/services/device-health.service';
import { EquipmentService } from '../equipment/services/equipment.service';
import { GeofenceTracker } from '../geofence/geofence-tracker.service';
import { GeofenceService } from '../geofence/geofence.service';
import { violates } from '../geofence/geometry';
import { PlantService } from '../equipment/services/plant.service';
import { IncidentStatus } from '../incident/entities/incident.entity';
import { IncidentRecordService } from '../incident/incident-record.service';
import { InventoryService } from '../inventory/services/inventory.service';
import { OnboardingStatusService } from '../onboarding/onboarding-status.service';
import { MachinePage, PageService } from '../page/page.service';
import { FailureModeRow } from '../page/page-widgets';
import { WorkOrderService } from '../work/services/work-order.service';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { TenantRole } from '../identity/entities/tenant-role.entity';
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
  /**
   * Tools this caller is not offered even though their capabilities allow it — a
   * caller-specific narrowing on top of capability (Vani, plan Phase 6: `list_equipment`
   * does not yet honour a person's assigned machines). Empty for the console.
   */
  withheld?: readonly string[];
  /**
   * The pages the caller's role is granted, for a tool that answers from part of a page
   * (machine_page's alert and job lists). Null when the caller has no role row to read
   * them from, as a static-table caller does: there is nothing to narrow by.
   */
  pages?: readonly string[] | null;
}

interface AssistantTool extends ToolDeclaration {
  /** The capability the matching HTTP route requires. The same one, not a new one. */
  capability: Capability;
  profiles: AssistantProfile[];
  /**
   * In Ask AI, offered only to a role granted one of these pages (TC #61, 22 Nov). A role
   * can hold a capability and still have the page that shows its data hidden from its
   * menu, and the chat answered from the capability: a user with no Work Orders menu read
   * every job through it. The HTTP API is unchanged; pages stay a matter of what a role
   * is shown, and the chat is something it is shown.
   */
  pages?: readonly string[];
  run(scope: RequestScope, args: Record<string, unknown>, ctx: RunContext): Promise<unknown>;
}

/**
 * One chat's worth of proposals. More than this in one answer is a model looping on
 * "propose", and ten cards to read is already more than anyone checks carefully.
 */
export const MAX_PROPOSALS_PER_CHAT = 10;

const MAX_LIST_ITEMS = 50;
const MAX_RESULT_CHARS = 12_000;
/**
 * Machines named in full by list_equipment before it switches to counts. 40 short rows
 * fit well inside MAX_RESULT_CHARS, so the cut below never lands in the middle of them.
 */
export const LIST_IN_FULL = 40;

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
  alert_signal_unbound: 'Alert rules cover the machine, but none watches a signal it has bound yet. Fit the logger and map the signal.',
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
  private readonly ds: DataSource;

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
    this.ds = ds;
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
      const site = new Map(visible.map((p) => [p.id, { code: p.code, name: p.name, address: p.address ?? null }]));
      const type = new Map(classes.map((c) => [c.slug, c.name]));
      return {
        site: (id: string | null) => (id ? site.get(id) ?? null : null),
        sites: () => [...site.values()].map(({ code, name }) => ({ code, name })),
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
          const squash = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const wanted = squash(str(a.site));
          const isWanted = (site: { code: string; name: string } | null) =>
            !!site && [site.name, site.code].some((v) => squash(v) === wanted);
          // A site that matches none the person can see is said, not answered with an empty
          // list: an empty list reads as "nothing left to do there", and the chat said so.
          if (wanted && !names.sites().some(isWanted)) {
            return { error: `No site matches "${str(a.site)}". The sites are: ${names.sites().map((x) => x.name).join(', ') || 'none'}.` };
          }
          const atWantedSite = (plantId: string | null) => !wanted || isWanted(names.site(plantId));
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
        description: 'The machines in this account (not loggers: logger_health lists those): code, name, type, '
          + 'site, the site\'s address, and the machine\'s registration status. Show people `site` and '
          + '`type`, the names; the ids and slugs are for other tools. A large fleet comes back as complete '
          + 'counts (`total`, `byType`, `bySite`, every site listed) with only the first machines named; '
          + 'answer how-many and which-sites from the counts, and narrow with `type` or `site` to name the rest.',
        parameters: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Only machines at this site id.' },
            site: { type: 'string', description: 'Only machines at sites whose name or code contains this.' },
            type: { type: 'string', description: 'Only machines whose type contains this, e.g. "excavator" or "crane".' },
            sites: { type: 'boolean', description: 'Also return every site with its address and machine count, sites with no machines included. Use it to count or list sites.' },
          },
        },
        capability: 'catalog.read',
        profiles: BOTH,
        run: async (scope, a) => {
          const [machines, names, active] = await Promise.all([
            equipment.list(scope, { plantId: str(a.siteId) }), namesFor(scope), plants.list(scope),
          ]);
          const has = (v: string | null | undefined, q: string | undefined) => !q || (v ?? '').toLowerCase().includes(q.toLowerCase());
          const siteQ = str(a.site);
          const typeQ = str(a.type);
          const rows = machines.map((e) => {
            const site = names.site(e.plantId);
            return {
              sourceSystem: e.sourceSystem, code: e.externalId, name: e.name,
              type: names.type(e.equipmentClassSlug), typeSlug: e.equipmentClassSlug,
              site: site?.name ?? null, siteCode: site?.code ?? null, siteId: e.plantId,
              // Asked "which site is in Chennai?", the chat had only site names and answered
              // "neither" as if it had looked (TC #3). The address is what says where.
              siteAddress: site?.address ?? null,
              status: e.status, manufacturer: e.manufacturer, model: e.modelNumber,
            };
          }).filter((r) => (has(r.site, siteQ) || has(r.siteCode, siteQ))
            && (has(r.type, typeQ) || has(r.typeSlug, typeQ) || has(r.name, typeQ)));
          // Counted from the machines, a site with none on it was missed (TC #2). Asked
          // for, every site the person may see comes back, empty ones included. A person
          // limited to some machines is told only the sites of those machines.
          const allSites = () => {
            const count = (name: string | null) => rows.filter((r) => r.site === name).length;
            const seen = scope.equipmentIds === undefined
              ? active.filter((p) => scope.plantIds === undefined || scope.plantIds.includes(p.id))
              : active.filter((p) => rows.some((r) => r.siteId === p.id));
            return seen.map((p) => ({ name: p.name, code: p.code, address: p.address ?? null, machines: count(p.name) }));
          };
          if (a.sites === true) return { sites: allSites(), machines: rows.length <= LIST_IN_FULL ? rows : rows.slice(0, LIST_IN_FULL) };
          if (rows.length <= LIST_IN_FULL) return rows;

          // Too many to list whole. Before this, the list was cut to fit and the model
          // counted what was left: on Dev, 5 Nov, 85 machines came back as "43", then
          // "69", "3 sites" for 6, and "no excavators" with 25 of them. So the counts are
          // worked out here, over every machine, and only the naming is cut.
          const tally = (key: (r: (typeof rows)[number]) => string) =>
            rows.reduce<Record<string, number>>((acc, r) => { acc[key(r)] = (acc[key(r)] ?? 0) + 1; return acc; }, {});
          const bySite = tally((r) => r.site ?? 'No site');
          // A site with nothing on it yet is still a site. Only for a caller who sees the
          // whole fleet: one limited to some machines is not told about other sites.
          if (scope.equipmentIds === undefined && !siteQ && !str(a.siteId) && !typeQ) {
            for (const p of active) {
              if ((scope.plantIds === undefined || scope.plantIds.includes(p.id)) && !(p.name in bySite)) bySite[p.name] = 0;
            }
          }
          return {
            total: rows.length,
            byType: tally((r) => r.type ?? 'Unknown type'),
            bySite,
            machines: rows.slice(0, LIST_IN_FULL).map((r) => ({
              sourceSystem: r.sourceSystem, code: r.code, name: r.name, type: r.type, site: r.site,
            })),
            note: `All ${rows.length} machines are counted above; only the first ${LIST_IN_FULL} are named. `
              + 'Narrow with "type" or "site" to name the others. Never say a machine or type is absent '
              + 'because it is not among the named ones.',
          };
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
        pages: ['alerts'],
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
        // The states named, and counted here: given only the list, the model answered
        // "which devices are offline?" correctly but hedged and gave no number, not knowing
        // which state meant offline nor wanting to count (test report MIN-10).
        description: 'Every logger (device, identified by its IMEI) in this account, whether it is fitted to a '
          + 'machine, and its newest link state, worst first, with how many loggers are in each state. Loggers '
          + 'are not machines: list_equipment lists machines. States: "offline" (nothing received); "partial" '
          + 'reports but some sensors are silent; "intermittent" keeps dropping; "buffering" is holding data '
          + 'that will arrive late; "weak-signal" reports on a poor link; "healthy" is online and complete; '
          + '"no verdict yet" cannot be told yet; "not fitted" is on no machine and has no status. A fitted '
          + 'logger that sent nothing all week is offline, as the Dashboard counts it. `offline`, `online` and '
          + '`notFitted` are the counts to answer from.',
        parameters: {
          type: 'object',
          properties: { state: { type: 'array', items: { type: 'string' }, description: 'Only loggers in these states.' } },
        },
        capability: 'device.read',
        profiles: BOTH,
        pages: ['dashboard', 'admin-devices'],
        run: async (scope, a) => {
          const wanted = strs(a.state)?.map((x) => STATE_FROM_LABEL[x] ?? x);
          const [verdicts, devices] = await Promise.all([health.fleet(scope), inventory.mine(scope)]);
          // A logger with no verdict was left out, so seven silent loggers came back as
          // "total 0" and the chat said "no devices are offline" while the Dashboard said
          // seven were (TC #5, #48), and "list all devices" listed machines instead (TC #4).
          // Every logger the person can see is listed now, read as the Dashboard reads it
          // (LiveDashboardPage, MAJ-8): fitted and silent all week is offline; not fitted
          // has no status yet.
          // The register already keeps a person limited to some machines to their own
          // loggers and the free ones (InventoryService.mine).
          const visible = devices;
          const byImei = new Map(verdicts.map((r) => [r.imei, r]));
          const rows = visible.map((d) => {
            const v = byImei.get(d.imei);
            const machine = d.equipmentExternalId ?? v?.externalId ?? null;
            const raw: string = v ? v.state : machine ? 'dark' : NOT_FITTED;
            return {
              imei: d.imei, machine, fitted: machine !== null,
              state: STATE_LABEL[raw as LinkState] ?? raw,
              rawState: raw,
              detail: v?.detail ?? (machine ? `nothing received in the last ${DEFAULT_LOOK_BACK_DAYS} days` : 'not fitted to a machine, so it has no status yet'),
              since: v?.windowStart ?? null,
              longestGapSeconds: v?.longestGapSeconds ?? null, missingSignals: v?.missingSignals ?? null,
            };
          });
          const shown = rows.filter((r) => !wanted || wanted.includes(r.rawState));
          const byState: Record<string, number> = {};
          for (const r of shown) byState[r.state] = (byState[r.state] ?? 0) + 1;
          // Said outright, over every logger, whatever the filter: with only a count by
          // state, a missing "offline" read as zero (live check, 23 Nov).
          return {
            offline: rows.filter((r) => r.rawState === 'dark').length,
            online: rows.filter((r) => r.fitted && r.rawState !== 'dark' && r.rawState !== 'unknown').length,
            notFitted: rows.filter((r) => !r.fitted).length,
            total: shown.length, byState,
            loggers: shown.map(({ rawState: _raw, ...r }) => r),
          };
        },
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
        pages: ['incident-management'],
        run: async (scope, a) => {
          const rows = await incidents.list(scope, {
            status: str(a.status) as IncidentStatus | 'live' | undefined, externalId: str(a.equipmentCode),
          });
          // Described "with owner" and returned without one, so "who owns the latest
          // incident?" could never be answered (TC #30). The owner by name, read in the
          // person's own session; an id would be the uuid the chat must never show.
          const ids = [...new Set(rows.map((i) => i.ownerUserId).filter((x): x is string => !!x))];
          const names = new Map<string, string>(ids.length ? (await withTenantSession(this.ds, scope, (m) => m.query(
            `SELECT id::text AS id, full_name AS name FROM app_user WHERE id::text = ANY($1)`, [ids],
          )) as { id: string; name: string }[]).map((u) => [u.id, u.name]) : []);
          return rows.map((i) => ({
            machine: i.machine.externalId, severity: i.severity, status: i.status, openedAt: i.openedAt,
            owner: i.ownerUserId ? names.get(i.ownerUserId) ?? 'a user no longer in this account' : null,
            escalationLevel: i.escalationLevel, sla: i.sla,
          }));
        },
      },
      {
        name: 'list_work_orders',
        description: 'Jobs (work orders) on the machines the person can see, with whether each is overdue. '
          + 'Status is as the Work Orders page says it: "open" (not started), "in-progress", "completed", '
          + '"cancelled". For unfinished jobs pass both "open" and "in-progress".',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'array', items: { type: 'string', enum: ['open', 'in-progress', 'completed', 'cancelled'] } },
            equipmentCode: { type: 'string' },
            overdue: { type: 'boolean', description: 'Only unfinished jobs past their due date.' },
          },
        },
        capability: 'action.work',
        profiles: ASK,
        pages: ['work-orders'],
        run: async (scope, a) => {
          // The database calls a job nobody has started "created" and the page says "Open";
          // asked for open jobs the model passed "open", matched nothing, and said there were
          // none while three were open (TC #29). The tool speaks the page's word both ways.
          const status = strs(a.status)?.map((x) => (x === 'open' ? 'created' : x));
          const now = Date.now();
          return (await work.list(scope, {
            status, externalId: str(a.equipmentCode), overdue: a.overdue === true,
          })).map((w) => {
            const unfinished = w.status === 'created' || w.status === 'in-progress';
            return {
              reference: w.reference, machine: w.externalId, title: w.title,
              status: w.status === 'created' ? 'open' : w.status,
              priority: w.priority, dueAt: w.dueAt, origin: w.origin,
              // Said here, not left to date arithmetic: "due for service" answers missed that
              // both jobs were a month overdue (TC #7).
              overdue: unfinished && w.dueAt !== null && new Date(w.dueAt).getTime() < now,
            };
          });
        },
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
        run: async (scope, a, ctx) => {
          const page = await pages.machinePage(scope, { sourceSystem: str(a.sourceSystem) ?? '', externalId: str(a.code) ?? '' });
          return forMenu(page, ctx.pages ?? null);
        },
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

  /**
   * The Ask AI tools this caller's role is not shown the pages for, and the pages it is
   * (TC #61). A caller with no role row (`capabilities` absent: the static table answered
   * for them) has no page grants to honour and is narrowed by capability alone, as before.
   */
  async pageNarrowing(scope: RequestScope, profile: AssistantProfile): Promise<{ withheld: string[]; pages: string[] | null }> {
    if (profile !== 'ask' || scope.capabilities === undefined) return { withheld: [], pages: null };
    const slug = scope.roles[0];
    const pages: string[] = slug ? await withTenantSession(this.ds, scope, async (m) =>
      (await m.getRepository(TenantRole).findOne({ where: { tenantId: scope.tenantId, slug } }))?.allowedTabs ?? []) : [];
    const withheld = this.tools.filter((t) => t.pages && !t.pages.some((p) => pages.includes(p))).map((t) => t.name);
    return { withheld, pages };
  }

  /** The declarations this caller may use in this chat. */
  available(scope: RequestScope, profile: AssistantProfile = 'ask', withheld: readonly string[] = []): ToolDeclaration[] {
    return this.tools.filter((t) => t.profiles.includes(profile) && can(scope, t.capability) && !withheld.includes(t.name))
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
    if (!tool || !tool.profiles.includes(ctx.profile) || !can(scope, tool.capability) || ctx.withheld?.includes(name)) {
      return { error: `No tool "${name}" is available.` };
    }
    try {
      return bound(await tool.run(scope, args ?? {}, ctx));
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'The lookup failed.' };
    }
  }
}

/**
 * Link states as a person says them. "dark" reached the Tamil and Hindi answers word for
 * word (TC #48); the model repeats what it is handed, so it is handed "offline".
 */
const STATE_LABEL: Partial<Record<LinkState, string>> = { dark: 'offline', unknown: 'no verdict yet' };
const STATE_FROM_LABEL: Record<string, string> = { offline: 'dark', 'no verdict yet': 'unknown' };
const NOT_FITTED = 'not fitted';

/**
 * A machine's page as a role's menu shows it (TC #61). The page carries the machine's open
 * alerts and jobs; a role whose menu hides Alerts or Work Orders is not shown them here
 * either, and a failure mode's status, which reads "active" because an alert is open on
 * its signal, is left off for a role that cannot see alerts. Null pages: no menu to follow.
 */
export function forMenu(page: MachinePage, granted: readonly string[] | null): MachinePage {
  if (!granted) return page;
  const alertsShown = granted.includes('alerts');
  const hidden = new Set([
    ...(alertsShown ? [] : ['alert_list']),
    ...(granted.includes('work-orders') ? [] : ['work_order_list']),
  ]);
  return {
    ...page,
    widgets: page.widgets.filter((w) => !hidden.has(w.widgetType)).map((w) =>
      (w.widgetType === 'failure_modes' && !alertsShown && Array.isArray(w.data)
        ? { ...w, data: (w.data as FailureModeRow[]).map(({ status: _s, ...f }) => f) as unknown as typeof w.data }
        : w)),
  };
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
  // Said plainly, because a model handed a cut list counts it and reports the count.
  return {
    truncated: true,
    note: 'Result too large; only the start is shown, so it is INCOMPLETE. Do not count from it, and do not '
      + 'say something is missing because it is not in it. Narrow the request with a filter instead.',
    start: json.slice(0, MAX_RESULT_CHARS),
  };
}
