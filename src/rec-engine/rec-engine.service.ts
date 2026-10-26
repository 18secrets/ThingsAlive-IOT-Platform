import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { Severity } from '../common/severity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { Incident } from '../incident/entities/incident.entity';
import { ruleSignal } from '../page/page.service';
import { FailureModeStatus } from '../page/page-widgets';
import { chainForEquipment, resolveParameters, ResolvedParameter } from '../parameters/services/parameter-resolution';
import { withTenantSession } from '../scope/tenant-session';
import { EquipmentServiceRecord } from '../service/entities/equipment-service-record.entity';
import { WorkOrder } from '../work/entities/work-order.entity';
import { ForecastReader, ResidualVerdict } from '../forecast/forecast-reader';
import { compareModes, failureModeStatus, URGENCY_ORDER } from './attribute';
import { observeSignals, SignalObservation } from './observe';
import { BundleOutcome, BundleReason, BundleStatus, RecEvidenceBundle } from './rec-evidence-bundle.entity';

/** Bumped whenever any step's logic changes: the same inputs under new logic are new evidence. */
export const ENGINE_VERSION = 'rec-engine@2';

const OPEN_ALERT = ['open', 'acknowledged'];
const OPEN_WORK = ['created', 'in-progress'];

type DetectState = 'anomalous' | 'normal' | 'baseline_not_established' | 'not_observed';

export interface DetectEntry {
  signal: string;
  state: DetectState;
  sources: (
    | { kind: 'alert'; ref: string; trigger: string; alertState: string }
    | { kind: 'residual'; readiness: 'not_available'; reason: string }
    | {
      kind: 'residual'; readiness: 'ready'; state: 'normal' | 'anomalous';
      at: string; actual: number; predicted: number; residual: number; band: { lo: number; hi: number };
    }
  )[];
  readiness: 'ready' | 'not_available' | 'not_configured';
  reason: string | null;
  lastReadingAt: string | null;
}

export interface Evaluation {
  bundle: RecEvidenceBundle;
  /** False when unchanged inputs found the bundle an earlier request wrote. */
  created: boolean;
}

/**
 * The five deterministic steps of the recommendation engine (task QREC1, D21): detect,
 * attribute, precedent, gap, cost. Frame is QREC2's.
 *
 * Every step is a lookup, a set operation, a query or arithmetic — no model, no
 * probability, no learned weight (G07) — and every step says what it searched and what
 * it could not see, because the most convincing wrong answer this engine could give is
 * "nothing found" about a machine it could not look at.
 *
 * Evaluation is one tenant transaction, so every step reads the same moment. The
 * result is written once per distinct evidence: `inputs_hash` covers what was read,
 * not when, so a page refreshed over unchanged data finds the bundle it already has.
 */
@Injectable()
export class RecEngineService {
  constructor(private readonly ds: DataSource, private readonly forecasts: ForecastReader) {}

