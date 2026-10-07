import 'reflect-metadata';

import { DataSource, EntityManager } from 'typeorm';
import { AlertService } from '../../alert/services/alert.service';
import { RequestScope } from '../../auth/types/request-scope';
import { AlertRuleTemplate } from '../../catalog/entities/alert-rule-template.entity';
import { ClientCatalogEntitlement } from '../../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassFormula } from '../../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../../catalog/entities/equipment-class-layout.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { NamedFormula } from '../../catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../../catalog/entities/scenario-definition.entity';
import { SensorRoleCapability } from '../../device-catalog/entities/sensor-role-capability.entity';
import { SignalAlias } from '../../catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../../catalog/services/catalog-authoring.service';
import { insertClassContent } from '../../catalog/services/class-failure-modes';
import { EntitlementService } from '../../catalog/services/entitlement.service';
import { CopyOnGrantService } from '../../client-catalog/services/copy-on-grant.service';
import { Severity } from '../../common/severity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { PasswordService } from '../../identity/services/password.service';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { EquipmentProjection } from '../../projection/entities/equipment-projection.entity';
import { SensorMapProjection } from '../../projection/entities/sensor-map-projection.entity';
import { TenantMap } from '../../projection/entities/tenant-map.entity';
import { runTenantSpanning } from '../../scope/tenant-session';
import { siteLayoutProblems, SiteLayoutWidget } from '../../catalog/services/class-layout';
import { EquipmentShift } from '../../shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../../signal-binding/entities/signal-binding-version.entity';
import { ProvisioningService } from '../../tenancy/services/provisioning.service';
import { dataSourceOptions } from '../data-source';

/**
 * The demo tenant (task QSEED1): one command that puts six machines in front of a
 * person signing in to the console, each showing a different state side by side —
 * because the states are the product, and a tester cannot judge a screen that only
 * ever shows one of them.
 *
 *   SEED_DEMO_ENABLED=true npm run seed:demo          # create, or say it is already there
 *   SEED_DEMO_ENABLED=true npm run seed:demo:reset    # remove everything it created
 *
 * It writes a tenant's worth of data, so it refuses to run without
 * `SEED_DEMO_ENABLED=true` passed for the one command. Never set that as a standing
 * variable on a deployed service.
 *
 * **The class is the seeder's own** (`demo-excavator`, `seed_only`). The published
 * library has no sensor requirements, layouts, alert rule templates or baseline
 * formulas, and seeding against it produces six identical `not_configured` machines.
 * The class is marked `seed_only` in the schema, so it cannot be mistaken for library
 * content, and the database refuses to grant it to any other tenant
 * (`1758900000000-SeedOnlyClass.ts`). It is authored and published through
 * `CatalogAuthoringService` — the same validation and compilation every library class
 * goes through — not written around it.
 *
 * Through the platform's own services where one exists (authoring, publish, grant and
 * copy-on-grant, provisioning, alert evaluation); direct rows where the platform has no
 * write path of its own for that data (profiles, devices, bindings, shifts, telemetry).
 */

export const DEMO_TENANT = 'demo-construction';
export const DEMO_CLASS = 'demo-excavator';
export const DEMO_SOURCE = 'seed-demo';
/** The seeder's own site class (D-004): the platform `default` binds no KPI, and adding
 * any to it would put them on every customer's site page. */
export const DEMO_SITE_CLASS = 'demo-site';
const SEEDER = 'seed-demo';
const STEP_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** IST, where the demo site is: shifts and the daily temperature cycle follow it. */
const TIME_ZONE = 'Asia/Kolkata';
const TZ_OFFSET_MS = 330 * 60_000;

const PLATFORM: RequestScope = { tenantId: '', userId: SEEDER, roles: ['master-admin'], isPlatformRole: true };

export interface DemoSignal {
  signal: string;
  unit: string;
  criticality: 'required' | 'recommended';
  description: string;
}

/** Canonical names from `common/signals.ts`, so Availability and the duty cycle read
 * them without an alias. */
export const DEMO_SIGNALS: DemoSignal[] = [
  { signal: 'engine_running_status', unit: 'state', criticality: 'required', description: 'Engine running (1) or stopped (0).' },
  { signal: 'engine_coolant_temperature', unit: 'degC', criticality: 'required', description: 'Engine coolant temperature.' },
  { signal: 'engine_oil_pressure', unit: 'kPa', criticality: 'required', description: 'Engine oil pressure.' },
  { signal: 'hydraulic_oil_temperature', unit: 'degC', criticality: 'required', description: 'Hydraulic oil temperature at the tank.' },
  { signal: 'fuel_level', unit: '%', criticality: 'required', description: 'Fuel tank level.' },
  { signal: 'engine_load', unit: '%', criticality: 'recommended', description: 'Engine load, percent of rated.' },
];

/**
 * Cadence and staleness from one number. The platform has no class-level cadence field:
 * cadence lives on each binding (`expected_period_seconds`), staleness on each requirement
 * (`stale_after_seconds`, else the 900 s default) — two columns that nothing ties
 * together. EX-04 reads `stale` only if they line up, so both derive from `STEP_MS` here:
 * a signal is stale after six missed readings.
 */
