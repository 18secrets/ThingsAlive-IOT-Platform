import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { AlertService } from '../alert/services/alert.service';
import { RequestScope } from '../auth/types/request-scope';
import { SiteClass } from '../catalog/entities/site-class.entity';
import { fallbackLayout, LayoutWidget } from '../catalog/layout/layout-rules';
import { WidgetType } from '../catalog/layout/widget-types';
import { resolveSiteClass, siteLayout, SiteLayoutWidget } from '../catalog/services/class-layout';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../client-catalog/entities/client-formula.entity';
import { ClientCatalogService } from '../client-catalog/services/client-catalog.service';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { pickBucketSeconds } from '../kpi/services/bucketing';
import { KpiEvaluatorService } from '../kpi/services/kpi-evaluator.service';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { EquipmentRef, KpiEnvelope } from '../kpi/types';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { withTenantSession } from '../scope/tenant-session';
import { ServiceForecastService } from '../service/services/service-forecast.service';
import { classifyFreshness } from '../signal-binding/services/signal-freshness';
import { SignalBindingService } from '../signal-binding/services/signal-binding.service';
import { WorkOrderService } from '../work/services/work-order.service';
import {
  AlertRow, FailureModeRow, FailureModeStatus, filled, KpiWidgetData, MachineRow, PageReadiness, PageWidget,
  READINESS_SEVERITY, ReadinessRow, signalReadiness, SiteKpiData, unfilled,
} from './page-widgets';

const KPI_TYPES: ReadonlySet<WidgetType> = new Set(['kpi_number', 'kpi_gauge', 'kpi_chart']);
const OPEN_ALERT_STATES = ['open', 'acknowledged'];
const OPEN_WORK_STATES = ['created', 'in-progress'];
/** The signal_chart window. Not stated by the task; a day is what the readiness
 * thresholds and the fallback KPIs already read in, and it is reported as such. */
const SIGNAL_CHART_WINDOW_MS = 24 * 3_600_000;

type Header = Pick<PageWidget, 'widgetKey' | 'widgetType' | 'title' | 'position' | 'size'>;
const header = (w: LayoutWidget): Header => ({
  widgetKey: w.widgetKey, widgetType: w.widgetType as WidgetType, title: w.title, position: w.position, size: w.size,
});

export interface MachinePage {
  equipment: {
    sourceSystem: string; externalId: string; name: string | null;
    classSlug: string | null; classVersion: number | null; plantId: string | null;
  };
  layout: { fallback: boolean };
  widgets: PageWidget[];
}

export interface SitePage {
  site: { plantId: string; code: string; name: string; siteClass: { slug: string; version: number } };
  layout: { fallback: boolean };
  widgets: PageWidget[];
}

/**
 * The composed page (task QPAGE1, D29).
 *
 * **It composes; it does not compute.** Every value on the page comes from the one
 * producer it already has — the evaluator, the coverage resolver, the alert, work
 * order and service services, the tenant's class copy. Where a producer cannot
 * answer, the widget carries that state; it never goes and finds an answer
 * somewhere else. The one arithmetic done here is the site aggregate, because the
 * task declares it (`site_class_layout.aggregate`) and nothing else produces it.
 *
 * One call per producer, not one per widget: every KPI widget shares one
 * `evaluateAll`, every signal chart one bucketed read, and so on.
 */
@Injectable()
export class PageService {
  private readonly reader = new TelemetryWindowReader();

  constructor(
    private readonly ds: DataSource,
    private readonly kpis: KpiEvaluatorService,
    private readonly bindings: SignalBindingService,
    private readonly alerts: AlertService,
    private readonly workOrders: WorkOrderService,
    private readonly service: ServiceForecastService,
    private readonly clientCatalog: ClientCatalogService,
  ) {}

  // ================================================================ machine page

