import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import {
  alertExcludedRanges, ExcludedRange, openWorkOrderExcludedRanges, Reading,
} from '../../catalog/formula/baseline-operators';
import { ExecContext, lookupExecutor } from '../../catalog/formula/executor-registry';
import { ArgKind, lookupOperator } from '../../catalog/formula/operator-registry';
import { EquipmentClassSensorRequirement } from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { ClientEquipmentClass } from '../../client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../../client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { SignalBindingService } from '../../signal-binding/services/signal-binding.service';
import { classifyFreshness, DEFAULT_STALE_AFTER_SECONDS, resolveStaleAfterSeconds } from '../../signal-binding/services/signal-freshness';
import { WorkOrder } from '../../work/entities/work-order.entity';
import { Coverage, EquipmentRef, KpiEnvelope, Readiness, Reason, SeriesPoint } from '../types';
import { BucketAggregate, TelemetryWindowReader } from './telemetry-window-reader';
import { MAX_BUCKETS_OVERRIDE, pickBucketSeconds } from './bucketing';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** D29's §4: below this ratio of expected-to-actual readings, a KPI is not
 * trustworthy enough to show a number for. Named rather than left as a literal
 * so the next person reading a diff sees it change on purpose. */
export const MIN_COVERAGE_RATIO = 0.5;

/** Fallback only — `signal_binding_version.expected_period_seconds` (Q08S s1,
 * never read anywhere before this) is the real declared cadence when a binding
 * sets it. This is what `coverage.expected` falls back to for a bound signal
 * that never set one. */
export const DEFAULT_EXPECTED_INTERVAL_SECONDS = 300;

interface Window { from: Date; to: Date }

type SignalStatus =
  | { ok: true; series: Reading[]; expectedPeriodSeconds: number | null }
  | { ok: false; readiness: Readiness; reason?: Reason };

interface PlanEvalContext {
  window: Window;
  signals: Map<string, SignalStatus>;
  siblings: Map<string, { plan: unknown }>;
  /** Per-signal (task QCE2.1 §5) — a rule on oil pressure must not dirty a
   * coolant-temperature baseline. Work-order ranges are machine-wide (no
   * `signal` column on `work_order`) and already merged into every entry here;
   * alert ranges are signal-specific and only merged into their own signal's. */
  excludedRangesBySignal: Map<string, ExcludedRange[]>;
}

type EvalResult =
  | { ok: true; value: number }
  | { ok: false; readiness: Readiness; reason?: Reason };

/**
 * Executes a `compiled_plan` over `telemetry_reading` and returns an envelope,
 * always (task QCE2). Never `eval`, never `new Function` — the plan is data,
 * walked node by node, same discipline as the compiler that produced it.
 */
@Injectable()
export class KpiEvaluatorService {
  private readonly reader = new TelemetryWindowReader();

  constructor(
    private readonly ds: DataSource,
    private readonly signalBindings: SignalBindingService,
  ) {}