export const CADENCE_SECONDS = STEP_MS / 1000;
export const STALE_AFTER_SECONDS = 6 * CADENCE_SECONDS;
const COOLANT_MAX = 105;

export type MachineState = 'healthy' | 'trending' | 'breaching' | 'quiet' | 'new' | 'partly_unbound';

export interface DemoMachine {
  externalId: string;
  name: string;
  state: MachineState;
  /** Days of history, ending `endDaysAgo` before now. */
  historyDays: number;
  endDaysAgo: number;
  unbound: string[];
  expect: string;
}

export const DEMO_MACHINES: DemoMachine[] = [
  {
    externalId: 'EX-01', name: 'EX-01 Healthy', state: 'healthy', historyDays: 90, endDaysAgo: 0, unbound: [],
    expect: 'Everything ready. KPIs inside target; availability high (a two-hour stop every Wednesday afternoon); no alerts. '
      + 'KNOWN DEFECT (QFIX-BASELINE): the baseline charts swing about ±1.5σ every day on every machine, this one '
      + 'included — the 30-day baseline mixes running and parked hours. Report it if you see it; it is not expected behaviour.',
  },
  {
    externalId: 'EX-02', name: 'EX-02 Trending', state: 'trending', historyDays: 90, endDaysAgo: 0, unbound: [],
    expect: 'Ready. Coolant drifts up by about 14 °C over the last 10 days, still under the 105 °C bound; '
      + 'its coolant-vs-baseline chart rides higher than EX-01\'s during running hours, though the gap is smaller '
      + 'than it should be until QFIX-BASELINE (known defect); no alert.',
  },
  {
    externalId: 'EX-03', name: 'EX-03 Breaching', state: 'breaching', historyDays: 90, endDaysAgo: 0, unbound: [],
    expect: '6 of the last 10 coolant readings of its latest operating run above 105 °C: one open high-severity alert '
      + 'from the class rule (M-of-N, 6 of 10), raised on that run whatever hour the seed ran; the incident view lists '
      + 'it; the COOLANT_OVERHEAT failure mode reads active.',
  },
  {
    externalId: 'EX-04', name: 'EX-04 Gone quiet', state: 'quiet', historyDays: 60, endDaysAgo: 3, unbound: [],
    expect: 'Bound, 60 days of history, nothing for 3 days: signals read not_available / stale — not no_readings.',
  },
  {
    externalId: 'EX-05', name: 'EX-05 Newly commissioned', state: 'new', historyDays: 9, endDaysAgo: 0, unbound: [],
    expect: '9 days of history: plain KPIs ready; every baseline KPI reads not_available / baseline_not_established.',
  },
  {
    externalId: 'EX-06', name: 'EX-06 Partly unbound', state: 'partly_unbound', historyDays: 90, endDaysAgo: 0,
    unbound: ['hydraulic_oil_temperature', 'fuel_level'],
    expect: 'Hydraulic oil temperature and fuel level have no binding (the device still reports both): those two '
      + 'signals and every KPI on them read not_configured / unbound; the rest ready.',
  },
];

export const imeiOf = (m: DemoMachine) => `35800000000${m.externalId.slice(-2)}00`;

export interface SeedDemoResult {
  created: boolean;
  /** Rows written, per table. */
  counts: Record<string, number>;
  /** The super admin's invitation — returned once, for the console's accept-invite flow. */
  invitationToken: string | null;
  adminEmail: string;
}

export function requireEnabled(env = process.env): void {
  if (env.SEED_DEMO_ENABLED !== 'true') {
    throw new Error(
      'Refused: seed:demo writes a whole tenant. Pass SEED_DEMO_ENABLED=true for this one command '
      + '(never as a standing variable on a deployed service).',
    );
  }
}

const services = (ds: DataSource) => {
  const authoring = new CatalogAuthoringService(
    ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula),
    ds.getRepository(ScenarioDefinition), ds.getRepository(SignalAlias), ds.getRepository(AlertRuleTemplate),
    ds.getRepository(NamedFormula), ds.getRepository(SensorRoleCapability),
  );
  const copies = new CopyOnGrantService(ds);
  return {
    authoring,
    entitlements: new EntitlementService(
      ds.getRepository(ClientCatalogEntitlement), ds.getRepository(EquipmentClassProfile), copies,
    ),
    provisioning: new ProvisioningService(ds, new PasswordService()),
    alerts: new AlertService(ds),
  };
};

/** Whether a complete demo is present, a partial one, or none. */
async function presence(ds: DataSource): Promise<'none' | 'complete' | 'partial'> {
  const [{ tenants }] = await ds.query(`SELECT count(*)::int AS tenants FROM tenant WHERE tenant_id = $1`, [DEMO_TENANT]);
  const [{ classes }] = await ds.query(`SELECT count(*)::int AS classes FROM equipment_class_profile WHERE slug = $1`, [DEMO_CLASS]);
  const [{ sites }] = await ds.query(`SELECT count(*)::int AS sites FROM site_class WHERE slug = $1`, [DEMO_SITE_CLASS]);
  if (!tenants && !classes && !sites) return 'none';
  const [{ done }] = await ds.query(
    `SELECT count(*)::int AS done FROM equipment_shift WHERE tenant_id = $1 AND created_by = $2`, [DEMO_TENANT, SEEDER],
  );
  return done === DEMO_MACHINES.length ? 'complete' : 'partial';
}