  async evaluate(
    scope: RequestScope, ref: { sourceSystem: string; externalId: string }, at = new Date(),
  ): Promise<Evaluation> {
    this.requireVisible(scope, ref.externalId);
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      });
      if (!profile) throw new NotFoundException('No such equipment in this account.');
      const draft = await this.compute(m, scope.tenantId, profile, at);
      return this.persist(m, scope.tenantId, profile, at, draft);
    });
  }

  async latest(scope: RequestScope, ref: { sourceSystem: string; externalId: string }): Promise<RecEvidenceBundle> {
    this.requireVisible(scope, ref.externalId);
    const bundle = await withTenantSession(this.ds, scope, (m) => m.getRepository(RecEvidenceBundle).findOne({
      where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      order: { createdAt: 'DESC', id: 'DESC' },
    }));
    if (!bundle) throw new NotFoundException('This machine has not been evaluated yet.');
    return bundle;
  }

  async byId(scope: RequestScope, id: string): Promise<RecEvidenceBundle> {
    const bundle = await withTenantSession(this.ds, scope, (m) =>
      m.getRepository(RecEvidenceBundle).findOne({ where: { tenantId: scope.tenantId, id } }));
    // Out of scope answers exactly like absent: the same 404 any equipment route gives.
    if (!bundle || (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(bundle.externalId))) {
      throw new NotFoundException('No such evidence bundle in this account.');
    }
    return bundle;
  }

  /** The narrowing `AlertService.listEvents` applies: undefined is the whole account, [] is nothing. */
  private requireVisible(scope: RequestScope, externalId: string): void {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
  }

  // ------------------------------------------------------------------------ steps

  /**
   * The five steps as of a past moment, held in memory and never written (QEVAL1c's
   * replay). The same `compute` the live path runs, with the machine's history cut to
   * what had happened by `at` and each alert and work order put back in the state it was
   * in then — otherwise a replay of last month would see this morning's resolutions and
   * call last month's alerts closed. What cannot be put back is listed on the class,
   * not hidden: the library, the alert rules and the bindings are read as they are now.
   *
   * The bundle it returns has an id derived from what it holds, as `persist` derives
   * cost ids, so replaying the same moment twice gives the same bundle.
   */
  async computeAsOf(m: EntityManager, tenantId: string, profile: EquipmentProfile, at: Date): Promise<RecEvidenceBundle> {
    const d = await this.compute(m, tenantId, profile, at, true);
    const row = assemble(tenantId, profile, at, d);
    return Object.assign(new RecEvidenceBundle(), {
      ...row, id: deterministicUuid(`replay|${row.inputsHash}|${at.toISOString()}`), createdAt: at,
    });
  }

  private async compute(m: EntityManager, tenantId: string, profile: EquipmentProfile, at: Date, asOf = false) {
    const machine = { tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId };

    // History is read whatever the class says: "no history to search" is true or false
    // of the machine, not of its library.
    let events = await m.getRepository(AlertEvent).find({ where: machine, order: { firedAt: 'ASC', id: 'ASC' } });
    const rules = events.length
      ? await m.getRepository(AlertRule).find({ where: { tenantId, id: In([...new Set(events.map((e) => e.ruleId))]) } })
      : [];
    const ruleById = new Map(rules.map((r) => [r.id, r]));
    const signalOf = (e: AlertEvent) => { const r = ruleById.get(e.ruleId); return r ? ruleSignal(r) : null; };
    const triggerOf = (e: AlertEvent) => ruleById.get(e.ruleId)?.trigger ?? 'unknown';
    let workOrders = await m.getRepository(WorkOrder).find({ where: machine, order: { createdAt: 'ASC', id: 'ASC' } });
    let services = await m.getRepository(EquipmentServiceRecord).find({ where: machine, order: { performedAt: 'ASC', id: 'ASC' } });
    let live: Incident | null;
    if (asOf) {
      events = events.filter((e) => e.firedAt <= at).map((e) => Object.assign(new AlertEvent(), e, { state: alertStateAt(e, at) }));
      workOrders = workOrders.filter((w) => w.createdAt <= at).map((w) => Object.assign(new WorkOrder(), w, { status: workOrderStatusAt(w, at) }));
      // Known by then, not merely performed by then: a record entered later was not evidence at `at`.
      services = services.filter((r) => r.performedAt <= at && r.recordedAt <= at);
      live = (await m.getRepository(Incident).find({ where: machine, order: { openedAt: 'DESC' } }))
        .find((i) => i.openedAt <= at && (i.resolvedAt === null || i.resolvedAt > at)) ?? null;
    } else {
      live = await m.getRepository(Incident).findOne({ where: { ...machine, status: Not('resolved') } });
    }

    const base = {
      incidentId: live?.id ?? null, classSlug: profile.equipmentClassSlug, classTemplateVersion: null as number | null,
      history: { events, workOrders, services },
    };

    const refuse = (reason: BundleReason) => ({
      ...base, status: 'not_configured' as BundleStatus, reason, outcome: null as BundleOutcome | null,
      detect: { entries: [], coverage: { expected: [], observed: [], notObserved: [], sources: {} }, unattributableAlerts: [] },
      attribute: { modes: [], unattributed: [], order: ORDER_NOTE },
      precedent: { modes: [], method: PRECEDENT_METHOD, coverage: historyCoverage(base.history, at) },
      gap: { noLibraryRecommendation: [], alreadyInHand: [], unobserved: [] },
      cost: { lines: [], missingParameters: [] }, candidates: [] as unknown[],
      hashParts: {} as Record<string, unknown>,
    });

    if (!profile.equipmentClassSlug) return refuse('unclassified');
    const clientClass = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId, slug: profile.equipmentClassSlug } });
    if (!clientClass) return refuse('class_not_in_account');
    base.classTemplateVersion = clientClass.templateVersion;
    const modes = await m.getRepository(ClientEquipmentClassFailureMode).find({
      where: { tenantId, clientEquipmentClassSlug: profile.equipmentClassSlug }, order: { code: 'ASC' },
    });
    if (!modes.length) return refuse('no_library_content');
    const recs = await m.getRepository(ClientEquipmentClassRecommendation).find({
      where: { tenantId, clientEquipmentClassSlug: profile.equipmentClassSlug }, order: { id: 'ASC' },
    });

    // -- Detect ---------------------------------------------------------------------
    const named = [...new Set(modes.flatMap((f) => f.signals))].sort();
    const observed = await observeSignals(m, tenantId, profile, named, at);
    const forecastDeclared = profile.classVersion
      ? new Set((await m.getRepository(EquipmentClassSensorRequirement).find({
        where: { classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion, forecastEnabled: true },
      })).map((r) => r.measurementRole))
      : new Set<string>();
    // The forecast band's verdict per declared signal (D20, D21: Detect is thresholds
    // and TTM residual). Steady running hours only, so the morning start and the night
    // are not faults (forecast-band.ts, runStartHours).
    const verdicts = await this.forecasts.residualVerdicts(m, tenantId, profile, [...forecastDeclared].filter((s) => named.includes(s)), at);
    const open = events.filter((e) => OPEN_ALERT.includes(e.state));
    const silent = open.filter((e) => triggerOf(e) === 'no-telemetry');
    const entries: DetectEntry[] = named.map((signal) =>
      detectEntry(signal, open.filter((e) => signalOf(e) === signal && triggerOf(e) !== 'no-telemetry'),
        silent, observed.get(signal), forecastDeclared.has(signal), verdicts.get(signal), triggerOf));
    const stateOf = new Map(entries.map((e) => [e.signal, e.state]));
    const unobserved = entries.filter((e) => e.state === 'not_observed' || e.state === 'baseline_not_established').map((e) => e.signal);
    const detect = {
      entries,
      coverage: {
        expected: named,
        observed: entries.filter((e) => e.state === 'anomalous' || e.state === 'normal').map((e) => e.signal),
        notObserved: entries.filter((e) => e.state === 'not_observed').map((e) => ({ signal: e.signal, reason: e.reason })),
        sources: {
          alerts: 'available',
          residual: !forecastDeclared.size ? 'not_declared'
            : [...verdicts.values()].some((v) => v.readiness === 'ready') ? 'available' : 'not_available',
        },
      },
      unattributableAlerts: open.filter((e) => signalOf(e) === null)
        .map((e) => ({ ref: `alert_event:${e.id}`, trigger: triggerOf(e) })),
    };

    // -- Attribute ------------------------------------------------------------------
    // A band breach points at a mode exactly as an open alert on the signal does.
    const openSignals = [
      ...open.map((e) => signalOf(e)),
      ...entries.filter((e) => e.sources.some((x) => x.kind === 'residual' && 'state' in x && x.state === 'anomalous')
        && e.state === 'anomalous').map((e) => e.signal),
    ];
    const attributed = modes.map((f) => ({
      failureModeCode: f.code, name: f.name, severity: f.severity as Severity | null, orphaned: f.orphanedAt !== null,
      matchedSignals: f.signals.filter((s) => stateOf.get(s) === 'anomalous').sort(),
      unobservedSignals: f.signals.filter((s) => unobserved.includes(s)).sort(),
      status: failureModeStatus(f.signals, openSignals, unobserved) as FailureModeStatus,
    })).sort(compareModes);
    const namedSet = new Set(named);
    const unattributedSignals = [...new Set(open
      .filter((e) => triggerOf(e) !== 'no-telemetry' && signalOf(e) !== null && !namedSet.has(signalOf(e)!))
      .map((e) => signalOf(e)!))].sort();
    const attribute = {
      modes: attributed,
      unattributed: unattributedSignals.map((signal) => ({
        signal, refs: open.filter((e) => signalOf(e) === signal).map((e) => `alert_event:${e.id}`),
      })),
      order: ORDER_NOTE,
    };
    const active = attributed.filter((a) => a.status === 'active');

    // -- Precedent ------------------------------------------------------------------
    const precedentModes = attributed.map((a) => {
      const signals = modes.find((f) => f.code === a.failureModeCode)!.signals;
      const alerts = events.filter((e) => { const s = signalOf(e); return s !== null && signals.includes(s); });
      const alertIds = new Set(alerts.map((e) => e.id));
      const orders = workOrders.filter((w) => w.alertId !== null && alertIds.has(w.alertId));
      const orderIds = new Set(orders.map((w) => w.id));
      const records = services.filter((r) => r.workOrderId !== null && orderIds.has(r.workOrderId));
      const anyHistory = events.length + workOrders.length + services.length > 0;
      return {
        failureModeCode: a.failureModeCode,
        state: !anyHistory ? 'no_history' : alerts.length + orders.length + records.length > 0 ? 'found' : 'none_found',
        alertEvents: alerts.map((e) => ({ id: e.id, firedAt: e.firedAt.toISOString(), state: e.state, current: OPEN_ALERT.includes(e.state) })),
        workOrders: orders.map((w) => ({
          id: w.id, status: w.status,
          // Observed, never substituted for the library's estimate (§4): they answer different questions.
          observedHours: w.status === 'completed' && w.startedAt && w.endedAt
            ? round2((w.endedAt.getTime() - w.startedAt.getTime()) / 3_600_000) : null,
        })),
        serviceRecords: records.map((r) => ({ id: r.id, kind: r.kind, performedAt: r.performedAt.toISOString() })),
      };
    });
    const precedent = { modes: precedentModes, method: PRECEDENT_METHOD, coverage: historyCoverage(base.history, at) };

    // -- Candidates and gap ---------------------------------------------------------
    const urgencyRank = (u: string) => URGENCY_ORDER.indexOf(u as (typeof URGENCY_ORDER)[number]);
    const inHandFor = (code: string) => {
      const signals = modes.find((f) => f.code === code)!.signals;
      const ids = new Set(events.filter((e) => { const s = signalOf(e); return s !== null && signals.includes(s); }).map((e) => e.id));
      return workOrders.filter((w) => OPEN_WORK.includes(w.status) && w.alertId !== null && ids.has(w.alertId)).map((w) => w.id);
    };
    const candidates = active.flatMap((a) => recs
      .filter((r) => r.failureModeCode === a.failureModeCode)
      .sort((x, y) => urgencyRank(x.urgency) - urgencyRank(y.urgency) || (x.action < y.action ? -1 : x.action > y.action ? 1 : 0))
      .map((r) => {
        const inHand = inHandFor(a.failureModeCode);
        return {
          recommendationId: r.id, failureModeCode: r.failureModeCode, action: r.action, urgency: r.urgency,
          estimatedHours: r.estimatedHours, requiredParts: r.requiredParts ?? [], orphaned: r.orphanedAt !== null,
          inHand: inHand.length > 0, inHandWorkOrderIds: inHand,
        };
      }));
    const gap = {
      noLibraryRecommendation: active.filter((a) => !recs.some((r) => r.failureModeCode === a.failureModeCode))
        .map((a) => a.failureModeCode),
      alreadyInHand: candidates.filter((c) => c.inHand).map((c) => ({ recommendationId: c.recommendationId, workOrderIds: c.inHandWorkOrderIds })),
      unobserved: attributed.filter((a) => a.status !== 'clear' && a.unobservedSignals.length)
        .map((a) => ({ failureModeCode: a.failureModeCode, signals: a.unobservedSignals })),
    };

    // -- Cost -----------------------------------------------------------------------
    const params = await resolveParameters(m, tenantId, chainForEquipment(profile), ['labour_rate_per_hour', 'currency'], at);
    const costInput = { profile, at, rate: params.get('labour_rate_per_hour') ?? null, currency: params.get('currency') ?? null };

    // -- Readiness ------------------------------------------------------------------
    const anomalous = entries.some((e) => e.state === 'anomalous');
    const seen = entries.some((e) => e.state === 'anomalous' || e.state === 'normal');
    let status: BundleStatus = 'ready';
    let reason: BundleReason | null = null;
    let outcome: BundleOutcome | null = null;
    if (!seen && !anomalous) { status = 'blocked'; reason = 'insufficient_coverage'; }
    else if (active.length) outcome = 'attributed';
    else if (unattributedSignals.length) outcome = 'unattributed';
    else if (attributed.some((a) => a.status === 'unknown')) outcome = 'inconclusive';
    else outcome = 'nothing_detected';

    const hashParts = {
      modes: modes.map((f) => [f.id, f.updatedAt.toISOString()]),
      recommendations: recs.map((r) => [r.id, r.updatedAt.toISOString()]),
      detect: entries.map((e) => [e.signal, e.state, e.reason]),
      parameters: [...params.entries()].map(([n, p]) => [n, p ? [p.value, p.source] : null]),
    };
    return {
      ...base, status, reason, outcome, detect, attribute, precedent, gap, candidates, costInput, hashParts,
      cost: { lines: [] as unknown[], missingParameters: [] as string[] },
    };
  }

  private async persist(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, at: Date,
    d: Awaited<ReturnType<RecEngineService['compute']>>,
  ): Promise<Evaluation> {
    const { inputsHash, cost } = assemble(tenantId, profile, at, d);
    const rows: { id: string }[] = await m.query(
      `INSERT INTO "rec_evidence_bundle" ("tenant_id", "source_system", "external_id", "incident_id", "as_of",
         "engine_version", "class_slug", "class_template_version", "inputs_hash", "status", "reason", "outcome",
         "detect", "attribute", "precedent", "gap", "cost", "candidates")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "inputs_hash", "engine_version") DO NOTHING
       RETURNING "id"`,
      [tenantId, profile.sourceSystem, profile.externalId, d.incidentId, at, ENGINE_VERSION, d.classSlug,
        d.classTemplateVersion, inputsHash, d.status, d.reason, d.outcome,
        JSON.stringify(d.detect), JSON.stringify(d.attribute), JSON.stringify(d.precedent), JSON.stringify(d.gap),
        JSON.stringify(cost), JSON.stringify(d.candidates)],
    );
    const bundle = await m.getRepository(RecEvidenceBundle).findOneOrFail({
      where: { tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, inputsHash, engineVersion: ENGINE_VERSION },
    });
    return { bundle, created: rows.length > 0 };
  }
}