  async evaluateAll(scope: RequestScope, equipment: EquipmentRef, at: Date = new Date()): Promise<KpiEnvelope[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const { formulas, profile } = await this.loadFormulas(m, scope.tenantId, equipment);
      if (!formulas.length) return [];
      return this.evaluateBatch(m, scope.tenantId, equipment, profile, formulas, formulas, at);
    });
  }

  async evaluateOne(
    scope: RequestScope, equipment: EquipmentRef, formulaKey: string,
    at: Date = new Date(), explicitWindow?: Window,
  ): Promise<KpiEnvelope> {
    return withTenantSession(this.ds, scope, async (m) => {
      const { formulas, profile } = await this.loadFormulas(m, scope.tenantId, equipment);
      const target = formulas.find((f) => f.formulaKey === formulaKey);
      if (!target) throw new NotFoundException(`No KPI "${formulaKey}" on this equipment's class.`);
      const [envelope] = await this.evaluateBatch(
        m, scope.tenantId, equipment, profile, formulas, [target], at, explicitWindow,
      );
      return envelope;
    });
  }

  private async loadFormulas(
    m: EntityManager, tenantId: string, equipment: EquipmentRef,
  ): Promise<{ formulas: ClientFormula[]; profile: EquipmentProfile }> {
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    if (!profile.equipmentClassSlug) return { formulas: [], profile };

    const clientClass = await m.getRepository(ClientEquipmentClass).findOne({
      where: { tenantId, slug: profile.equipmentClassSlug },
    });
    if (!clientClass) return { formulas: [], profile };

    const formulas = await m.getRepository(ClientFormula).find({
      where: { tenantId, clientEquipmentClassSlug: clientClass.slug, status: 'active' },
    });
    return { formulas, profile };
  }

  private async evaluateBatch(
    m: EntityManager, tenantId: string, equipment: EquipmentRef, profile: EquipmentProfile,
    allFormulas: ClientFormula[], targets: ClientFormula[], at: Date, explicitWindow?: Window,
  ): Promise<KpiEnvelope[]> {
    const siblings = new Map(allFormulas.map((f) => [f.formulaKey, f]));

    // Per-target display window, and the lookback-extended read window each one
    // actually needs (baseline operators reach further back than the display
    // window they render — see collectSignalLookback).
    const perTargetWindow = new Map<string, Window | null>();
    const signalLookbackHours = new Map<string, number>();
    for (const target of targets) {
      const display = explicitWindow ?? resolveWindow(target.aggregationWindow, at);
      perTargetWindow.set(target.formulaKey, display);
      if (!target.compiledPlan) continue;
      collectSignalLookback(target.compiledPlan, signalLookbackHours);
      // #formula_key composition pulls in a sibling's own signals too.
      for (const dep of target.requiredSignals) signalLookbackHours.set(dep, signalLookbackHours.get(dep) ?? 0);
    }

    const allRequiredSignals = [...new Set(targets.flatMap((t) => t.requiredSignals))];
    const devices = await m.getRepository(DeviceProjection).find({
      where: { tenantId, sourceSystem: equipment.sourceSystem, equipmentExternalId: equipment.externalId },
    });
    const imeis = [...new Set(devices.map((d) => d.imei))];

    // One read covering every target: from the earliest (display-or-lookback)
    // start to the latest display end, across the whole batch.
    const starts = targets.map((t) => {
      const display = perTargetWindow.get(t.formulaKey);
      if (!display) return at;
      const maxLookback = Math.max(0, ...t.requiredSignals.map((s) => signalLookbackHours.get(s) ?? 0));
      return new Date(Math.min(display.from.getTime(), display.to.getTime() - maxLookback * HOUR));
    });
    const readFrom = starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : at;
    const readTo = at;

    const seriesBySignal = await this.reader.read(m, tenantId, imeis, allRequiredSignals, readFrom, readTo);
    // Unbounded on purpose (task Q08S s3) — `seriesBySignal` only ever holds
    // what the window above asked for, so a reading older than its lower bound
    // is invisible to it. Telling `stale` (readings exist, none recently) apart
    // from `no_readings` (none ever) needs the single latest reading regardless
    // of when, which this is and the window-bound read cannot be.
    const latestEverBySignal = await this.reader.latestPerSignal(m, tenantId, imeis, allRequiredSignals);

    // Per-signal staleness threshold: the class's own requirement row, pinned
    // to the equipment's granted class_version — there is no tenant copy of
    // `equipment_class_sensor_requirement` to read instead (see
    // `signal-freshness.ts`).
    const staleAfterSecondsBySignal = new Map<string, number>();
    if (profile.equipmentClassSlug && profile.classVersion) {
      const requirements = await m.getRepository(EquipmentClassSensorRequirement).find({
        where: {
          classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion, componentScope: '',
          measurementRole: In(allRequiredSignals),
        },
      });
      for (const req of requirements) {
        staleAfterSecondsBySignal.set(req.measurementRole, resolveStaleAfterSeconds(req));
      }
    }

    const bindingStatus = new Map<string, number | null | undefined>();
    for (const signal of allRequiredSignals) {
      const binding = imeis.length
        ? await this.signalBindings.resolveBinding(tenantId, equipment, signal, '', at)
        : null;
      // undefined = unbound; null | number = bound, with or without a declared
      // expected-period (signal_binding_version.expected_period_seconds, set
      // by Q08S s1 and unread anywhere before this).
      bindingStatus.set(signal, binding ? binding.expectedPeriodSeconds : undefined);
    }

    const openOrders = await m.getRepository(WorkOrder).find({
      where: { tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId },
    });
    // Machine-wide (task QCE4's own finding: work_order has no signal column)
    // — the same ranges apply to every signal's baseline.
    const workOrderRanges = openWorkOrderExcludedRanges(
      openOrders.map((o) => ({
        status: o.status as 'created' | 'in-progress' | 'completed' | 'cancelled',
        startedAt: o.startedAt, createdAt: o.createdAt, endedAt: o.endedAt,
      })),
      at,
    );
    // Signal-specific (task QCE2.1 §5) — only the signals a baseline operator
    // actually reaches back for need this at all.
    const baselineSignals = [...signalLookbackHours.entries()].filter(([, h]) => h > 0).map(([s]) => s);
    const alertRangesBySignal = await this.loadAlertExcludedRangesBySignal(
      m, tenantId, equipment, profile, baselineSignals, at,
    );
    const excludedRangesBySignal = new Map<string, ExcludedRange[]>();
    for (const signal of allRequiredSignals) {
      excludedRangesBySignal.set(signal, [...workOrderRanges, ...(alertRangesBySignal.get(signal) ?? [])]);
    }

    const signals = new Map<string, SignalStatus>();
    for (const signal of allRequiredSignals) {
      const staleAfterSeconds = staleAfterSecondsBySignal.get(signal) ?? DEFAULT_STALE_AFTER_SECONDS;
      signals.set(signal, resolveSignalStatus(
        signal, bindingStatus, seriesBySignal, latestEverBySignal, staleAfterSeconds, at,
      ));
    }

    return Promise.all(targets.map((target) => this.buildEnvelope(
      target, perTargetWindow.get(target.formulaKey) ?? null,
      { signals, siblings: new Map([...siblings].map(([k, f]) => [k, { plan: f.compiledPlan }])), excludedRangesBySignal },
      m, tenantId, imeis,
    )));
  }

  /** Condition (a) of task QCE2.1 §5 — the same four-branch `appliesTo`
   * predicate `AlertService.applicableTo` already uses (`alert.service.ts`),
   * reused rather than reinvented. Condition (b) — the rule's signal must be
   * the baseline's input signal — is the SQL filter on `params->>'signal'`
   * below; without it, one noisy account-wide alert would dirty every
   * baseline on every machine. */
  private async loadAlertExcludedRangesBySignal(
    m: EntityManager, tenantId: string, equipment: EquipmentRef, profile: EquipmentProfile,
    signals: string[], at: Date,
  ): Promise<Map<string, ExcludedRange[]>> {
    const result = new Map<string, ExcludedRange[]>();
    if (!signals.length) return result;

    const rules: {
      id: string; appliesTo: string; plantId: string | null;
      sourceSystem: string | null; externalId: string | null;
      equipmentClassSlug: string | null; signal: string;
    }[] = await m.query(
      `SELECT "id", "applies_to" AS "appliesTo", "plant_id" AS "plantId",
              "source_system" AS "sourceSystem", "external_id" AS "externalId",
              "equipment_class_slug" AS "equipmentClassSlug", "params"->>'signal' AS "signal"
         FROM "alert_rule"
        WHERE "tenant_id" = $1 AND "enabled" = true AND "params"->>'signal' = ANY($2::text[])`,
      [tenantId, signals],
    );

    const applicable = rules.filter((r) => {
      if (r.appliesTo === 'account') return true;
      if (r.appliesTo === 'plant') return !!profile.plantId && r.plantId === profile.plantId;
      if (r.appliesTo === 'equipment-class') {
        return !!profile.equipmentClassSlug && r.equipmentClassSlug === profile.equipmentClassSlug;
      }
      return r.sourceSystem === equipment.sourceSystem && r.externalId === equipment.externalId;
    });
    if (!applicable.length) return result;

    const ruleIds = applicable.map((r) => r.id);
    const events: { ruleId: string; firedAt: Date; resolvedAt: Date | null }[] = await m.query(
      `SELECT "rule_id" AS "ruleId", "fired_at" AS "firedAt", "resolved_at" AS "resolvedAt"
         FROM "alert_event" WHERE "tenant_id" = $1 AND "rule_id" = ANY($2::uuid[])`,
      [tenantId, ruleIds],
    );

    const ruleSignal = new Map(applicable.map((r) => [r.id, r.signal]));
    const bySignal = new Map<string, { firedAt: Date; resolvedAt: Date | null }[]>();
    for (const e of events) {
      const signal = ruleSignal.get(e.ruleId);
      if (!signal) continue;
      const list = bySignal.get(signal) ?? [];
      list.push({ firedAt: new Date(e.firedAt), resolvedAt: e.resolvedAt ? new Date(e.resolvedAt) : null });
      bySignal.set(signal, list);
    }
    for (const [signal, spans] of bySignal) result.set(signal, alertExcludedRanges(spans, at));
    return result;
  }

  private async buildEnvelope(
    formula: ClientFormula, window: Window | null,
    ctxBase: { signals: Map<string, SignalStatus>; siblings: Map<string, { plan: unknown }>; excludedRangesBySignal: Map<string, ExcludedRange[]> },
    m: EntityManager, tenantId: string, imeis: string[],
  ): Promise<KpiEnvelope> {
    const unit = formula.resultUnit ?? 'dimensionless';
    const resultKind = formula.resultKind ?? 'scalar';

    const base: Omit<KpiEnvelope, 'value' | 'readiness' | 'reason' | 'coverage'> = {
      formulaKey: formula.formulaKey, unit, resultKind,
      window: window ? { from: window.from.toISOString(), to: window.to.toISOString() } : { from: '', to: '' },
    };

    if (formula.requiredParameters.length) {
      return { ...base, value: null, readiness: 'not_configured', coverage: zeroCoverage() };
    }
    if (!window) {
      // aggregation_window: 'shift' — no shift-schedule resolution built here.
      return { ...base, value: null, readiness: 'not_configured', coverage: zeroCoverage() };
    }
    if (!formula.compiledPlan) {
      return { ...base, value: null, readiness: 'not_configured', coverage: zeroCoverage() };
    }

    // Structural signal problems (unbound / no readings / stale) are checked
    // before coverage, not after — a signal with zero readings has a coverage
    // ratio of 0 too, and "insufficient_coverage" would otherwise preempt the
    // more specific, more actionable "unbound"/"no_readings"/"stale" every time.
    for (const name of formula.requiredSignals) {
      const sig = ctxBase.signals.get(name);
      if (!sig) {
        return { ...base, value: null, readiness: 'not_configured', reason: 'unbound', coverage: zeroCoverage() };
      }
      if (sig.ok === false) {
        return {
          ...base, value: null, readiness: sig.readiness, reason: sig.reason, coverage: zeroCoverage(),
        };
      }
    }

    const coverage = computeCoverage(formula.requiredSignals, ctxBase.signals, window);
    if (coverage.expected > 0 && coverage.ratio < MIN_COVERAGE_RATIO) {
      return {
        ...base, value: null, readiness: 'not_available', reason: 'insufficient_coverage', coverage,
      };
    }

    const ctx: PlanEvalContext = {
      window, signals: ctxBase.signals, siblings: ctxBase.siblings,
      excludedRangesBySignal: ctxBase.excludedRangesBySignal,
    };

    if (resultKind === 'series') {
      const points = await this.evaluateSeries(formula, ctx, m, tenantId, imeis);
      if (points.ok === false) {
        return { ...base, value: null, readiness: points.readiness, reason: points.reason, coverage };
      }
      return { ...base, value: points.value, readiness: 'ready', coverage };
    }

    const result = evalNode(formula.compiledPlan, ctx);
    if (result.ok === false) {
      return {
        ...base, value: null, readiness: result.readiness, reason: result.reason, coverage,
      };
    }
    // A `scalar`-declared plan is guaranteed a plain number by the type of
    // `result.value` here; the mirror-image check (a `series` plan that
    // produced a scalar) is `evaluateSeries`'s own job, below.
    return { ...base, value: result.value, readiness: 'ready', coverage };
  }

  /**
   * `resultKind: 'series'` evaluation (task QCE2.1 §1-4). A baseline-family
   * root (`baseline_avg`/`baseline_sd`/`zscore`/`delta_ratio`) returns its
   * existing single value as a **one-point array** — §4's documented
   * exception, not a failure. Anything else is bucketed in the database
   * (§2-3) and walked per bucket. A plan shape this cannot bucket (anything
   * beyond a bare signal, a single reducer directly wrapping one signal, or
   * `+`/`-`/`*`/`/`/unary-minus over two such shapes) throws, naming the
   * formula key — reported as a scope limit, not guessed at.
   */
  private async evaluateSeries(
    formula: ClientFormula, ctx: PlanEvalContext, m: EntityManager, tenantId: string, imeis: string[],
  ): Promise<{ ok: true; value: SeriesPoint[] } | { ok: false; readiness: Readiness; reason?: Reason }> {
    const plan = formula.compiledPlan as any;

    if (plan.type === 'call' && BASELINE_OPERATOR_NAMES.has(plan.name)) {
      const result = evalNode(plan, ctx);
      if (result.ok === false) return result;
      return { ok: true, value: [{ t: ctx.window.to.toISOString(), v: result.value }] };
    }

    const bucketPlan = planBucketShape(plan);
    if (!bucketPlan) {
      throw new Error(
        `formula "${formula.formulaKey}": declares result_kind "series" with a plan shape series `
          + 'bucketing does not support (only a bare signal, one reducer directly wrapping one signal, '
          + 'or +/-/*// / unary-minus over such shapes) — QCE2.1 scopes this out rather than guessing.',
      );
    }

    const signalsNeeded = [...bucketPlan.columnBySignal.keys()];
    const bucketSeconds = pickBucketSeconds((ctx.window.to.getTime() - ctx.window.from.getTime()) / 1000);
    const bucketed = await this.reader.readBucketed(
      m, tenantId, imeis, signalsNeeded, bucketSeconds, ctx.window.from, ctx.window.to,
    );
    const byBucketBySignal = new Map<string, Map<number, BucketAggregate>>();
    for (const [signal, rows] of bucketed) {
      byBucketBySignal.set(signal, new Map(rows.map((r) => [r.bucket.getTime(), r])));
    }

    const points: SeriesPoint[] = [];
    const startEpoch = Math.floor(ctx.window.from.getTime() / 1000 / bucketSeconds) * bucketSeconds;
    const endEpoch = ctx.window.to.getTime() / 1000;
    for (let epoch = startEpoch; epoch <= endEpoch; epoch += bucketSeconds) {
      const bucketMs = epoch * 1000;
      const v = evalBucketNode(bucketPlan.node, bucketMs, byBucketBySignal, bucketPlan.columnBySignal);
      points.push({ t: new Date(bucketMs).toISOString(), v });
    }
    // A `series` plan is guaranteed an array here — never a bare number, even
    // when the window is short enough to produce exactly one bucket.
    return { ok: true, value: points };
  }
}