export async function seedDemo(
  ds: DataSource,
  opts: { now?: Date; adminEmail?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SeedDemoResult> {
  const env = opts.env ?? process.env;
  requireEnabled(env);
  const adminEmail = (opts.adminEmail ?? env.SEED_DEMO_ADMIN_EMAIL ?? 'demo-admin@demo-construction.example').toLowerCase();
  const now = new Date(Math.floor((opts.now ?? new Date()).getTime() / STEP_MS) * STEP_MS);

  const state = await presence(ds);
  if (state === 'complete') return { created: false, counts: {}, invitationToken: null, adminEmail };
  if (state === 'partial') {
    throw new Error(
      `A partial demo is present (tenant "${DEMO_TENANT}" or class "${DEMO_CLASS}" without all six machines). `
      + 'Run seed:demo:reset, then seed:demo.',
    );
  }

  // The grant path checks the same variable the seeder does; seeding from code (a
  // test) passes `env` without touching the process.
  const previous = process.env.SEED_DEMO_ENABLED;
  process.env.SEED_DEMO_ENABLED = 'true';
  try {
    const s = services(ds);
    await authorClass(ds, s.authoring);
    await authorSiteClass(ds);
    const provisioned = await s.provisioning.provision(PLATFORM, {
      tenantId: DEMO_TENANT, name: 'Demo Construction', plan: 'demo', region: 'IN',
      superAdmin: { email: adminEmail, fullName: 'Demo Admin' },
    }, now);
    await s.entitlements.grant(PLATFORM, DEMO_TENANT, DEMO_CLASS, 'Demo tenant only (seed-only class).');
    await seedSiteAndMachines(ds, now);
    await seedTelemetry(ds, now);
    await raiseAlerts(ds, s.alerts, now);
    return { created: true, counts: await countDemoRows(ds), invitationToken: provisioned.invitationToken, adminEmail };
  } finally {
    if (previous === undefined) delete process.env.SEED_DEMO_ENABLED;
    else process.env.SEED_DEMO_ENABLED = previous;
  }
}

// ======================================================================== the class

async function authorClass(ds: DataSource, authoring: CatalogAuthoringService): Promise<void> {
  await authoring.createClass(PLATFORM, DEMO_CLASS, {
    name: 'Demo excavator (seed-only)',
    description: 'Authored by seed:demo for the demo tenant. Not library content.',
    category: 'Earthmoving',
    expectedSignals: DEMO_SIGNALS.map((s) => ({
      signal: s.signal, unit: s.unit, required: s.criticality === 'required', description: s.description,
    })),
    failureModes: [
      { code: 'COOLANT_OVERHEAT', name: 'Cooling system degradation', symptom: 'Coolant temperature rising under normal load', signals: ['engine_coolant_temperature'], severity: Severity.High },
      { code: 'HYD_OVERHEAT', name: 'Hydraulic oil overheating', symptom: 'Hydraulic oil above its working band', signals: ['hydraulic_oil_temperature'], severity: Severity.Medium },
      { code: 'LOW_OIL_PRESSURE', name: 'Low engine oil pressure', symptom: 'Oil pressure falling while running', signals: ['engine_oil_pressure'], severity: Severity.Critical },
    ] as never,
  });
  await ds.query(`UPDATE equipment_class_profile SET seed_only = true WHERE slug = $1`, [DEMO_CLASS]);

  await ds.transaction(async (m) => {
    await insertClassContent(m, DEMO_CLASS, 1, [], [
      { failureModeCode: 'COOLANT_OVERHEAT', action: 'Inspect radiator fins and coolant level; check fan belt tension.', urgency: 'next_shift', estimatedHours: 2, requiredParts: null },
      { failureModeCode: 'HYD_OVERHEAT', action: 'Check the hydraulic oil cooler and oil level.', urgency: 'next_service', estimatedHours: 1.5, requiredParts: null },
      { failureModeCode: 'LOW_OIL_PRESSURE', action: 'Stop the engine; check oil level and the pressure sender.', urgency: 'immediate', estimatedHours: 1, requiredParts: null },
    ], { source: 'manual', importBatchId: null });

    await m.getRepository(EquipmentClassSensorRequirement).save(DEMO_SIGNALS.map((s) => ({
      classSlug: DEMO_CLASS, classVersion: 1, measurementRole: s.signal, componentScope: '',
      criticality: s.criticality, minCount: 1, canonicalUnit: s.unit, enables: [], notes: null,
      staleAfterSeconds: STALE_AFTER_SECONDS,
    })));

    const formula = (formulaKey: string, expression: string, extra: Partial<EquipmentClassFormula> = {}) => ({
      classSlug: DEMO_CLASS, classVersion: 1, formulaKey, kind: 'empirical' as const, expression,
      inputs: [], outputUnit: null, basis: 'seed-demo', status: 'approved' as const, approvedBy: SEEDER,
      approvedAt: new Date(), aggregationWindow: '24h' as const, chartType: 'number' as const, ...extra,
    });
    await m.getRepository(EquipmentClassFormula).save([
      formula('avg_coolant_temp', 'avg(engine_coolant_temperature)', { targetValue: 100, targetDirection: 'lower_better' }),
      formula('coolant_trace', 'engine_coolant_temperature', { chartType: 'line' }),
      formula('avg_oil_pressure', 'avg(engine_oil_pressure)', { targetValue: 250, targetDirection: 'higher_better' }),
      formula('avg_hydraulic_temp', 'avg(hydraulic_oil_temperature)', { targetValue: 75, targetDirection: 'lower_better' }),
      formula('avg_fuel_level', 'avg(fuel_level)'),
      formula('avg_engine_load', 'avg(engine_load)'),
      // Against the machine's own last thirty days. A series: the baseline operators
      // are, and a reducer over their output is refused at publish (QCE5 follow-up).
      formula('coolant_vs_baseline', 'zscore(engine_coolant_temperature, 30d)', { chartType: 'line', displayFormat: 'number:2' }),
      formula('hydraulic_vs_baseline', 'zscore(hydraulic_oil_temperature, 30d)', { chartType: 'line', displayFormat: 'number:2' }),
    ].map((f) => m.getRepository(EquipmentClassFormula).create(f)));

    const widgets: [string, string, string | null, 'small' | 'medium' | 'large' | 'full'][] = [
      ['readiness_list', 'readiness', null, 'medium'],
      ['kpi_number', 'avg_coolant_temp', 'avg_coolant_temp', 'small'],
      ['kpi_chart', 'coolant_vs_baseline', 'coolant_vs_baseline', 'medium'],
      ['kpi_number', 'avg_hydraulic_temp', 'avg_hydraulic_temp', 'small'],
      ['kpi_chart', 'hydraulic_vs_baseline', 'hydraulic_vs_baseline', 'medium'],
      ['kpi_number', 'avg_oil_pressure', 'avg_oil_pressure', 'small'],
      ['kpi_number', 'avg_fuel_level', 'avg_fuel_level', 'small'],
      ['kpi_chart', 'coolant_trace', 'coolant_trace', 'large'],
      ['signal_chart', 'hydraulic_chart', 'hydraulic_oil_temperature', 'medium'],
      ['alert_list', 'alerts', null, 'medium'],
      ['work_order_list', 'work_orders', null, 'medium'],
      ['failure_modes', 'failure_modes', null, 'medium'],
      ['recommendations', 'recommendations', null, 'medium'],
    ];
    await m.getRepository(EquipmentClassLayout).save(widgets.map(([widgetType, widgetKey, boundTo, size], i) =>
      m.getRepository(EquipmentClassLayout).create({
        classSlug: DEMO_CLASS, classVersion: 1, widgetType: widgetType as never, widgetKey, boundTo,
        title: null, position: i + 1, size, source: 'manual', importBatchId: null,
      })));
  });

  await authoring.publishClass(PLATFORM, DEMO_CLASS);

  await authoring.createAlertTemplate(PLATFORM, 'demo-excavator-coolant-high', {
    equipmentClassSlug: DEMO_CLASS, name: 'Coolant above 105 °C',
    description: '6 of the last 10 coolant readings above 105 °C.',
    trigger: 'signal-threshold', params: { signal: 'engine_coolant_temperature', max: COOLANT_MAX },
    severity: Severity.High, enabledOnCopy: true,
  } as never);
  await authoring.publishAlertTemplate(PLATFORM, 'demo-excavator-coolant-high');

  // Two scenarios so the recommendation engine has something to place for each machine:
  // the 14-day one is availableLater on the 9-day machine; the hydraulic one is
  // missing-signals wherever hydraulic oil temperature is not mapped.
  for (const [slug, name, signals, minimumHistoryDays] of [
    ['demo-excavator-coolant-drift', 'Coolant drift against own baseline', ['engine_coolant_temperature'], 14],
    ['demo-excavator-hydraulic-heat', 'Hydraulic oil heat soak', ['hydraulic_oil_temperature', 'engine_load'], 7],
  ] as const) {
    await authoring.createScenario(PLATFORM, slug, {
      equipmentClassSlug: DEMO_CLASS, name, description: `${name} (seed-only).`, severity: Severity.Medium,
      tier: 1, requiredSignals: [...signals], minimumHistoryDays, parameters: [],
    });
    await authoring.publishScenario(PLATFORM, slug);
  }
}

// ===================================================================== the site class

/**
 * Site KPIs over the six machines (D-004), each declaring how it combines them. Chosen
 * so the exclusions are visible: EX-04 is stale on all three, and EX-06 has no fuel
 * binding, so fuel reads from four machines and says which two it left out.
 */
export const DEMO_SITE_LAYOUT: SiteLayoutWidget[] = [
  { widgetType: 'machine_list', widgetKey: 'machines', boundTo: null, title: null, position: 1, size: 'full', aggregate: null },
  { widgetType: 'kpi_number', widgetKey: 'site_avg_coolant', boundTo: 'avg_coolant_temp', title: 'Average coolant temperature', position: 2, size: 'small', aggregate: 'avg' },
  { widgetType: 'kpi_number', widgetKey: 'site_min_oil_pressure', boundTo: 'avg_oil_pressure', title: 'Lowest oil pressure', position: 3, size: 'small', aggregate: 'min' },
  { widgetType: 'kpi_number', widgetKey: 'site_avg_fuel', boundTo: 'avg_fuel_level', title: 'Average fuel level', position: 4, size: 'small', aggregate: 'avg' },
  { widgetType: 'alert_list', widgetKey: 'alerts', boundTo: null, title: null, position: 5, size: 'medium', aggregate: null },
  { widgetType: 'work_order_list', widgetKey: 'work_orders', boundTo: null, title: null, position: 6, size: 'medium', aggregate: null },
];

/** Through the platform's own layout check, as the equipment class goes through publish;
 * site classes have no publish path, so the check is called here rather than skipped. */
async function authorSiteClass(ds: DataSource): Promise<void> {
  const problems = siteLayoutProblems(DEMO_SITE_LAYOUT);
  if (problems.length) throw new Error(`The demo site layout is invalid: ${problems.join(' ')}`);
  await ds.transaction(async (m) => {
    await m.query(
      `INSERT INTO site_class (slug, version, name, description, status, published_at, created_by, seed_only)
         VALUES ($1, 1, 'Demo site (seed-only)', 'Authored by seed:demo for the demo tenant. Not library content.',
                 'published', now(), $2, true)`,
      [DEMO_SITE_CLASS, SEEDER],
    );
    for (const w of DEMO_SITE_LAYOUT) {
      await m.query(
        `INSERT INTO site_class_layout (site_class_slug, class_version, widget_type, widget_key, bound_to, title, position, size, aggregate)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [DEMO_SITE_CLASS, w.widgetType, w.widgetKey, w.boundTo, w.title, w.position, w.size, w.aggregate],
      );
    }
  });
}

// ============================================================ site, machines, devices

async function seedSiteAndMachines(ds: DataSource, now: Date): Promise<void> {
  await runTenantSpanning(ds, 'seed:demo machines', async (m: EntityManager) => {
    // The one session allowed to point a plant at a seed-only site class
    // (`ck_seed_only_site`), for this transaction only.
    await m.query(`SELECT set_config('ta.seed_demo', 'on', true)`);
    const [plant] = await m.query(
      `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version, description)
         VALUES ($1, 'PUNE-01', 'Pune ring road package', $2, 1, 'Demo site (seed:demo).') RETURNING id`,
      [DEMO_TENANT, DEMO_SITE_CLASS],
    );
    // A second site with no machines on it yet: every site KPI there reads
    // no_ready_machines with a null value — the case a naive sum shows as 0.
    await m.query(
      `INSERT INTO plant (tenant_id, code, name, site_class_slug, site_class_version, description)
         VALUES ($1, 'PUNE-02', 'Pune yard (no machines yet)', $2, 1, 'Empty demo site (seed:demo).')`,
      [DEMO_TENANT, DEMO_SITE_CLASS],
    );

    await m.getRepository(TenantMap).save({
      sourceSystem: DEMO_SOURCE, externalClientId: 'demo-construction', tenantId: DEMO_TENANT, displayName: 'Demo Construction',
    });

    const base = { sourceSystem: DEMO_SOURCE, tenantId: DEMO_TENANT, sourceUpdatedAt: now, syncedAt: now, status: 'live' as const };
    for (const machine of DEMO_MACHINES) {
      const imei = imeiOf(machine);
      const commissionedAt = new Date(now.getTime() - (machine.historyDays + machine.endDaysAgo) * DAY_MS);
      await m.getRepository(EquipmentProfile).save({
        tenantId: DEMO_TENANT, sourceSystem: DEMO_SOURCE, externalId: machine.externalId, name: machine.name,
        equipmentClassSlug: DEMO_CLASS, classVersion: 1, tier: 'advanced', commissionedAt,
        serviceIntervalHours: 250, readiness: {}, updatedBy: SEEDER, plantId: plant.id,
      });
      // The projection rows Availability and the recommendation engine still read
      // (QFIX-DEVICES-2 moves those to bindings); the same IMEI as the binding and the
      // inventory row, so every reader agrees on which device is on which machine.
      await m.getRepository(EquipmentProjection).save({
        ...base, externalId: machine.externalId, payload: { seed: SEEDER }, checksum: `seed-${machine.externalId}`,
        name: machine.name, classId: DEMO_CLASS, plantExternalId: null, category: null,
      });
      await m.getRepository(DeviceProjection).save({
        ...base, externalId: `dev-${imei}`, payload: { seed: SEEDER }, checksum: `seed-dev-${imei}`,
        imei, equipmentExternalId: machine.externalId, name: `Logger on ${machine.externalId}`,
      });
      await m.getRepository(SensorMapProjection).save(DEMO_SIGNALS.map((s) => ({
        ...base, externalId: `${imei}-${s.signal}`, payload: { seed: SEEDER }, checksum: `seed-${imei}-${s.signal}`,
        imei, signal: s.signal, sensorName: s.signal, unit: s.unit,
      })));
      await m.query(
        `INSERT INTO device_inventory (imei, tenant_id, state, model, batch_ref, assigned_at, assigned_by,
                                       equipment_external_id, claimed_at, claimed_by)
           VALUES ($1, $2, 'assigned', 'TA-OBD-CAN', $3, $4, $3, $5, $4, $3)`,
        [imei, DEMO_TENANT, SEEDER, commissionedAt, machine.externalId],
      );
      await m.getRepository(SignalBindingVersion).save(
        DEMO_SIGNALS.filter((s) => !machine.unbound.includes(s.signal)).map((s) => ({
          tenantId: DEMO_TENANT, sourceSystem: DEMO_SOURCE, externalId: machine.externalId,
          signalKey: s.signal, measurementRole: s.signal, componentId: '', origin: 'physical' as const,
          imei, channel: s.signal, sensorInstanceId: null, canonicalUnit: s.unit, sourceUnit: null,
          validFrom: commissionedAt, validTo: null, expectedPeriodSeconds: CADENCE_SECONDS,
          isPrimary: true, status: 'active' as const, discoveredFrom: null, discoveredBy: 'manual' as const,
          approvedBy: SEEDER, approvedAt: commissionedAt,
        })),
      );
      // Weekdays 08:00–18:00 IST. Scored through now: this history was seeded, not
      // observed, and the shift runner should not replay ninety days of it.
      await m.getRepository(EquipmentShift).save({
        tenantId: DEMO_TENANT, sourceSystem: DEMO_SOURCE, externalId: machine.externalId, name: 'Day shift',
        startMinute: 8 * 60, endMinute: 18 * 60, days: [1, 2, 3, 4, 5], timeZone: TIME_ZONE, status: 'active',
        scoredThrough: now, arrivalsThrough: now, createdBy: SEEDER, updatedBy: SEEDER,
      });
    }
  });
}

// ======================================================================== telemetry

/** Deterministic, so a reseed draws the same demo — and a test can assert on it. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const local = (t: number) => {
  const d = new Date(t + TZ_OFFSET_MS);
  return { hour: d.getUTCHours() + d.getUTCMinutes() / 60, dow: d.getUTCDay(), day: Math.floor((t + TZ_OFFSET_MS) / DAY_MS) };
};

/** In shift, minus a two-hour stop every Wednesday afternoon — so availability is high,
 * not a suspicious 100%. */
const running = (t: number) => {
  const { hour, dow } = local(t);
  if (dow < 1 || dow > 5 || hour < 8 || hour >= 18) return false;
  return !(dow === 3 && hour >= 13 && hour < 15);
};

/** The value one signal reports at `t`: a daily cycle, noise, and per-machine drift —
 * never a straight line, because a flat series makes `baseline_sd` zero and every
 * baseline KPI `undefined_result`, which would look like a bug and is not. */
export function demoValue(machine: DemoMachine, signal: string, t: number, now: number, noise: () => number): number {
  const on = running(t);
  const { hour } = local(t);
  const n = (scale: number) => (noise() - 0.5) * 2 * scale;
  const cycle = Math.sin((2 * Math.PI * (hour - 8)) / 10);
  switch (signal) {
    case 'engine_running_status': return on ? 1 : 0;
    case 'engine_load': return on ? Math.min(100, Math.max(5, 58 + 12 * cycle + n(4))) : 0;
    case 'engine_oil_pressure': return on ? 390 + 15 * cycle + n(6) : Math.abs(n(2));
    case 'hydraulic_oil_temperature': return on ? 62 + 5 * cycle + n(1.5) : 33 + 2 * Math.sin((2 * Math.PI * hour) / 24) + n(0.6);
    case 'fuel_level': return Math.min(98, Math.max(5, 55 + 30 * Math.sin((2 * Math.PI * t) / (3.2 * DAY_MS)) + n(0.8)));
    case 'engine_coolant_temperature': {
      if (!on) return 34 + 3 * Math.sin((2 * Math.PI * hour) / 24) + n(0.8);
      // Trending: up to +14 °C across the last ten days — 98 °C or so by now, under the
      // 105 °C bound with room for the noise.
      const drift = machine.state === 'trending' ? 14 * Math.min(1, Math.max(0, (t - (now - 10 * DAY_MS)) / (10 * DAY_MS))) : 0;
      return 84 + 3 * cycle + n(1.2) + drift;
    }
    default: throw new Error(`No demo model for "${signal}".`);
  }
}

/** The breaching machine's last ten coolant readings: six past 105 °C, four not —
 * exactly the class rule's 6-of-10. Set whatever the hour, so the demo breaches
 * whenever it is seeded. */
export const BREACH_TAIL = [101, 108, 99, 110, 107, 100, 109, 111, 98, 106];

/** Every reading tick for one machine, oldest first. */
function ticksOf(machine: DemoMachine, nowMs: number): number[] {
  const end = nowMs - machine.endDaysAgo * DAY_MS;
  const start = end - machine.historyDays * DAY_MS;
  const times: number[] = [];
  for (let t = start; t <= end; t += STEP_MS) times.push(t);
  return times;
}

/**
 * The ticks of the most recent operating run — in shift, engine running — with at least
 * `min` readings. From the shift calendar, not the wall clock (a QSEED1 defect, found
 * during QFIX-BASELINE): the breach used to be stamped on the last ten ticks before the
 * seed ran, so a seed at 06:10 put 108 °C coolant on a parked engine — not physical, and
 * different depending on the hour somebody happened to run the seeder. A full shift is
 * 60 ticks, so this is today's shift once it is under way, otherwise the last working day's.
 */
export function latestOperatingRun(times: number[], min: number): number[] {
  let run: number[] = [];
  let latest: number[] = [];
  for (const t of times) {
    if (running(t)) { run.push(t); continue; }
    if (run.length >= min) latest = run;
    run = [];
  }
  return run.length >= min ? run : latest;
}

async function seedTelemetry(ds: DataSource, now: Date): Promise<void> {
  const nowMs = now.getTime();
  for (const machine of DEMO_MACHINES) {
    const times = ticksOf(machine, nowMs);

    for (const month of new Set(times.map((t) => new Date(t).toISOString().slice(0, 7)))) {
      await ds.query(`SELECT ensure_telemetry_partition($1::date)`, [`${month}-01`]);
    }

    for (const [index, s] of DEMO_SIGNALS.entries()) {
      const noise = prng(Number(machine.externalId.slice(-2)) * 101 + index);
      const values = times.map((t) => demoValue(machine, s.signal, t, nowMs, noise));
      if (machine.state === 'breaching' && s.signal === 'engine_coolant_temperature') {
        const run = latestOperatingRun(times, BREACH_TAIL.length);
        run.slice(-BREACH_TAIL.length).forEach((t, i) => { values[times.indexOf(t)] = BREACH_TAIL[i]; });
      }
      await runTenantSpanning(ds, 'seed:demo telemetry', (m) => m.query(
        `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
           SELECT $1, $2, $3, v, $4, ts, ts, 'simulated'
             FROM unnest($5::timestamptz[], $6::double precision[]) AS r(ts, v)`,
        [DEMO_TENANT, imeiOf(machine), s.signal, s.unit, times.map((t) => new Date(t).toISOString()), values],
      ));
    }
  }
}

// ========================================================================= alerts

/** The class rule judges each machine's latest operating run the way the shift runner
 * judges a shift — through `evaluateWindow`, so the breaching machine's alert is raised
 * by the engine, not written by the seeder. */
async function raiseAlerts(ds: DataSource, alerts: AlertService, now: Date): Promise<void> {
  for (const machine of DEMO_MACHINES) {
    const run = latestOperatingRun(ticksOf(machine, now.getTime()), BREACH_TAIL.length);
    if (!run.length) continue;
    const windowStart = new Date(run[0]);
    const windowEnd = new Date(run[run.length - 1] + STEP_MS);
    const rows: { signal: string; value: number; unit: string; ts: Date }[] = await runTenantSpanning(
      ds, 'seed:demo alert window', (m) => m.query(
        `SELECT signal, value, unit, source_timestamp AS ts FROM telemetry_reading
          WHERE tenant_id = $1 AND imei = $2 AND source_timestamp > $3 AND source_timestamp < $4
          ORDER BY source_timestamp`,
        [DEMO_TENANT, imeiOf(machine), new Date(windowStart.getTime() - 1), windowEnd],
      ),
    );
    if (!rows.length) continue;
    await alerts.evaluateWindow({
      tenantId: DEMO_TENANT, sourceSystem: DEMO_SOURCE, externalId: machine.externalId,
      shiftLocalDate: new Date(windowStart.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10),
      windowStart, windowEnd,
      readings: rows.map((r) => ({
        imei: imeiOf(machine), signal: r.signal, value: Number(r.value), unit: r.unit,
        sourceTimestamp: new Date(r.ts).toISOString(),
      })),
      predictions: [], chains: [],
    });
  }
}

// ========================================================================== reset

/** Every table holding the demo tenant's rows, found from the schema rather than
 * listed — a list is one new tenant table away from leaving rows behind. */
async function tenantTables(ds: DataSource): Promise<string[]> {
  const rows: { table_name: string }[] = await ds.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Platform-level rows the seeder authored: the seed-only class and what hangs off it. */
const CLASS_TABLES: [string, string][] = [
  ['equipment_class_recommendation', 'class_slug'],
  ['equipment_class_failure_mode', 'class_slug'],
  ['equipment_class_visual_anchor', 'class_slug'],
  ['equipment_class_visual', 'class_slug'],
  ['equipment_class_layout', 'class_slug'],
  ['equipment_class_formula', 'class_slug'],
  ['equipment_class_sensor_requirement', 'class_slug'],
  ['scenario_definition', 'equipment_class_slug'],
  ['alert_rule_template', 'equipment_class_slug'],
  ['equipment_class_profile', 'slug'],
];

export async function countDemoRows(ds: DataSource): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await runTenantSpanning(ds, 'seed:demo count', async (m) => {
    for (const table of await tenantTables(ds)) {
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`, [DEMO_TENANT]);
      if (n) counts[table] = n;
    }
    for (const [table, column] of CLASS_TABLES) {
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [DEMO_CLASS]);
      if (n) counts[table] = (counts[table] ?? 0) + n;
    }
    for (const table of ['site_class_layout', 'site_class']) {
      const column = table === 'site_class' ? 'slug' : 'site_class_slug';
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [DEMO_SITE_CLASS]);
      if (n) counts[table] = n;
    }
    const [{ users }] = await m.query(
      `SELECT count(*)::int AS users FROM app_user WHERE tenant_id = $1`, [DEMO_TENANT],
    );
    if (users) counts.app_user = users;
  });
  return counts;
}