// ------------------------------------------------------------------------- helpers

type Computed = Awaited<ReturnType<RecEngineService['compute']>>;

/** The bundle's columns from the steps' output: what `persist` inserts and `computeAsOf` holds in memory. */
function assemble(tenantId: string, profile: EquipmentProfile, at: Date, d: Computed) {
  const { history } = d;
  const inputsHash = sha256(canonical({
    engine: ENGINE_VERSION,
    class: [d.classSlug, d.classTemplateVersion],
    incident: d.incidentId,
    alerts: history.events.map((e) => [e.id, e.state]),
    workOrders: history.workOrders.map((w) => [w.id, w.updatedAt.toISOString()]),
    services: history.services.map((s) => [s.id, s.recordedAt.toISOString()]),
    ...d.hashParts,
  }));

  let cost: { lines: unknown[]; missingParameters: string[] } = d.cost;
  if ('costInput' in d && d.costInput) {
    cost = costLines(d.candidates as Candidate[], d.costInput as CostInput, inputsHash);
  }
  return {
    tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, incidentId: d.incidentId, asOf: at,
    engineVersion: ENGINE_VERSION, classSlug: d.classSlug, classTemplateVersion: d.classTemplateVersion, inputsHash,
    status: d.status, reason: d.reason, outcome: d.outcome,
    detect: d.detect as Record<string, unknown>, attribute: d.attribute as Record<string, unknown>,
    precedent: d.precedent as Record<string, unknown>, gap: d.gap as Record<string, unknown>,
    cost: cost as Record<string, unknown>, candidates: d.candidates as unknown[],
  };
}