/** Baseline operators are declared `series` (QCE4) because they are genuinely
 * time-varying quantities, but are not recomputed per bucket (QCE2.1 §4) —
 * they return their existing single value as a one-point array instead. */
const BASELINE_OPERATOR_NAMES = new Set(['baseline_avg', 'baseline_sd', 'zscore', 'delta_ratio']);

function zeroCoverage(): Coverage {
  return { expected: 0, actual: 0, ratio: 0 };
}

function computeCoverage(requiredSignals: string[], signals: Map<string, SignalStatus>, window: Window): Coverage {
  const seconds = Math.max(0, (window.to.getTime() - window.from.getTime()) / 1000);
  let expected = 0;
  let actual = 0;
  for (const name of requiredSignals) {
    const s = signals.get(name);
    const period = (s && s.ok === true && s.expectedPeriodSeconds) || DEFAULT_EXPECTED_INTERVAL_SECONDS;
    expected += Math.floor(seconds / period);
    if (s && s.ok === true) actual += s.series.filter((r) => r.at >= window.from && r.at <= window.to).length;
  }
  return { expected, actual, ratio: expected > 0 ? Math.min(1, actual / expected) : 1 };
}

/**
 * Readiness for `unbound` is `not_configured` (task Q08S s3's own table), not
 * `blocked` — nothing has been wired yet, which is a configuration gap, not an
 * active obstruction. `no_readings`/`stale` come from `latestEverBySignal`,
 * unbounded on purpose: `seriesBySignal` only holds what the read window
 * asked for, and a reading older than its lower bound would otherwise look
 * identical to one that never existed.
 */