export async function resetDemo(ds: DataSource, env = process.env): Promise<Record<string, number>> {
  requireEnabled(env);
  const removed: Record<string, number> = {};
  const seedOnly = await ds.query(`SELECT 1 FROM equipment_class_profile WHERE slug = $1 AND NOT seed_only`, [DEMO_CLASS]);
  if (seedOnly.length) {
    // Never delete a class that is not ours, whatever its name: the slug alone is a convention.
    throw new Error(`"${DEMO_CLASS}" exists and is not seed_only — refusing to remove library content.`);
  }
  if ((await ds.query(`SELECT 1 FROM site_class WHERE slug = $1 AND NOT seed_only`, [DEMO_SITE_CLASS])).length) {
    throw new Error(`Site class "${DEMO_SITE_CLASS}" exists and is not seed_only — refusing to remove library content.`);
  }
  await runTenantSpanning(ds, 'seed:demo reset', async (m) => {
    // The one session allowed to delete published seed-only content
    // (`ck_class_content_draft_only`), for this transaction only.
    await m.query(`SELECT set_config('ta.seed_demo', 'on', true)`);
    // Tenant rows reference each other; delete in passes until a pass removes nothing
    // and nothing is left, rather than hand-ordering every foreign key.
    let remaining = await tenantTables(ds);
    for (let pass = 0; remaining.length && pass < 20; pass += 1) {
      const blocked: string[] = [];
      for (const table of remaining) {
        await m.query(`SAVEPOINT demo_reset`);
        try {
          const result = await m.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [DEMO_TENANT]);
          const n = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
          if (n) removed[table] = (removed[table] ?? 0) + n;
          await m.query(`RELEASE SAVEPOINT demo_reset`);
        } catch (err) {
          await m.query(`ROLLBACK TO SAVEPOINT demo_reset`);
          if ((err as { code?: string }).code !== '23503') throw err; // only foreign keys are retried
          blocked.push(table);
        }
      }
      if (blocked.length === remaining.length) {
        throw new Error(`seed:demo:reset could not clear: ${blocked.join(', ')}.`);
      }
      remaining = blocked;
    }
    for (const [table, column] of CLASS_TABLES) {
      const result = await m.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [DEMO_CLASS]);
      const n = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      if (n) removed[table] = (removed[table] ?? 0) + n;
    }
    // After the plants (tenant rows, above), which reference it.
    for (const [table, column] of [['site_class_layout', 'site_class_slug'], ['site_class', 'slug']]) {
      const result = await m.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [DEMO_SITE_CLASS]);
      const n = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      if (n) removed[table] = (removed[table] ?? 0) + n;
    }
  });
  return removed;
}