/** An alert's state at `at`, from the times it was acknowledged and resolved. */
function alertStateAt(e: AlertEvent, at: Date): string {
  if (e.resolvedAt && e.resolvedAt <= at) return 'resolved';
  if (e.acknowledgedAt && e.acknowledgedAt <= at) return 'acknowledged';
  return 'open';
}

/**
 * A work order's status at `at`, from its start and end times. A cancellation records no
 * time of its own, so a cancelled order counts as cancelled from its last update — the
 * one approximation in the replay's history, named in QEVAL1's report.
 */
function workOrderStatusAt(w: WorkOrder, at: Date): string {
  if (w.status === 'cancelled') return w.updatedAt <= at ? 'cancelled' : w.startedAt && w.startedAt <= at ? 'in-progress' : 'created';
  if (w.endedAt && w.endedAt <= at) return w.status;
  if (w.startedAt && w.startedAt <= at) return 'in-progress';
  return 'created';
}

const ORDER_NOTE = 'Sorted by status (active, unknown, clear), then matched signals (most first), then declared '
  + 'severity (worst first, undeclared last), then code. A sort, not a likelihood: no probability is stated.';

const PRECEDENT_METHOD = 'This machine only, all history this account holds for it. Alert events match when their '
  + 'rule watches one of the failure mode\'s signals; work orders through their alert_id; service records through '
  + 'their work_order_id. A work order raised by hand with no alert cannot be linked to a failure mode and is not '
  + 'counted here.';

