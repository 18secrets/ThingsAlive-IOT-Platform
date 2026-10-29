import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { EquipmentScenario } from '../activation/entities/equipment-scenario.entity';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { ruleCoversMachine } from '../alert/services/alert.service';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { Plant } from '../equipment/entities/plant.entity';
import { DeviceInventory } from '../inventory/entities/device-inventory.entity';
import { withTenantSession } from '../scope/tenant-session';
import { CoverageResult, SignalBindingService } from '../signal-binding/services/signal-binding.service';
import { classifyFreshness } from '../signal-binding/services/signal-freshness';

export const STEPS = ['equipment', 'device', 'mapping', 'validation', 'activation', 'alerts', 'access'] as const;
export type StepName = (typeof STEPS)[number];
export type StepState = 'done' | 'pending' | 'blocked';

/**
 * What each step waits on (QONBOARD-STATUS §7 Q2). A binding names a device, so mapping
 * waits for one; readings arrive through a binding, so validation waits for mapping; a
 * scenario reads bound signals, so activation does too. Alerts and access depend on
 * nothing — an account can write its rules and invite its people before a single
 * logger is fitted.
 */
const DEPENDS_ON: Record<StepName, readonly StepName[]> = {
  equipment: [],
  device: [],
  mapping: ['equipment', 'device'],
  validation: ['mapping'],
  activation: ['mapping'],
  alerts: [],
  access: [],
};

export interface Step {
  step: StepName;
  state: StepState;
  /** A code, never prose alone. Null exactly when `done`. */
  reason: string | null;
  /** The earlier step this one waits on; set only when `blocked` by one. */
  blockedBy: StepName | null;
  /** What the state was read from — counts and keys, enough to link to the right page. */
  evidence: Record<string, unknown>;
}

export interface MachineRef {
  sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null;
}

export interface MachineOnboarding {
  machine: MachineRef;
  /** `done` when every step is. There is no "Done" step: a summary stored as a step
   * is one more thing that can disagree with the steps. */
  overall: 'done' | 'in_progress';
  steps: Step[];
}

export interface SiteOnboarding {
  /** Null groups the machines that have no site, rather than dropping them. */
  site: { id: string; code: string; name: string } | null;
  /** `no_equipment` for a site with no machines yet — not "completed": nothing on it
   * has been onboarded, because nothing is on it. */
  status: 'completed' | 'in_progress' | 'no_equipment';
  machines: { total: number; done: number; inProgress: number };
  steps: Record<StepName, Record<StepState, number>>;
}

export interface OnboardingSummary {
  asOf: string;
  sites: SiteOnboarding[];
}

/** Everything the seven steps read, loaded once for a set of machines. */
export interface Facts {
  devices: Map<string, string[]>;
  scenarios: Map<string, { active: number; other: number }>;
  rules: AlertRule[];
  equipmentGrants: Map<string, number>;
  plantGrants: Map<string, number>;
}

/**
 * Onboarding progress, derived (task QONBOARD-STATUS).
 *
 * Nothing here is stored. Each step is read from the table that already owns the fact —
 * a claim from the inventory, a binding from coverage, a rule from the alert rules — so
 * progress cannot drift from the thing it describes. A device claimed through the
 * inventory page instead of a wizard counts the same, and a device released moves the
 * machine backwards, because the facts did.
 *
 * Mapping and validation come from `SignalBindingService.coverage`, called once per
 * machine — the same call and the same freshness rule the machine page and the site
 * page use, so a signal cannot be ready here and stale there. Everything else is read
 * in a fixed number of queries for the whole set.
 */
@Injectable()
export class OnboardingStatusService {
  constructor(
    private readonly ds: DataSource,
    private readonly bindings: SignalBindingService,
  ) {}