  async machinePage(scope: RequestScope, ref: EquipmentRef, at: Date = new Date()): Promise<MachinePage> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    const profile = await withTenantSession(this.ds, scope, (m) => m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
    }));
    if (!profile) throw new NotFoundException('No such equipment in this account.');

    const { fallback, widgets: layout } = await this.machineLayout(scope, profile);
    const visible = layout.filter((w) => !w.hidden).sort((a, b) => a.position - b.position);
    const has = (...types: WidgetType[]) => visible.some((w) => types.includes(w.widgetType as WidgetType));
    const classSlug = profile.equipmentClassSlug;

    // One call per producer, each only if some widget needs it.
    const [envelopes, formulas, chartData, coverage, openAlerts, openWork, forecast, modes, recommendations] =
      await Promise.all([
        has('kpi_number', 'kpi_gauge', 'kpi_chart') ? this.kpis.evaluateAll(scope, ref, at) : Promise.resolve(null),
        has('kpi_number', 'kpi_gauge', 'kpi_chart') && classSlug ? this.clientFormulas(scope, classSlug) : Promise.resolve([]),
        has('signal_chart') ? this.signalCharts(scope, ref, classSlug, visible, at) : Promise.resolve(null),
        has('readiness_list') && classSlug ? this.bindings.coverage(scope, ref, at) : Promise.resolve(null),
        has('alert_list', 'failure_modes') ? this.openAlerts(scope, [ref]) : Promise.resolve(null),
        has('work_order_list') ? this.openWorkOrders(scope, [ref]) : Promise.resolve(null),
        has('service_due') ? this.service.fleetForecast(scope, at) : Promise.resolve(null),
        has('failure_modes') && classSlug ? this.clientRows(scope, ClientEquipmentClassFailureMode, classSlug) : Promise.resolve([]),
        has('recommendations') && classSlug ? this.clientRows(scope, ClientEquipmentClassRecommendation, classSlug) : Promise.resolve([]),
      ]);

    const envelopeByKey = new Map<string, KpiEnvelope>((envelopes ?? []).map((e) => [e.formulaKey, e]));
    const formulaByKey = new Map<string, ClientFormula>((formulas as ClientFormula[]).map((f) => [f.formulaKey, f]));

    const widgets = visible.map((w): PageWidget => {
      const h = header(w);
      switch (w.widgetType as WidgetType) {
        case 'kpi_number': case 'kpi_gauge': case 'kpi_chart':
          return this.kpiWidget(h, w.boundTo, envelopeByKey, formulaByKey, classSlug);

        case 'signal_chart': {
          const chart = chartData?.get(w.boundTo ?? '');
          if (!chart) return unfilled(h, 'not_configured', 'unbound');
          return chart.ok ? filled(h, chart.data) : unfilled(h, chart.readiness, chart.reason);
        }

        case 'readiness_list': {
          if (!classSlug) return unfilled(h, 'not_configured', 'unclassified');
          const rows = readinessRows(coverage!, at);
          return rows.length ? filled(h, rows) : unfilled(h, 'not_configured', 'no_requirements');
        }

        case 'alert_list':
          return filled(h, openAlerts!.rows);

        case 'work_order_list':
          return filled(h, openWork!);

        case 'service_due': {
          const asset = forecast!.assets.find((a) => a.sourceSystem === ref.sourceSystem && a.externalId === ref.externalId);
          if (!asset) return unfilled(h, 'not_available', 'not_forecast');
          if (!asset.dueAt) return unfilled(h, 'not_available', asset.missing[0] ?? 'not_forecast');
          return filled(h, {
            nextDueAt: asset.dueAt.toISOString(), hoursRemaining: asset.hoursRemaining, basis: asset.intervalSource,
          });
        }

        case 'failure_modes': {
          if (!classSlug) return unfilled(h, 'not_configured', 'unclassified');
          const rows: FailureModeRow[] = (modes as ClientEquipmentClassFailureMode[]).map((f) => ({
            code: f.code, name: f.name, symptom: f.symptom, severity: f.severity, signals: f.signals,
            status: failureModeStatus(f.signals, openAlerts!.signals),
          }));
          return filled(h, rows);
        }

        case 'recommendations': {
          if (!classSlug) return unfilled(h, 'not_configured', 'unclassified');
          return filled(h, (recommendations as ClientEquipmentClassRecommendation[]).map((r) => ({
            failureModeCode: r.failureModeCode, action: r.action, urgency: r.urgency, estimatedHours: r.estimatedHours,
          })));
        }

        case 'schematic':
          // QREC0c supplies the asset; until then the slot says so.
          return unfilled(h, 'not_available', 'no_visual');

        case 'machine_list':
        default:
          return unfilled(h, 'not_available', 'not_on_this_page');
      }
    });

    return {
      equipment: {
        sourceSystem: profile.sourceSystem, externalId: profile.externalId, name: profile.name,
        classSlug, classVersion: profile.classVersion, plantId: profile.plantId,
      },
      layout: { fallback },
      widgets,
    };
  }

  /** The tenant's own copy — hidden flags and order included — or QREC0b's computed
   * fallback. An unclassified machine gets the fallback over no formulas: a
   * readiness list that says why it cannot be filled. */
  private async machineLayout(scope: RequestScope, profile: EquipmentProfile) {
    if (profile.equipmentClassSlug) {
      try {
        return await this.clientCatalog.layout(scope, profile.equipmentClassSlug);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
    }
    return { fallback: true, widgets: fallbackLayout([]).map((w) => ({ ...w, hidden: false, positionCustom: false })) };
  }

  private kpiWidget(
    h: Header, boundTo: string | null, envelopes: Map<string, KpiEnvelope>,
    formulas: Map<string, ClientFormula>, classSlug: string | null,
  ): PageWidget {
    if (!classSlug) return unfilled(h, 'not_configured', 'unclassified');
    const env = boundTo ? envelopes.get(boundTo) : undefined;
    // Bound to a key this account's copy does not hold — the tenant's class copy
    // predates the formula, or it was removed. A state, not a guess.
    if (!env) return unfilled(h, 'not_configured', 'formula_not_in_account');
    if (env.readiness !== 'ready') return unfilled(h, env.readiness, env.reason ?? 'not_ready');
    const f = formulas.get(env.formulaKey);
    const data: KpiWidgetData = {
      ...env,
      target: f?.targetValue ?? null, targetMin: f?.targetMin ?? null, targetMax: f?.targetMax ?? null,
      targetDirection: f?.targetDirection ?? 'none',
    };
    return filled(h, data);
  }

  /** Every signal chart on the page in one bucketed read (QCE2.1's reader), drawn on
   * the same bucket ladder the evaluator uses: an empty bucket is `v: null`, never
   * omitted and never 0. The bucket's own `avg` is the value — the reader computes
   * all seven aggregates and the caller picks one. */
  private async signalCharts(
    scope: RequestScope, ref: EquipmentRef, classSlug: string | null, widgets: LayoutWidget[], at: Date,
  ) {
    const signals = [...new Set(widgets.filter((w) => w.widgetType === 'signal_chart' && w.boundTo).map((w) => w.boundTo!))];
    const result = new Map<string, { ok: true; data: { signal: string; unit: string | null; points: { t: string; v: number | null }[] } }
      | { ok: false; readiness: Exclude<PageReadiness, 'ready'>; reason: string }>();
    if (!signals.length) return result;

    return withTenantSession(this.ds, scope, async (m) => {
      const devices = await m.getRepository(DeviceProjection).find({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, equipmentExternalId: ref.externalId },
      });
      const imeis = [...new Set(devices.map((d) => d.imei))];
      if (!imeis.length) {
        for (const s of signals) result.set(s, { ok: false, readiness: 'not_configured', reason: 'no_device' });
        return result;
      }
      const units = new Map<string, string | null>();
      if (classSlug) {
        const cls = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId: scope.tenantId, slug: classSlug } });
        for (const s of cls?.expectedSignals ?? []) units.set(s.signal, s.unit);
      }
      const from = new Date(at.getTime() - SIGNAL_CHART_WINDOW_MS);
      const bucketSeconds = pickBucketSeconds(SIGNAL_CHART_WINDOW_MS / 1000);
      const bucketed = await this.reader.readBucketed(m, scope.tenantId, imeis, signals, bucketSeconds, from, at);

      for (const signal of signals) {
        const rows = bucketed.get(signal) ?? [];
        if (!rows.length) {
          result.set(signal, { ok: false, readiness: 'not_available', reason: 'no_readings' });
          continue;
        }
        const byBucket = new Map(rows.map((r) => [r.bucket.getTime(), r.avg]));
        const points: { t: string; v: number | null }[] = [];
        const start = Math.floor(from.getTime() / 1000 / bucketSeconds) * bucketSeconds;
        for (let epoch = start; epoch <= at.getTime() / 1000; epoch += bucketSeconds) {
          points.push({ t: new Date(epoch * 1000).toISOString(), v: byBucket.get(epoch * 1000) ?? null });
        }
        result.set(signal, { ok: true, data: { signal, unit: units.get(signal) ?? null, points } });
      }
      return result;
    });
  }

  /** Open alerts for a set of machines, in one call, with each one's signal read
   * through the rule that raised it — `alert_event` carries no signal of its own. */
  private async openAlerts(scope: RequestScope, refs: EquipmentRef[]) {
    const keys = new Set(refs.map((r) => `${r.sourceSystem}/${r.externalId}`));
    const events = (await this.alerts.listEvents(scope, {
      state: OPEN_ALERT_STATES, ...(refs.length === 1 ? { externalId: refs[0].externalId } : {}),
    })).filter((e) => keys.has(`${e.sourceSystem}/${e.externalId}`));

    const ruleIds = [...new Set(events.map((e) => e.ruleId))];
    const rules = ruleIds.length
      ? await withTenantSession(this.ds, scope, (m) => m.getRepository(AlertRule).find({ where: { tenantId: scope.tenantId, id: In(ruleIds) } }))
      : [];
    const signalOfRule = new Map(rules.map((r) => [r.id, ruleSignal(r)]));

    const rows: AlertRow[] = events.map((e) => ({
      id: e.id, severity: e.severity, raisedAt: e.firedAt.toISOString(),
      signal: signalOfRule.get(e.ruleId) ?? null, message: e.summary, acknowledged: e.state === 'acknowledged',
    }));
    // Per machine, what its open alerts say about signals: a named signal, or `null`
    // where the rule names none (a chain, fuel-loss or prediction alert) — the
    // difference between "clear" and "cannot tell" for a failure mode.
    const signals = new Map<string, (string | null)[]>();
    for (const e of events) {
      const key = `${e.sourceSystem}/${e.externalId}`;
      const list = signals.get(key) ?? [];
      list.push(signalOfRule.has(e.ruleId) ? signalOfRule.get(e.ruleId)! : null);
      signals.set(key, list);
    }
    const countByMachine = new Map<string, number>();
    for (const e of events) {
      const key = `${e.sourceSystem}/${e.externalId}`;
      countByMachine.set(key, (countByMachine.get(key) ?? 0) + 1);
    }
    return { rows, signals: refs.length === 1 ? signals.get([...keys][0]) ?? [] : [], signalsByMachine: signals, countByMachine };
  }

  private async openWorkOrders(scope: RequestScope, refs: EquipmentRef[]) {
    const keys = new Set(refs.map((r) => `${r.sourceSystem}/${r.externalId}`));
    const orders = await this.workOrders.list(scope, {
      status: OPEN_WORK_STATES, ...(refs.length === 1 ? { externalId: refs[0].externalId } : {}),
    });
    return orders.filter((o) => keys.has(`${o.sourceSystem}/${o.externalId}`)).map((o) => ({
      id: o.id, status: o.status, title: o.title, assignedTo: o.assignedToUserId, dueAt: o.dueAt?.toISOString() ?? null,
    }));
  }

  private clientFormulas(scope: RequestScope, classSlug: string) {
    return withTenantSession(this.ds, scope, (m) => m.getRepository(ClientFormula).find({
      where: { tenantId: scope.tenantId, clientEquipmentClassSlug: classSlug, status: 'active' },
    }));
  }

  private clientRows<T extends ClientEquipmentClassFailureMode | ClientEquipmentClassRecommendation>(
    scope: RequestScope, entity: new () => T, classSlug: string,
  ): Promise<T[]> {
    return withTenantSession(this.ds, scope, (m) => m.getRepository(entity).find({
      where: { tenantId: scope.tenantId, clientEquipmentClassSlug: classSlug } as never,
    }));
  }

  // =================================================================== site page

  async sitePage(scope: RequestScope, plantId: string, at: Date = new Date()): Promise<SitePage> {
    if (scope.plantIds !== undefined && !scope.plantIds.includes(plantId)) {
      throw new NotFoundException('No such site in this account.');
    }
    const { plant, machines } = await withTenantSession(this.ds, scope, async (m) => {
      const found = await m.getRepository(Plant).findOne({ where: { tenantId: scope.tenantId, id: plantId } });
      if (!found) throw new NotFoundException('No such site in this account.');
      const all = await m.getRepository(EquipmentProfile).find({ where: { tenantId: scope.tenantId, plantId } });
      const visible = scope.equipmentIds === undefined ? all : all.filter((e) => scope.equipmentIds!.includes(e.externalId));
      return { plant: found, machines: visible };
    });
    const site: SiteClass = await resolveSiteClass(this.ds.manager, plant);
    const layout = (await siteLayout(this.ds.manager, site)).sort((a, b) => a.position - b.position);
    const refs: EquipmentRef[] = machines.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId }));
    const has = (...types: WidgetType[]) => layout.some((w) => types.includes(w.widgetType as WidgetType));

    const [alerts, work, worst, siteKpis] = await Promise.all([
      has('alert_list', 'machine_list') && refs.length ? this.openAlerts(scope, refs) : Promise.resolve(null),
      has('work_order_list') && refs.length ? this.openWorkOrders(scope, refs) : Promise.resolve([]),
      // Each machine's worst signal readiness — its coverage, not its KPIs. A site page
      // that evaluates every KPI of every machine is the shape that makes it unusable.
      has('machine_list') ? Promise.all(machines.map((e) => this.machineReadiness(scope, e, at))) : Promise.resolve([]),
      this.siteKpiEnvelopes(scope, machines, layout, at),
    ]);

    const widgets = layout.map((w): PageWidget => {
      const h = header(w);
      switch (w.widgetType as WidgetType) {
        case 'machine_list': {
          const rows: MachineRow[] = machines.map((e, i) => ({
            sourceSystem: e.sourceSystem, externalId: e.externalId, name: e.name, readiness: worst[i],
            openAlerts: alerts?.countByMachine.get(`${e.sourceSystem}/${e.externalId}`) ?? 0,
          }));
          return filled(h, rows);
        }
        case 'alert_list':
          return filled(h, alerts?.rows ?? []);
        case 'work_order_list':
          return filled(h, work);
        case 'kpi_number': case 'kpi_gauge': case 'kpi_chart':
          return siteKpiWidget(h, w, siteKpis.get(w.boundTo ?? '') ?? []);
        default:
          return unfilled(h, 'not_available', 'not_on_this_page');
      }
    });

    return {
      site: { plantId: plant.id, code: plant.code, name: plant.name, siteClass: { slug: site.slug, version: site.version } },
      layout: { fallback: false },
      widgets,
    };
  }

  private async machineReadiness(scope: RequestScope, e: EquipmentProfile, at: Date): Promise<PageReadiness> {
    if (!e.equipmentClassSlug) return 'not_configured';
    const coverage = await this.bindings.coverage(scope, { sourceSystem: e.sourceSystem, externalId: e.externalId }, at);
    const rows = readinessRows(coverage, at);
    if (!rows.length) return 'not_configured';
    return rows.reduce<PageReadiness>((acc, r) => (READINESS_SEVERITY[r.readiness] > READINESS_SEVERITY[acc] ? r.readiness : acc), 'ready');
  }

  /** For each bound site KPI, each machine's own envelope for that key — `evaluateOne`
   * per (machine, key), so a site page never evaluates KPIs no widget shows. A
   * machine whose class does not declare the key is `not_declared`, normal in a
   * mixed fleet, not an error. */
  private async siteKpiEnvelopes(
    scope: RequestScope, machines: EquipmentProfile[], layout: SiteLayoutWidget[], at: Date,
  ): Promise<Map<string, ({ machine: EquipmentProfile; env: KpiEnvelope | null })[]>> {
    const keys = [...new Set(layout.filter((w) => KPI_TYPES.has(w.widgetType as WidgetType) && w.boundTo).map((w) => w.boundTo!))];
    const result = new Map<string, ({ machine: EquipmentProfile; env: KpiEnvelope | null })[]>();
    for (const key of keys) {
      result.set(key, await Promise.all(machines.map(async (machine) => {
        if (!machine.equipmentClassSlug) return { machine, env: null };
        try {
          const env = await this.kpis.evaluateOne(scope, { sourceSystem: machine.sourceSystem, externalId: machine.externalId }, key, at);
          return { machine, env };
        } catch (err) {
          if (err instanceof NotFoundException) return { machine, env: null };
          throw err;
        }
      })));
    }
    return result;
  }
}