function resolveSignalStatus(
  name: string, bindingStatus: Map<string, number | null | undefined>,
  seriesBySignal: Map<string, Reading[]>, latestEverBySignal: Map<string, Date>,
  staleAfterSeconds: number, at: Date,
): SignalStatus {
  if (!bindingStatus.has(name) || bindingStatus.get(name) === undefined) {
    return { ok: false, readiness: 'not_configured', reason: 'unbound' };
  }
  const freshness = classifyFreshness(latestEverBySignal.get(name) ?? null, at, staleAfterSeconds);
  if (freshness === 'no_readings') return { ok: false, readiness: 'not_available', reason: 'no_readings' };
  if (freshness === 'stale') return { ok: false, readiness: 'not_available', reason: 'stale' };
  const series = seriesBySignal.get(name) ?? [];
  return { ok: true, series, expectedPeriodSeconds: bindingStatus.get(name) ?? null };
}

/** Rolling from the evaluation instant for `24h`/`7d`/`30d`; UTC calendar
 * alignment for `today`/`mtd`/`ytd`. `shift` is declared on the formula but not
 * resolved here — it needs the equipment's actual shift schedule
 * (`EquipmentShift`/`ShiftRun`), which this task does not wire. A formula using
 * it reads `not_configured` rather than silently falling back to something it
 * did not ask for. */