  async summary(scope: RequestScope, at = new Date()): Promise<OnboardingSummary> {
    const { plants, machines } = await withTenantSession(this.ds, scope, async (m) => {
      const plantWhere: Record<string, unknown> = { tenantId: scope.tenantId };
      if (scope.plantIds !== undefined) plantWhere.id = In([...scope.plantIds]);
      return {
        plants: scope.plantIds?.length === 0 ? [] : await m.getRepository(Plant).find({ where: plantWhere, order: { code: 'ASC' } }),
        machines: await this.visibleMachines(m, scope),
      };
    });
    const evaluated = await this.evaluate(scope, machines, at);

    const empty = () => Object.fromEntries(STEPS.map((s) => [s, { done: 0, pending: 0, blocked: 0 }])) as SiteOnboarding['steps'];
    const site = (key: string | null, info: SiteOnboarding['site']): SiteOnboarding => {
      const mine = evaluated.filter((e) => e.machine.plantId === key);
      const steps = empty();
      for (const e of mine) for (const s of e.steps) steps[s.step][s.state] += 1;
      const done = mine.filter((e) => e.overall === 'done').length;
      return {
        site: info,
        status: !mine.length ? 'no_equipment' : done === mine.length ? 'completed' : 'in_progress',
        machines: { total: mine.length, done, inProgress: mine.length - done },
        steps,
      };
    };

    const sites = plants.map((p) => site(p.id, { id: p.id, code: p.code, name: p.name }));
    // A machine whose site the caller cannot see still appears — under no site, since
    // naming a site the caller may not read would leak it.
    const known = new Set(plants.map((p) => p.id));
    const orphans = evaluated.filter((e) => !e.machine.plantId || !known.has(e.machine.plantId));
    if (orphans.length) {
      for (const o of orphans) o.machine = { ...o.machine, plantId: null };
      sites.push(site(null, null));
    }
    return { asOf: at.toISOString(), sites };
  }

  /**
   * Every machine the caller can see, with its steps. The summary counts machines per
   * site but cannot say which ones are unfinished, and asking `machine` once per machine
   * spent the onboarding chat's whole step limit on a fleet of a dozen.
   */
  async machines(scope: RequestScope, at = new Date()): Promise<MachineOnboarding[]> {
    const machines = await withTenantSession(this.ds, scope, (m) => this.visibleMachines(m, scope));
    return this.evaluate(scope, machines, at);
  }