/** The signal the rule that raised an alert watches, where its trigger names one. */
function ruleSignal(rule: AlertRule): string | null {
  const signal = (rule.params as { signal?: unknown } | null)?.signal;
  return typeof signal === 'string' && signal ? signal : null;
}

/**
 * Derived, never stored (task QPAGE1 §4): `active` when an open alert's rule watches
 * one of the mode's signals; `clear` only when every open alert on the machine can be
 * traced to a signal and none is the mode's; `unknown` when any open alert came from
 * a rule that names no signal — that alert might be this failure, and "clear" would
 * be a guess.
 */
export function failureModeStatus(modeSignals: string[], openAlertSignals: (string | null)[]): FailureModeStatus {
  if (openAlertSignals.some((s) => s !== null && modeSignals.includes(s))) return 'active';
  if (openAlertSignals.some((s) => s === null)) return 'unknown';
  return 'clear';
}

function readinessRows(coverage: Awaited<ReturnType<SignalBindingService['coverage']>>, at: Date): ReadinessRow[] {
  const row = (r: { measurementRole: string; componentScope: string; lastReadingAt: string | null;
    secondsSinceLastReading: number | null; staleAfterSeconds: number }, bound: boolean): ReadinessRow => {
    const freshness = classifyFreshness(r.lastReadingAt ? new Date(r.lastReadingAt) : null, at, r.staleAfterSeconds);
    const { readiness, reason } = signalReadiness(bound, freshness);
    return {
      signal: r.measurementRole, componentScope: r.componentScope, readiness, reason,
      lastReadingAt: r.lastReadingAt, secondsSinceLastReading: r.secondsSinceLastReading,
    };
  };
  return [...coverage.covered.map((r) => row(r, true)), ...coverage.missing.map((r) => row(r, false))];
}