function detectEntry(
  signal: string, alerts: AlertEvent[], silent: AlertEvent[], o: SignalObservation | undefined,
  forecast: boolean, verdict: ResidualVerdict | undefined, triggerOf: (e: AlertEvent) => string,
): DetectEntry {
  const sources: DetectEntry['sources'] = alerts.map((e) => ({
    kind: 'alert' as const, ref: `alert_event:${e.id}`, trigger: triggerOf(e), alertState: e.state,
  }));
  if (forecast) {
    sources.push(verdict?.readiness === 'ready'
      ? { kind: 'residual', ...verdict }
      : { kind: 'residual', readiness: 'not_available', reason: verdict?.reason ?? 'no_forecast_model' });
  }
  const readiness: DetectEntry['readiness'] = !o || !o.bound ? 'not_configured' : o.freshness === 'ready' ? 'ready' : 'not_available';
  const lastReadingAt = o?.lastReadingAt ?? null;

  // An open alert on the signal is evidence it was anomalous, whatever the sensor says now.
  if (alerts.length) return { signal, state: 'anomalous', sources, readiness, reason: null, lastReadingAt };
  // A silent shift is a coverage fact, not a fault (§2): the signal is unseen, not abnormal.
  if (silent.length) {
    for (const e of silent) sources.push({ kind: 'alert', ref: `alert_event:${e.id}`, trigger: 'no-telemetry', alertState: e.state });
    return { signal, state: 'not_observed', sources, readiness, reason: 'no_telemetry', lastReadingAt };
  }
  // A dead sensor with no alert is not a healthy sensor (G04).
  if (!o || !o.bound) return { signal, state: 'not_observed', sources, readiness, reason: 'unbound', lastReadingAt };
  if (o.freshness !== 'ready') return { signal, state: 'not_observed', sources, readiness, reason: o.freshness, lastReadingAt };
  // Past the forecast band on a live, bound sensor: anomalous with no alert, which is the
  // case a threshold misses — a fault that has not reached the alert line.
  if (verdict?.readiness === 'ready' && verdict.state === 'anomalous') {
    return { signal, state: 'anomalous', sources, readiness, reason: null, lastReadingAt };
  }
  return { signal, state: 'normal', sources, readiness, reason: null, lastReadingAt };
}