  async machine(scope: RequestScope, sourceSystem: string, externalId: string, at = new Date()): Promise<MachineOnboarding> {
    const notFound = () => new NotFoundException('No such machine in this account.');
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) throw notFound();
    const profile = await withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentProfile).findOne({ where: { tenantId: scope.tenantId, sourceSystem, externalId } }));
    if (!profile) throw notFound();
    const [result] = await this.evaluate(scope, [profile], at);
    return result;
  }

  // ====================================================================== loading

  /** The tenant, narrowed by `scope.equipmentIds` — the work-order and incident rule. */
  private async visibleMachines(m: EntityManager, scope: RequestScope): Promise<EquipmentProfile[]> {
    const where: Record<string, unknown> = { tenantId: scope.tenantId };
    if (scope.equipmentIds !== undefined) {
      if (!scope.equipmentIds.length) return [];
      where.externalId = In([...scope.equipmentIds]);
    }
    return m.getRepository(EquipmentProfile).find({ where, order: { externalId: 'ASC' } });
  }

  private async evaluate(scope: RequestScope, machines: EquipmentProfile[], at: Date): Promise<MachineOnboarding[]> {
    if (!machines.length) return [];
    const [facts, coverages] = await Promise.all([
      withTenantSession(this.ds, scope, (m) => this.facts(m, scope.tenantId, machines)),
      // Unclassified machines have no requirements to cover; asking would only answer
      // "nothing required", which reads like done.
      Promise.all(machines.map((p) => p.equipmentClassSlug
        ? this.bindings.coverage(scope, { sourceSystem: p.sourceSystem, externalId: p.externalId }, at)
        : Promise.resolve(null))),
    ]);
    return machines.map((p, i) => machineSteps(p, facts, coverages[i], at));
  }

  private async facts(m: EntityManager, tenantId: string, machines: EquipmentProfile[]): Promise<Facts> {
    const externalIds = [...new Set(machines.map((p) => p.externalId))];
    const plantIds = [...new Set(machines.map((p) => p.plantId).filter((x): x is string => !!x))];

    // The inventory keys a claim by the machine's external id alone — it has no
    // source-system column — so that is the key here too.
    const devices = await m.getRepository(DeviceInventory).find({
      where: { tenantId, equipmentExternalId: In(externalIds), state: 'assigned' },
      select: { imei: true, equipmentExternalId: true, claimedAt: true },
    });
    const scenarios = await m.getRepository(EquipmentScenario).find({
      where: { tenantId, externalId: In(externalIds) },
      select: { sourceSystem: true, externalId: true, state: true },
    });
    const rules = await m.getRepository(AlertRule).find({ where: { tenantId, enabled: true } });
    // Only users who are not suspended: a grant held by somebody who cannot sign in
    // gives nobody access.
    const equipmentGrants: { sourceSystem: string; externalId: string; users: number }[] = await m.query(
      `SELECT a."source_system" AS "sourceSystem", a."equipment_external_id" AS "externalId", count(DISTINCT a."user_id")::int AS users
         FROM "user_equipment_access" a JOIN "app_user" u ON u."id" = a."user_id" AND u."tenant_id" = a."tenant_id"
        WHERE a."tenant_id" = $1 AND a."equipment_external_id" = ANY($2::text[]) AND u."status" <> 'suspended'
        GROUP BY 1, 2`,
      [tenantId, externalIds],
    );
    const plantGrants: { plantId: string; users: number }[] = plantIds.length ? await m.query(
      `SELECT a."plant_id" AS "plantId", count(DISTINCT a."user_id")::int AS users
         FROM "user_plant_access" a JOIN "app_user" u ON u."id" = a."user_id" AND u."tenant_id" = a."tenant_id"
        WHERE a."tenant_id" = $1 AND a."plant_id" = ANY($2::uuid[]) AND u."status" <> 'suspended'
        GROUP BY 1`,
      [tenantId, plantIds],
    ) : [];

    const deviceMap = new Map<string, string[]>();
    for (const d of devices) {
      // Claimed means fitted to this machine, not merely assigned to the account.
      if (!d.equipmentExternalId || !d.claimedAt) continue;
      deviceMap.set(d.equipmentExternalId, [...(deviceMap.get(d.equipmentExternalId) ?? []), d.imei]);
    }
    const scenarioMap = new Map<string, { active: number; other: number }>();
    for (const s of scenarios) {
      const k = key(s.sourceSystem, s.externalId);
      const c = scenarioMap.get(k) ?? { active: 0, other: 0 };
      if (s.state === 'active') c.active += 1; else c.other += 1;
      scenarioMap.set(k, c);
    }
    return {
      devices: deviceMap,
      scenarios: scenarioMap,
      rules,
      equipmentGrants: new Map(equipmentGrants.map((g) => [key(g.sourceSystem, g.externalId), g.users])),
      plantGrants: new Map(plantGrants.map((g) => [g.plantId, g.users])),
    };
  }
}

// ======================================================================= deriving

const key = (sourceSystem: string, externalId: string) => `${sourceSystem}/${externalId}`;

/** A step's own answer, before dependencies are applied. */
type Own = { done: true; evidence: Record<string, unknown> } | { done: false; reason: string; evidence: Record<string, unknown> };

export function machineSteps(p: EquipmentProfile, facts: Facts, coverage: CoverageResult | null, at: Date): MachineOnboarding {
  const own: Record<StepName, Own> = {
    equipment: p.equipmentClassSlug
      ? { done: true, evidence: { classSlug: p.equipmentClassSlug, classVersion: p.classVersion } }
      : { done: false, reason: 'unclassified', evidence: {} },
    device: deviceStep(facts.devices.get(p.externalId) ?? []),
    ...coverageSteps(coverage, at),
    activation: activationStep(facts.scenarios.get(key(p.sourceSystem, p.externalId))),
    alerts: alertStep(facts.rules, p),
    access: accessStep(
      facts.equipmentGrants.get(key(p.sourceSystem, p.externalId)) ?? 0,
      p.plantId ? facts.plantGrants.get(p.plantId) ?? 0 : 0,
    ),
  };

  const steps: Step[] = [];
  const doneSoFar = new Map<StepName, boolean>();
  for (const name of STEPS) {
    const waitingOn = DEPENDS_ON[name].find((d) => !doneSoFar.get(d));
    const o = own[name];
    let step: Step;
    if (waitingOn) {
      step = { step: name, state: 'blocked', reason: 'blocked_by_step', blockedBy: waitingOn, evidence: o.evidence };
    } else if (!('reason' in o)) {
      step = { step: name, state: 'done', reason: null, blockedBy: null, evidence: o.evidence };
    } else {
      // A class that declares no required signals blocks mapping on the library, not
      // on anything the person onboarding can do — so it is blocked, with no step named.
      const state: StepState = o.reason === 'no_requirements' ? 'blocked' : 'pending';
      step = { step: name, state, reason: o.reason, blockedBy: null, evidence: o.evidence };
    }
    doneSoFar.set(name, step.state === 'done');
    steps.push(step);
  }
  return {
    machine: {
      sourceSystem: p.sourceSystem, externalId: p.externalId, name: p.name ?? null,
      classSlug: p.equipmentClassSlug ?? null, plantId: p.plantId ?? null,
    },
    overall: steps.every((s) => s.state === 'done') ? 'done' : 'in_progress',
    steps,
  };
}