function resolveWindow(aggWindow: string, at: Date): Window | null {
  switch (aggWindow) {
    case '24h': return { from: new Date(at.getTime() - DAY), to: at };
    case '7d': return { from: new Date(at.getTime() - 7 * DAY), to: at };
    case '30d': return { from: new Date(at.getTime() - 30 * DAY), to: at };
    case 'today': return { from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())), to: at };
    case 'mtd': return { from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)), to: at };
    case 'ytd': return { from: new Date(Date.UTC(at.getUTCFullYear(), 0, 1)), to: at };
    case 'shift': return null;
    default: return { from: new Date(at.getTime() - DAY), to: at };
  }
}

/** Walks a compiled plan recording, per signal name, the largest duration
 * literal it is ever passed alongside (a `baseline_avg(x, 90d)` needs 90 days
 * of `x` the display window itself does not cover) — so the batched telemetry
 * read's lower bound reaches far enough back for every operator in the plan,
 * not just the ones with no lookback of their own. */
function collectSignalLookback(node: any, acc: Map<string, number>): void {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'unary': collectSignalLookback(node.operand, acc); return;
    case 'binary': collectSignalLookback(node.left, acc); collectSignalLookback(node.right, acc); return;
    case 'call': {
      const durationHours = node.args
        .filter((a: any) => a.type === 'duration')
        .map((a: any) => a.hours as number);
      const maxDuration = durationHours.length ? Math.max(...durationHours) : 0;
      for (const arg of node.args) {
        if (arg.type === 'signal') {
          acc.set(arg.name, Math.max(acc.get(arg.name) ?? 0, maxDuration));
        } else {
          collectSignalLookback(arg, acc);
        }
      }
      return;
    }
    default:
  }
}