// ============================================================================ CLI

async function main() {
  requireEnabled();
  const ds = await new DataSource(dataSourceOptions(process.env, { appRole: null })).initialize();
  try {
    if (process.argv.includes('--reset')) {
      const removed = await resetDemo(ds);
      // eslint-disable-next-line no-console
      console.log(Object.keys(removed).length ? `Removed, per table: ${JSON.stringify(removed, null, 2)}` : 'No demo tenant to remove.');
      return;
    }
    const result = await seedDemo(ds);
    if (!result.created) {
      // eslint-disable-next-line no-console
      console.log(`The demo tenant "${DEMO_TENANT}" is already seeded. Run seed:demo:reset first to reseed.`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log([
      `Seeded "${DEMO_TENANT}". Rows created, per table:`, JSON.stringify(result.counts, null, 2),
      `Super admin ${result.adminEmail} is invited, not active. Invitation token (shown once): ${result.invitationToken}`,
      '', 'What each machine should show:', ...DEMO_MACHINES.map((mc) => `  ${mc.externalId} — ${mc.expect}`),
      '', 'Site pages: PUNE-01 aggregates the six (EX-04 excluded as stale; EX-06 excluded from fuel as unbound);',
      '  PUNE-02 has no machines, so every site KPI reads not_available / no_ready_machines, value null.',
    ].join('\n'));
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