function historyCoverage(
  h: { events: AlertEvent[]; workOrders: WorkOrder[]; services: EquipmentServiceRecord[] }, at: Date,
) {
  const span = (dates: Date[]) => ({
    rows: dates.length,
    earliest: dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString() : null,
    latest: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null,
  });
  const sources = {
    alertEvents: span(h.events.map((e) => e.firedAt)),
    workOrders: span(h.workOrders.map((w) => w.createdAt)),
    serviceRecords: span(h.services.map((s) => s.performedAt)),
  };
  const earliest = [sources.alertEvents.earliest, sources.workOrders.earliest, sources.serviceRecords.earliest]
    .filter((x): x is string => x !== null).sort()[0] ?? null;
  // No lookback window is invented (question 7): the period is everything held.
  return { sources, period: { from: earliest, to: at.toISOString() } };
}

interface Candidate {
  recommendationId: string; failureModeCode: string; estimatedHours: number | null;
}

interface CostInput {
  profile: EquipmentProfile; at: Date; rate: ResolvedParameter | null; currency: ResolvedParameter | null;
}

/**
 * Each line a CalculationResultV1 (§6). Labour is the one line decided today; the
 * others are named and `pending`, so the response does not change shape when they
 * land. Never 0, never a placeholder, never a platform default (D31, D39): an unset
 * input is `blocked` with the input named.
 */