function evalNode(node: any, ctx: PlanEvalContext): EvalResult {
  switch (node.type) {
    case 'const':
      return { ok: true, value: node.value };
    case 'duration':
      return { ok: true, value: node.hours };
    case 'param':
      // QPARAM1 (tenant parameter values) does not exist yet — a formula that
      // references one cannot be evaluated, by construction, not by omission.
      return { ok: false, readiness: 'not_configured' };
    case 'signal': {
      const sig = ctx.signals.get(node.name);
      if (!sig) return { ok: false, readiness: 'not_configured', reason: 'unbound' };
      if (sig.ok === false) return { ok: false, readiness: sig.readiness, reason: sig.reason };
      const rows = sig.series.filter((r) => r.at >= ctx.window.from && r.at <= ctx.window.to);
      if (!rows.length) return { ok: false, readiness: 'not_available', reason: 'no_readings' };
      return { ok: true, value: rows[rows.length - 1].value };
    }
    case 'formula_ref': {
      const sib = ctx.siblings.get(node.formulaKey);
      if (!sib || !sib.plan) return { ok: false, readiness: 'not_configured' };
      return evalNode(sib.plan, ctx);
    }
    case 'unary': {
      const operand = evalNode(node.operand, ctx);
      if (operand.ok === false) return operand;
      return { ok: true, value: -operand.value };
    }
    case 'binary': {
      const left = evalNode(node.left, ctx);
      if (left.ok === false) return left;
      const right = evalNode(node.right, ctx);
      if (right.ok === false) return right;
      if (node.op === '/' && right.value === 0) {
        return { ok: false, readiness: 'not_available', reason: 'undefined_result' };
      }
      const value = node.op === '+' ? left.value + right.value
        : node.op === '-' ? left.value - right.value
          : node.op === '*' ? left.value * right.value
            : left.value / right.value;
      return { ok: true, value };
    }
    case 'call': {
      const opEntry = lookupOperator(node.name);
      const executor = lookupExecutor(node.name);
      if (!opEntry || !executor) {
        throw new Error(`no executor registered for operator "${node.name}" — registry drift.`);
      }
      const seriesArgs: Reading[][] = [];
      const scalarArgs: number[] = [];
      const durationArgs: number[] = [];
      let seriesArgSignal: string | null = null;
      for (let i = 0; i < node.args.length; i += 1) {
        const argNode = node.args[i];
        const kind: ArgKind = opEntry.argKinds[i];
        if (kind === 'duration') {
          durationArgs.push(argNode.hours);
          continue;
        }
        if (kind === 'series') {
          const sig = ctx.signals.get(argNode.name);
          if (!sig) return { ok: false, readiness: 'not_configured', reason: 'unbound' };
          if (sig.ok === false) return { ok: false, readiness: sig.readiness, reason: sig.reason };
          seriesArgs.push(sig.series);
          seriesArgSignal = seriesArgSignal ?? argNode.name;
          continue;
        }
        const scalar = evalNode(argNode, ctx);
        if (scalar.ok === false) return scalar;
        scalarArgs.push(scalar.value);
      }
      // Per-signal (task QCE2.1 §5) — a rule on a different signal must not
      // dirty this one's baseline.
      const excludedRanges = seriesArgSignal ? (ctx.excludedRangesBySignal.get(seriesArgSignal) ?? []) : [];
      const execCtx: ExecContext = {
        windowFrom: ctx.window.from, windowTo: ctx.window.to, history: [], excludedRanges,
      };
      const result = executor.run(seriesArgs, scalarArgs, durationArgs, execCtx);
      if (result.ok === false) return { ok: false, readiness: 'not_available', reason: result.reason };
      return { ok: true, value: result.value };
    }
    default:
      throw new Error(`unrecognised plan node: ${JSON.stringify(node)}`);
  }
}