function siteKpiWidget(
  h: Header, w: SiteLayoutWidget, perMachine: { machine: EquipmentProfile; env: KpiEnvelope | null }[],
): PageWidget {
  const notDeclared = perMachine.filter((p) => !p.env).length;
  const declared = perMachine.filter((p) => p.env) as { machine: EquipmentProfile; env: KpiEnvelope }[];
  const ready = declared.filter((p) => p.env.readiness === 'ready');
  const notReady = declared.length - ready.length;

  if (!ready.length) return unfilled(h, 'not_available', 'no_ready_machines');
  if (ready.some((p) => p.env.resultKind !== 'scalar' || typeof p.env.value !== 'number')) {
    // A site aggregate of a series has no declared meaning (bucket by bucket? over
    // which window alignment?) and the task does not define one.
    return unfilled(h, 'not_available', 'series_not_aggregated');
  }
  // Mixed units are refused, never converted: the platform has no conversion, and
  // QCE3 settled that a dimension is its unit.
  const byUnit = new Map<string, string>();
  for (const p of ready) if (!byUnit.has(p.env.unit)) byUnit.set(p.env.unit, `${p.machine.sourceSystem}/${p.machine.externalId}`);
  if (byUnit.size > 1) {
    return unfilled(h, 'blocked', `unit_conflict: ${[...byUnit].map(([unit, machine]) => `"${unit}" (${machine})`).join(' vs ')}`);
  }

  const values = ready.map((p) => p.env.value as number);
  const value = w.aggregate === 'sum' ? values.reduce((a, b) => a + b, 0)
    : w.aggregate === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length
      : w.aggregate === 'min' ? Math.min(...values)
        : w.aggregate === 'max' ? Math.max(...values)
          : values.length;
  const data: SiteKpiData = {
    value, unit: w.aggregate === 'count' ? null : [...byUnit.keys()][0], aggregate: w.aggregate!,
    machinesIncluded: ready.length, machinesExcluded: notDeclared + notReady,
    excluded: { notDeclared, notReady },
  };
  return filled(h, data);
}
