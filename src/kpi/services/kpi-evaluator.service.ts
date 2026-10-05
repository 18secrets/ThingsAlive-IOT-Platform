import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import {
  ExcludedRange, openWorkOrderExcludedRanges, Reading,
} from '../../catalog/formula/baseline-operators';
import { ExecContext, lookupExecutor } from '../../catalog/formula/executor-registry';
import { ArgKind, lookupOperator } from '../../catalog/formula/operator-registry';
import { ClientEquipmentClass } from '../../client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../../client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { SignalBindingService } from '../../signal-binding/services/signal-binding.service';
import { WorkOrder } from '../../work/entities/work-order.entity';
import { Coverage, EquipmentRef, KpiEnvelope, Readiness, Reason } from '../types';
import { TelemetryWindowReader } from './telemetry-window-reader';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** D29's §4: below this ratio of expected-to-actual readings, a KPI is not
 * trustworthy enough to show a number for. Named rather than left as a literal
 * so the next person reading a diff sees it change on purpose. */
export const MIN_COVERAGE_RATIO = 0.5;

/**
 * Platform default until Q08S s3 (not started as of this task) adds a real
 * per-signal `stale_after_seconds` column. §4's own wording assumes that column
 * already exists; it does not. 900s matches the figure already quoted for Q08S
 * s3 in the task register, so nothing here needs re-deciding when it lands —
 * only replacing. Reported as a judgment call, not silently assumed.
 */
export const DEFAULT_STALE_AFTER_SECONDS = 900;

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
  excludedRanges: ExcludedRange[];
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
      const { formulas } = await this.loadFormulas(m, scope.tenantId, equipment);
      if (!formulas.length) return [];
      return this.evaluateBatch(m, scope.tenantId, equipment, formulas, formulas, at);
    });
  }

  async evaluateOne(
    scope: RequestScope, equipment: EquipmentRef, formulaKey: string,
    at: Date = new Date(), explicitWindow?: Window,
  ): Promise<KpiEnvelope> {
    return withTenantSession(this.ds, scope, async (m) => {
      const { formulas } = await this.loadFormulas(m, scope.tenantId, equipment);
      const target = formulas.find((f) => f.formulaKey === formulaKey);
      if (!target) throw new NotFoundException(`No KPI "${formulaKey}" on this equipment's class.`);
      const [envelope] = await this.evaluateBatch(
        m, scope.tenantId, equipment, formulas, [target], at, explicitWindow,
      );
      return envelope;
    });
  }

  private async loadFormulas(
    m: EntityManager, tenantId: string, equipment: EquipmentRef,
  ): Promise<{ formulas: ClientFormula[] }> {
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    if (!profile.equipmentClassSlug) return { formulas: [] };

    const clientClass = await m.getRepository(ClientEquipmentClass).findOne({
      where: { tenantId, slug: profile.equipmentClassSlug },
    });
    if (!clientClass) return { formulas: [] };

    const formulas = await m.getRepository(ClientFormula).find({
      where: { tenantId, clientEquipmentClassSlug: clientClass.slug, status: 'active' },
    });
    return { formulas };
  }

  private async evaluateBatch(
    m: EntityManager, tenantId: string, equipment: EquipmentRef,
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
    const excludedRanges = openWorkOrderExcludedRanges(
      openOrders.map((o) => ({
        status: o.status as 'created' | 'in-progress' | 'completed' | 'cancelled',
        startedAt: o.startedAt, createdAt: o.createdAt, endedAt: o.endedAt,
      })),
      at,
    );

    const signals = new Map<string, SignalStatus>();
    for (const signal of allRequiredSignals) {
      signals.set(signal, resolveSignalStatus(signal, bindingStatus, seriesBySignal, at));
    }

    return targets.map((target) => this.buildEnvelope(target, perTargetWindow.get(target.formulaKey) ?? null, {
      signals, siblings: new Map([...siblings].map(([k, f]) => [k, { plan: f.compiledPlan }])), excludedRanges,
    }));
  }

  private buildEnvelope(
    formula: ClientFormula, window: Window | null,
    ctxBase: { signals: Map<string, SignalStatus>; siblings: Map<string, { plan: unknown }>; excludedRanges: ExcludedRange[] },
  ): KpiEnvelope {
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
        return { ...base, value: null, readiness: 'blocked', reason: 'unbound', coverage: zeroCoverage() };
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

    const ctx: PlanEvalContext = { window, signals: ctxBase.signals, siblings: ctxBase.siblings, excludedRanges: ctxBase.excludedRanges };
    const result = evalNode(formula.compiledPlan, ctx);
    if (result.ok === false) {
      return {
        ...base, value: null, readiness: result.readiness, reason: result.reason, coverage,
      };
    }
    return { ...base, value: result.value, readiness: 'ready', coverage };
  }
}

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

function resolveSignalStatus(
  name: string, bindingStatus: Map<string, number | null | undefined>,
  seriesBySignal: Map<string, Reading[]>, at: Date,
): SignalStatus {
  if (!bindingStatus.has(name) || bindingStatus.get(name) === undefined) {
    return { ok: false, readiness: 'blocked', reason: 'unbound' };
  }
  const series = seriesBySignal.get(name) ?? [];
  if (!series.length) return { ok: false, readiness: 'not_available', reason: 'no_readings' };
  const latest = series[series.length - 1].at;
  if (at.getTime() - latest.getTime() > DEFAULT_STALE_AFTER_SECONDS * 1000) {
    return { ok: false, readiness: 'not_available', reason: 'stale' };
  }
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
      if (!sig) return { ok: false, readiness: 'blocked', reason: 'unbound' };
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
      for (let i = 0; i < node.args.length; i += 1) {
        const argNode = node.args[i];
        const kind: ArgKind = opEntry.argKinds[i];
        if (kind === 'duration') {
          durationArgs.push(argNode.hours);
          continue;
        }
        if (kind === 'series') {
          const sig = ctx.signals.get(argNode.name);
          if (!sig) return { ok: false, readiness: 'blocked', reason: 'unbound' };
          if (sig.ok === false) return { ok: false, readiness: sig.readiness, reason: sig.reason };
          seriesArgs.push(sig.series);
          continue;
        }
        const scalar = evalNode(argNode, ctx);
        if (scalar.ok === false) return scalar;
        scalarArgs.push(scalar.value);
      }
      const execCtx: ExecContext = {
        windowFrom: ctx.window.from, windowTo: ctx.window.to, history: [], excludedRanges: ctx.excludedRanges,
      };
      const result = executor.run(seriesArgs, scalarArgs, durationArgs, execCtx);
      if (result.ok === false) return { ok: false, readiness: 'not_available', reason: result.reason };
      return { ok: true, value: result.value };
    }
    default:
      throw new Error(`unrecognised plan node: ${JSON.stringify(node)}`);
  }
}