type BucketColumn = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'first' | 'last';

/** Which per-bucket column answers each reducer (task QCE2.1 §3). `delta`,
 * `integrate`, `rate` and `fraction_within` have no single column that
 * reproduces them exactly within one bucket — `last` is the stated fallback
 * ("say what you do... rather than guessing silently"), not a silent choice. */
const OPERATOR_BUCKET_COLUMN: Partial<Record<string, BucketColumn>> = {
  avg: 'avg', min: 'min', max: 'max', sum: 'sum', count: 'count', first: 'first', last: 'last',
};

interface BucketShape {
  node: any;
  columnBySignal: Map<string, BucketColumn>;
}

/**
 * Validates that a `series`-kind plan is one of the shapes this task buckets
 * (task QCE2.1 §3), and records which per-bucket column each signal needs.
 * Supported: a bare signal; one reducer directly wrapping exactly one bare
 * signal; `+`/`-`/`*`/`/` or unary-minus combining such shapes. Anything else
 * (nested calls, `#formula_key` composition, a reducer over more than one
 * signal) returns `null` — `evaluateSeries` throws rather than guess at it.
 */
function planBucketShape(node: any): BucketShape | null {
  const columnBySignal = new Map<string, BucketColumn>();
  const supported = (n: any): boolean => {
    if (!n || typeof n !== 'object') return false;
    switch (n.type) {
      case 'signal':
        if (!columnBySignal.has(n.name)) columnBySignal.set(n.name, 'last');
        return true;
      case 'unary':
        return supported(n.operand);
      case 'binary':
        return supported(n.left) && supported(n.right);
      case 'call': {
        if (n.args.length !== 1 || n.args[0].type !== 'signal') return false;
        columnBySignal.set(n.args[0].name, OPERATOR_BUCKET_COLUMN[n.name] ?? 'last');
        return true;
      }
      default:
        return false;
    }
  };
  return supported(node) ? { node, columnBySignal } : null;
}

