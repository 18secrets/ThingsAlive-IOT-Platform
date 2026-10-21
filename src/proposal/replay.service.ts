import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AlertTrigger, CompositeTerm, evaluateRule, isCompositeLeaf } from '../alert/services/alert-rules';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { withTenantId } from '../scope/tenant-session';
import { EquipmentShift } from '../shift/entities/equipment-shift.entity';
import { alertWindow, inPulledWindow } from '../shift/services/alert-window';
import { RUNNING_SIGNAL } from '../shift/services/running-status';
import { ShiftDefinition, windowsEndingBetween } from '../shift/services/shift-window';
import { bindingSegments } from '../signal-binding/services/signal-binding.service';
import { ReplayPlan, ReplayRule } from './emitter';
import {
  FIRES_DETAIL_LIMIT, MIN_HISTORY_DAYS, MIN_HISTORY_READINGS, REPLAY_WINDOW_DAYS, replayMaxFires, ReplayOutcome,
} from './proposal-kinds';

const DAY_MS = 86_400_000;

export interface SignalHistory {
  signal: string;
  readings: number;
  /** Distinct UTC calendar days with at least one reading, inside the replay window. */
  days: number;
  firstReading: string | null;
  lastReading: string | null;
  sufficient: boolean;
}

export interface FiringWindow {
  window: { start: string; end: string; localDate: string; shift: string };
  rule: string;
  summary: string;
  evidence: Record<string, unknown>;
}

/** One machine's replay, before it is recorded. */
export interface MachineReplay {
  sourceSystem: string;
  externalId: string;
  windowFrom: Date;
  windowTo: Date;
  compilerVersion: string;
  signals: SignalHistory[];
  windowsEvaluated: number;
  fires: number;
  firesDetail: { total: number; kept: number; windows: FiringWindow[] };
  outcome: ReplayOutcome;
  outcomeReason: string;
  /** Rows read from telemetry, for the cost report (D24: the numbers nobody checks). */
  rowsRead: number;
  startedAt: Date;
  finishedAt: Date;
}

/** What a trigger needs that a replay cannot rebuild from telemetry alone. */
const NEEDS_CONTEXT: Partial<Record<AlertTrigger, string>> = {
  'prediction-severity': 'the scorer\'s predictions',
  'chain-origin': 'the chain diagnosis',
};

function contextNeeded(trigger: AlertTrigger, params: unknown): string[] {
  if (trigger !== 'composite') return NEEDS_CONTEXT[trigger] ? [NEEDS_CONTEXT[trigger]!] : [];
  const walk = (t: CompositeTerm): string[] => (isCompositeLeaf(t)
    ? contextNeeded(t.trigger, t.params)
    : [...(t.allOf ?? []), ...(t.anyOf ?? [])].flatMap(walk));
  return walk((params as { condition: CompositeTerm }).condition);
}

/**
 * Historical replay (task QGEN1, D28): every compiled rule over a machine's last 90
 * days, before anyone sees the draft.
 *
 * It shares production's calculation code (G10) — the shift windows come from the same
 * `windowsEndingBetween`, each window's readings from the same `alertWindow`, the
 * verdict from the same pure `evaluateRule` — and production's side effects none of it.
 * Two enforcements of that, not one: the service is built without the alert, event,
 * work-order or baseline services, so it cannot call what it is not given; and every
 * read runs in a READ ONLY transaction, so a write anywhere on this path is refused by
 * PostgreSQL rather than by review.
 *
 * What it cannot rebuild it does not pretend to. Predictions and chain diagnoses are
 * produced live by the shift pass and are not telemetry, so a rule that reads them is
 * reported `insufficient_history` with that reason — a replay that fed them nothing
 * would report zero fires, which reads as clean and is exactly the defect D28 was
 * corrected for.
 */
@Injectable()
export class ReplayService {
  private readonly reader = new TelemetryWindowReader();

  constructor(private readonly ds: DataSource) {}