function costLines(candidates: Candidate[], c: CostInput, inputsHash: string) {
  const at = c.at.toISOString();
  const missing = [
    ...(c.rate && typeof c.rate.value === 'number' ? [] : ['labour_rate_per_hour']),
    ...(c.currency && typeof c.currency.value === 'string' ? [] : ['currency']),
  ];
  const paramRef = (p: ResolvedParameter) =>
    `tenant_parameter:${p.source.scope}:${p.source.scopeRef ?? 'client'}:${p.name}@${p.source.effectiveFrom}`;
  const common = (line: string, recId: string) => ({
    result_id: deterministicUuid(`${inputsHash}|${line}|${recId}`),
    equipment_id: c.profile.id,
    context: 'live' as const,
    window: { start: at, end: at },
    computed_at: at,
    source_as_of: null,
    failure_probability: null,
    estimate_kind: 'library_estimate',
  });

  const lines = candidates.flatMap((r) => {
    const recRef = `client_equipment_class_recommendation:${r.recommendationId}`;
    const labour = (() => {
      const base = { ...common('labour', r.recommendationId), definition_version: 'rec-cost.labour@1', method: 'estimated_hours x labour_rate_per_hour' };
      if (r.estimatedHours === null) {
        return { ...base, status: 'blocked', reasons: ['validation_required'], value: null, unit: null,
          parameter_set_version: null, evidence_refs: [recRef],
          limitations: [`recommendation ${r.recommendationId}: the library did not author an estimate (estimated_hours is null)`] };
      }
      const lim: string[] = [];
      if (missing.includes('labour_rate_per_hour')) lim.push('labour_rate_per_hour not set');
      if (missing.includes('currency')) lim.push('currency not set');
      if (lim.length) {
        return { ...base, status: 'blocked', reasons: ['parameters_required'], value: null, unit: null,
          parameter_set_version: null, evidence_refs: [recRef], limitations: lim };
      }
      return {
        ...base, status: 'ready', reasons: ['ready'], value: round2(r.estimatedHours * (c.rate!.value as number)),
        unit: c.currency!.value as string,
        parameter_set_version: `${c.rate!.source.scope}:${c.rate!.source.scopeRef ?? 'client'}@${c.rate!.source.effectiveFrom}`,
        evidence_refs: [recRef, paramRef(c.rate!), paramRef(c.currency!)],
        assumptions: ['estimated_hours is labour time, as the library authored it; it is not machine downtime'],
        limitations: [],
      };
    })();
    const pending = (line: string, why: string) => ({
      ...common(line, r.recommendationId), definition_version: `rec-cost.${line}@1`, status: 'pending',
      reasons: ['parameters_required'], value: null, unit: null, parameter_set_version: null,
      evidence_refs: [recRef], limitations: [why],
    });
    return [
      { recommendationId: r.recommendationId, line: 'labour', result: labour },
      { recommendationId: r.recommendationId, line: 'downtime', result: pending('downtime',
        'downtime cost is not computed: no downtime hours are authored and no downtime_cost_per_hour exists (QREC1 questions 4-5)') },
      { recommendationId: r.recommendationId, line: 'parts', result: pending('parts',
        'parts are listed unpriced: no parts price exists (QREC1 question 6)') },
      { recommendationId: r.recommendationId, line: 'fuel', result: pending('fuel',
        'no failure mode declares a fuel consequence to price (QREC1 question 5)') },
    ];
  });
  return { lines, missingParameters: missing };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A uuid-shaped id derived from its inputs, so a replay produces the same result ids. */
function deterministicUuid(seed: string): string {
  const h = sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** JSON with keys sorted at every depth: the same evidence always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v instanceof Date ? v.toISOString() : v);
}