/**
 * One bucket's value for a plan `planBucketShape` already approved. `null`
 * propagates through arithmetic rather than being treated as 0 — a bucket
 * missing one side of a ratio has no answer for that point, not a confident
 * wrong one, same rule as everywhere else in this file.
 */
function evalBucketNode(
  node: any, bucketMs: number, byBucketBySignal: Map<string, Map<number, BucketAggregate>>,
  columnBySignal: Map<string, BucketColumn>,
): number | null {
  switch (node.type) {
    case 'signal': {
      const agg = byBucketBySignal.get(node.name)?.get(bucketMs);
      if (!agg) return null;
      return agg[columnBySignal.get(node.name) ?? 'last'];
    }
    case 'unary': {
      const v = evalBucketNode(node.operand, bucketMs, byBucketBySignal, columnBySignal);
      return v === null ? null : -v;
    }
    case 'binary': {
      const left = evalBucketNode(node.left, bucketMs, byBucketBySignal, columnBySignal);
      const right = evalBucketNode(node.right, bucketMs, byBucketBySignal, columnBySignal);
      if (left === null || right === null) return null;
      if (node.op === '/' && right === 0) return null;
      return node.op === '+' ? left + right
        : node.op === '-' ? left - right
          : node.op === '*' ? left * right
            : left / right;
    }
    case 'call': {
      const agg = byBucketBySignal.get(node.args[0].name)?.get(bucketMs);
      if (!agg) return null;
      return agg[columnBySignal.get(node.args[0].name) ?? 'last'];
    }
    default:
      return null;
  }
}