function deviceStep(imeis: string[]): Own {
  return imeis.length
    ? { done: true, evidence: { imeis: [...imeis].sort() } }
    : { done: false, reason: 'no_device_claimed', evidence: { imeis: [] } };
}

/**
 * Mapping and validation, from one coverage answer. The reasons are coverage's and the
 * machine page's own (`unbound`, `mapping_required`, `stale`, `no_readings`) so the UI
 * maps one vocabulary.
 */
function coverageSteps(coverage: CoverageResult | null, at: Date): Pick<Record<StepName, Own>, 'mapping' | 'validation'> {
  if (!coverage) {
    return { mapping: { done: false, reason: 'unclassified', evidence: {} }, validation: { done: false, reason: 'unclassified', evidence: {} } };
  }
  const required = coverage.covered.length + coverage.missing.length;
  if (!required) {
    const none = { done: false as const, reason: 'no_requirements', evidence: { required: 0 } };
    return { mapping: none, validation: none };
  }

  const unbound = coverage.missing.filter((r) => r.reason === 'unbound').map((r) => r.measurementRole);
  const partial = coverage.missing.filter((r) => r.reason !== 'unbound').map((r) => r.measurementRole);
  const mapping: Own = coverage.missing.length
    ? { done: false, reason: unbound.length ? 'unbound' : 'mapping_required', evidence: { required, bound: coverage.covered.length, unbound, mappingRequired: partial } }
    : { done: true, evidence: { required, bound: required } };

  // Over the bound signals only: an unbound one has no readings to judge, and mapping
  // already says so.
  const stale: string[] = [];
  const silent: string[] = [];
  for (const r of coverage.covered) {
    const f = classifyFreshness(r.lastReadingAt ? new Date(r.lastReadingAt) : null, at, r.staleAfterSeconds);
    if (f === 'stale') stale.push(r.measurementRole);
    else if (f === 'no_readings') silent.push(r.measurementRole);
  }
  const fresh = coverage.covered.length - stale.length - silent.length;
  const validation: Own = stale.length || silent.length
    ? { done: false, reason: stale.length ? 'stale' : 'no_readings', evidence: { reporting: fresh, stale, noReadings: silent } }
    : { done: true, evidence: { reporting: fresh } };
  return { mapping, validation };
}

function activationStep(c: { active: number; other: number } | undefined): Own {
  const evidence = { active: c?.active ?? 0, notActive: c?.other ?? 0 };
  return evidence.active ? { done: true, evidence } : { done: false, reason: 'no_active_scenario', evidence };
}

function alertStep(rules: readonly AlertRule[], p: EquipmentProfile): Own {
  const machine = {
    sourceSystem: p.sourceSystem, externalId: p.externalId,
    plantId: p.plantId ?? null, equipmentClassSlug: p.equipmentClassSlug ?? null,
  };
  const covering = rules.filter((r) => ruleCoversMachine(r, machine)).map((r) => r.slug).sort();
  return covering.length
    ? { done: true, evidence: { rules: covering } }
    : { done: false, reason: 'no_alert_rule', evidence: { rules: [] } };
}

/**
 * Explicit grants only. A tenant-wide role sees every machine without one, so counting
 * it would mark this done for every machine from the first day and tell nobody
 * anything (§7 Q5). A count, never who: this route is not the user list.
 */
function accessStep(equipmentUsers: number, plantUsers: number): Own {
  const evidence = { usersByEquipmentGrant: equipmentUsers, usersBySiteGrant: plantUsers };
  return equipmentUsers + plantUsers > 0 ? { done: true, evidence } : { done: false, reason: 'no_user_access', evidence };
}