  /** The one transaction replay reads in. Public so a test can attempt a write inside it. */
  readOnly<R>(tenantId: string, fn: (m: EntityManager) => Promise<R>): Promise<R> {
    return withTenantId(this.ds, tenantId, async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      return fn(m);
    });
  }

  async replay(tenantId: string, plan: ReplayPlan, at: Date): Promise<MachineReplay[]> {
    return this.readOnly(tenantId, async (m) => {
      const out: MachineReplay[] = [];
      for (const machine of plan.machines) out.push(await this.machine(m, tenantId, machine, plan, at));
      return out;
    });
  }

  /** The history check alone, for recording what a machine had when a rule was switched on. */
  async history(tenantId: string, machine: { sourceSystem: string; externalId: string }, signals: string[], at: Date) {
    return this.readOnly(tenantId, async (m) => {
      const from = new Date(at.getTime() - REPLAY_WINDOW_DAYS * DAY_MS);
      const segments = await this.segments(m, tenantId, machine, signals);
      const rows = await this.reader.readSegmentRows(m, tenantId, segments, from, at);
      return signals.map((s) => historyOf(s, rows, from, at));
    });
  }

  private async machine(
    m: EntityManager, tenantId: string, machine: { sourceSystem: string; externalId: string }, plan: ReplayPlan, at: Date,
  ): Promise<MachineReplay> {
    const startedAt = new Date();
    const windowTo = at;
    const windowFrom = new Date(at.getTime() - REPLAY_WINDOW_DAYS * DAY_MS);

    const shifts = await m.getRepository(EquipmentShift).find({
      where: { tenantId, sourceSystem: machine.sourceSystem, externalId: machine.externalId, status: 'active' },
    });
    const windows = shifts
      .flatMap((s) => windowsEndingBetween(s as unknown as ShiftDefinition, windowFrom, windowTo).map((w) => ({ ...w, shift: s.name })))
      .sort((a, b) => a.end.getTime() - b.end.getTime());

    const ruleSignals = [...new Set(plan.rules.flatMap((r) => r.signals))];
    const segments = await this.segments(m, tenantId, machine, [...new Set([...ruleSignals, RUNNING_SIGNAL])]);
    // One read for the whole replay, bound on both ends so partitions prune: from the
    // earliest window start (an overnight shift starts before the window does) to now.
    const readFrom = new Date(Math.min(windowFrom.getTime(), ...windows.map((w) => w.start.getTime())));
    const rows = await this.reader.readSegmentRows(m, tenantId, segments, readFrom, windowTo);
    const times = rows.map((r) => r.at.getTime());

    const signals = ruleSignals.map((s) => historyOf(s, rows, windowFrom, windowTo));

    let windowsEvaluated = 0;
    let fires = 0;
    const kept: FiringWindow[] = [];
    for (const w of windows) {
      const inWindow = rows.slice(lowerBound(times, w.start.getTime()), upperBound(times, w.end.getTime()))
        .filter((r) => inPulledWindow(r.at, w));
      const input = alertWindow(inWindow.map((r) => ({
        imei: r.imei, signal: r.signal, value: r.value, unit: r.unit, sourceTimestamp: r.at.toISOString(),
      })));
      if (!input.evaluate) continue;
      windowsEvaluated += 1;
      for (const rule of plan.rules) {
        const firing = evaluateRule({ trigger: rule.trigger, params: rule.params, readings: input.readings, predictions: [], chains: [] });
        if (!firing) continue;
        fires += 1;
        if (kept.length < FIRES_DETAIL_LIMIT) {
          kept.push({
            window: { start: w.start.toISOString(), end: w.end.toISOString(), localDate: w.localDate, shift: w.shift },
            rule: rule.name, summary: firing.summary, evidence: firing.evidence,
          });
        }
      }
    }

    const { outcome, reason } = verdict(plan.rules, signals, windows.length, windowsEvaluated, fires);
    return {
      ...machine, windowFrom, windowTo, compilerVersion: plan.compilerVersion, signals, windowsEvaluated, fires,
      firesDetail: { total: fires, kept: kept.length, windows: kept },
      outcome, outcomeReason: reason, rowsRead: rows.length, startedAt, finishedAt: new Date(),
    };
  }

  private async segments(m: EntityManager, tenantId: string, machine: { sourceSystem: string; externalId: string }, signals: string[]) {
    const segs = await bindingSegments(m, tenantId, machine, signals, { by: 'signalKey', componentId: '' });
    return segs.map(({ signal, imei, from, to }) => ({ signal, imei, from, to }));
  }
}

function historyOf(
  signal: string, rows: { signal: string; at: Date }[], from: Date, to: Date,
): SignalHistory {
  const mine = rows.filter((r) => r.signal === signal && r.at >= from && r.at <= to);
  const days = new Set(mine.map((r) => r.at.toISOString().slice(0, 10))).size;
  return {
    signal, readings: mine.length, days,
    firstReading: mine[0]?.at.toISOString() ?? null,
    lastReading: mine.at(-1)?.at.toISOString() ?? null,
    sufficient: days >= MIN_HISTORY_DAYS && mine.length >= MIN_HISTORY_READINGS,
  };
}

/** D28's three outcomes, in the order that keeps "no history" from ever reading as a pass. */
function verdict(
  rules: ReplayRule[], signals: SignalHistory[], windows: number, evaluated: number, fires: number,
): { outcome: ReplayOutcome; reason: string } {
  const context = [...new Set(rules.flatMap((r) => contextNeeded(r.trigger, r.params)))];
  if (context.length) {
    return { outcome: 'insufficient_history', reason: `A rule reads ${context.join(' and ')}, which a replay cannot rebuild from telemetry; it was not replayed.` };
  }
  const short = signals.filter((s) => !s.sufficient);
  if (short.length) {
    return {
      outcome: 'insufficient_history',
      reason: short.map((s) => `${s.signal} has ${s.readings} reading(s) over ${s.days} day(s)`).join('; ')
        + `. A replay needs ${MIN_HISTORY_DAYS} days and ${MIN_HISTORY_READINGS} readings of each signal it reads.`,
    };
  }
  if (windows === 0) {
    return { outcome: 'insufficient_history', reason: 'The machine has no active shift, so no window was ever evaluated; production would not evaluate one either.' };
  }
  const bound = replayMaxFires();
  const counted = `${fires} fire(s) over ${evaluated} evaluated shift window(s)`;
  if (bound === null) {
    return { outcome: 'refuse', reason: `replay_bound_not_set: ${counted}, and no maximum has been named (PROPOSAL_REPLAY_MAX_FIRES, QGEN1 question 1).` };
  }
  return fires > bound
    ? { outcome: 'refuse', reason: `${counted}, above the maximum of ${bound} per machine.` }
    : { outcome: 'pass', reason: `${counted}, within the maximum of ${bound} per machine.` };
}

/** First index whose time is at or after `t`. */
function lowerBound(times: number[], t: number): number {
  let lo = 0; let hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** First index whose time is after `t`. */
function upperBound(times: number[], t: number): number {
  let lo = 0; let hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
