import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { ruleSignal } from '../page/page.service';
import { bundleView } from '../rec-frame/grounded-answer';
import { renderTemplateFrame } from '../rec-frame/render';
import { TEMPLATE_VERSION } from '../rec-frame/templates';
import { ENGINE_VERSION, RecEngineService } from '../rec-engine/rec-engine.service';
import { withEvalSession } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { WorkOrder } from '../work/entities/work-order.entity';
import { EvalDataset, EvalResult, EvalRun, EvalStatus } from './evaluation.entities';
import { DEFAULT_BUDGET_SECONDS, DEFAULT_BUDGET_SERIES, EVAL_LOCK_KEYS, EvalSummary } from './evaluation.service';
import { agreement, coverageHonesty, grounding, SelectionTally, selectedMode, Vocabulary } from './replay-scoring';

/** Bumped when the replay's scoring changes, so two runs' numbers are known to be comparable or not. */
export const REPLAY_SCORER_VERSION = 'qeval1c-1';
/** How many moments one machine may contribute, so one noisy machine cannot spend the whole budget. */
export const DEFAULT_MOMENTS_PER_MACHINE = 200;

const DAY_MS = 86_400_000;

/**
 * How a selection is labelled, stated on every run because it is the weakest link (Q4):
 * a work order records no failure mode, so the label is derived, and it shares its
 * input — the alert's signal — with the attribution it is checked against.
 */
export const LABEL_METHOD = 'A completed work order raised from an alert (work_order.alert_id) whose rule watches a '
  + 'signal exactly one of the class\'s failure modes names; that mode is the label. Work orders record no failure '
  + 'mode, so this is derived, not recorded, and it shares the alert\'s signal with the attribution step: agreement '
  + 'here says the selection followed the recorded work, not that either was right.';

export interface ReplayOptions {
  dataset: EvalDataset;
  datasetNote?: string;
  /** Defaults to the 90 days ending now. */
  from?: Date;
  to?: Date;
  budgetSeconds?: number;
  /** Machines, the replay's unit of budget. */
  budgetSeries?: number;
  momentsPerMachine?: number;
  clock?: () => number;
  onLocked?: () => Promise<void>;
}

interface Machine { tenantId: string; sourceSystem: string; externalId: string }

interface MachineResult {
  moments: number;
  grounding: { frames: number; failed: number; failures: { at: string; checks: string[] }[] };
  honesty: { noHistoryMoments: number; violations: { at: string; checks: string[] }[] };
  selection: SelectionTally & { rate: number | null; denominator: number; reason: string | null; momentsUnreached: number };
}

/**
 * QEVAL1c: the recommendation replay (QEVAL1 §4). Replays QREC1's five steps and QREC2's
 * template renderer at past moments — each alert's firing, and the window's end — and
 * measures grounding, coverage honesty, and selection against the work that followed.
 *
 * Nothing it computes is written where the product reads it (G10): bundles come from
 * `computeAsOf`, which holds them in memory, frames from the pure renderer, and the
 * whole run is under `ta_eval`, which the database lets write `eval_run` and
 * `eval_result` and nothing else — so a code path that tried to persist a bundle or a
 * frame would be refused, not merely not taken.
 *
 * The language-model renderer is not evaluated (Q8): REC_FRAME_MODEL_ENABLED is
 * process-wide, so it cannot be turned on for the eval namespace alone.
 */
@Injectable()
export class RecommendationReplayService {
  private readonly logger = new Logger(RecommendationReplayService.name);

  constructor(private readonly ds: DataSource, private readonly engine: RecEngineService) {}

  async run(opts: ReplayOptions, now = new Date()): Promise<EvalSummary> {
    const to = opts.to ?? now;
    const from = opts.from ?? new Date(to.getTime() - 90 * DAY_MS);
    const base = {
      kind: 'recommendation_replay' as const, dataset: opts.dataset, datasetNote: opts.datasetNote ?? null,
      windowFrom: from, windowTo: to, budgetSeconds: opts.budgetSeconds ?? DEFAULT_BUDGET_SECONDS,
      budgetSeries: opts.budgetSeries ?? DEFAULT_BUDGET_SERIES, startedAt: now,
    };
    const versions = {
      scorer: REPLAY_SCORER_VERSION, engine: ENGINE_VERSION, renderer: TEMPLATE_VERSION, rendererPath: 'template',
      modelPath: 'not evaluated: REC_FRAME_MODEL_ENABLED cannot be scoped to the eval namespace (QEVAL1 Q8)',
      labelMethod: LABEL_METHOD,
      asOf: 'alerts, work orders, service records and incidents are put back as they stood; the library, alert rules, '
        + 'signal bindings and parameters are read as they are now; a cancelled work order counts as cancelled from its last update',
    };

    const lock = await tryTakePassLock(this.ds, EVAL_LOCK_KEYS.recommendation_replay);
    if (!lock) {
      const run = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).save({
        ...base, versions, status: 'lock_held', finishedAt: now,
      }));
      return { runId: run.id, status: 'lock_held', dataset: opts.dataset, summary: null, error: null };
    }
    try {
      await opts.onLocked?.();
      return await this.replay(opts, base, versions, now);
    } finally {
      await lock.release();
    }
  }

  private async replay(
    opts: ReplayOptions,
    base: Omit<EvalRun, 'id' | 'status' | 'versions' | 'finishedAt' | 'unreached' | 'summary' | 'error'>,
    versions: Record<string, unknown>,
    now: Date,
  ): Promise<EvalSummary> {
    const clock = opts.clock ?? Date.now;
    const t0 = clock();
    const overBudget = () => clock() - t0 > base.budgetSeconds * 1000;
    const perMachine = Math.max(1, Math.floor(opts.momentsPerMachine ?? DEFAULT_MOMENTS_PER_MACHINE));

    const machines: Machine[] = await withEvalSession(this.ds, { spanning: 'recommendation replay: classified machines' }, (m) => m.query(`
      SELECT "tenant_id" AS "tenantId", "source_system" AS "sourceSystem", "external_id" AS "externalId"
        FROM "equipment_profile" WHERE "equipment_class_slug" IS NOT NULL
       ORDER BY 1, 2, 3`));
    let dataset = base.dataset;
    let datasetNote = base.datasetNote;
    if (dataset === 'real' && await this.anySimulated(machines, base.windowFrom, base.windowTo)) {
      dataset = 'seeded';
      datasetNote = [datasetNote, 'relabelled seeded: simulated telemetry found in the window'].filter(Boolean).join('; ');
    }

    const run = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).save({
      ...base, dataset, datasetNote, versions, status: 'running' as const, finishedAt: null,
    }));
    const finish = async (status: EvalStatus, summary: Record<string, unknown> | null, error: string | null, unreached = 0) => {
      await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).update(run.id, {
        status, summary, error, unreached, finishedAt: new Date(now.getTime() + Math.max(0, clock() - t0)),
      }));
      return { runId: run.id, status, dataset, summary, error };
    };

    try {
      const results: Omit<EvalResult, 'id' | 'createdAt'>[] = [];
      const unreached: Machine[] = [];
      const pooled = {
        moments: 0, frames: 0, groundingFailed: 0, groundingByCheck: {} as Record<string, number>,
        noHistoryMoments: 0, honestyViolations: 0, honestyByCheck: {} as Record<string, number>,
        selection: { labelled: 0, agreed: 0, disagreed: 0, noSelection: 0 } as SelectionTally,
        machines: { replayed: 0, insufficientHistory: 0 }, momentsUnreached: 0,
      };

      for (const machine of machines) {
        if (pooled.machines.replayed >= base.budgetSeries || overBudget()) { unreached.push(machine); continue; }
        pooled.machines.replayed += 1;
        const r = await withEvalSession(this.ds, { tenantId: machine.tenantId },
          (m) => this.replayMachine(m, machine, base.windowFrom, base.windowTo, perMachine));
        if (!r) continue;
        results.push({ runId: run.id, ...machine, subject: 'recommendation', variant: 'replay', metrics: { ...r } });

        pooled.moments += r.moments;
        pooled.frames += r.grounding.frames;
        pooled.groundingFailed += r.grounding.failed;
        for (const f of r.grounding.failures) for (const c of f.checks) pooled.groundingByCheck[c] = (pooled.groundingByCheck[c] ?? 0) + 1;
        pooled.noHistoryMoments += r.honesty.noHistoryMoments;
        pooled.honestyViolations += r.honesty.violations.length;
        for (const v of r.honesty.violations) for (const c of v.checks) pooled.honestyByCheck[c] = (pooled.honestyByCheck[c] ?? 0) + 1;
        for (const k of ['labelled', 'agreed', 'disagreed', 'noSelection'] as const) pooled.selection[k] += r.selection[k];
        if (r.selection.reason === 'insufficient_history') pooled.machines.insufficientHistory += 1;
        pooled.momentsUnreached += r.selection.momentsUnreached;
      }

      for (const k of unreached) results.push({ runId: run.id, ...k, subject: 'recommendation', variant: 'unreached', metrics: { reason: 'budget_exhausted' } });
      const byTenant = new Map<string, typeof results>();
      for (const r of results) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, rows] of byTenant) {
        await withEvalSession(this.ds, { tenantId }, (m) => m.getRepository(EvalResult).insert(rows));
      }

      // Aggregates only: which checks failed and how often, never which machine (Q7). The
      // per-machine list, with each failing moment, is in that account's eval_result rows.
      const summary = {
        dataset, datasetNote,
        claim: dataset === 'seeded'
          ? 'smoke test: seeded alerts and work orders measure the seeder, not the engine; no quality claim is made'
          : 'measurement against recorded work; no acceptance target exists (QEVAL1 Q2), so nothing is gated',
        machines: { enumerated: machines.length, ...pooled.machines, unreached: unreached.length },
        moments: { replayed: pooled.moments, unreachedOverMomentCap: pooled.momentsUnreached },
        grounding: {
          frames: pooled.frames, failed: pooled.groundingFailed,
          failureRate: pooled.frames ? pooled.groundingFailed / pooled.frames : null,
          reason: pooled.frames ? null : 'no_moments_replayed',
          byCheck: pooled.groundingByCheck,
          note: 'the deterministic renderer should fail none; any failure is a template defect, named by its check',
        },
        coverageHonesty: {
          noHistoryMoments: pooled.noHistoryMoments, violations: pooled.honestyViolations,
          reason: pooled.noHistoryMoments ? null : 'no_moment_without_history',
          byCheck: pooled.honestyByCheck,
        },
        selection: {
          ...pooled.selection, ...agreement(pooled.selection),
          label: 'agreement with recorded work — not accuracy (QEVAL1 Q4)', labelMethod: LABEL_METHOD,
        },
      };
      return finish(unreached.length ? 'budget_exhausted' : 'completed', summary, null, unreached.length);
    } catch (err) {
      this.logger.error(`recommendation replay failed: ${(err as Error).message}`);
      return finish('failed', null, (err as Error).message.slice(0, 2000));
    }
  }

  /** One machine's moments, replayed in its own tenant session as `ta_eval`. */
  private async replayMachine(
    m: EntityManager, k: Machine, from: Date, to: Date, perMachine: number,
  ): Promise<MachineResult | null> {
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: k.tenantId, sourceSystem: k.sourceSystem, externalId: k.externalId },
    });
    if (!profile?.equipmentClassSlug) return null;

    const events = await m.getRepository(AlertEvent).find({
      where: { tenantId: k.tenantId, sourceSystem: k.sourceSystem, externalId: k.externalId }, order: { firedAt: 'ASC' },
    });
    // Each alert's firing is a moment someone would have looked; the window's end is the
    // moment of a machine with no alerts at all, which is the one D21's honesty test needs.
    const times = [...new Set(events.map((e) => e.firedAt.getTime()).filter((t) => t >= from.getTime() && t < to.getTime()))];
    times.push(to.getTime());
    const moments = times.slice(0, perMachine);
    const momentsUnreached = times.length - moments.length;

    const labels = await this.labels(m, k, profile.equipmentClassSlug, events);
    const vocabulary = await this.vocabulary(m, k.tenantId);

    const out: MachineResult = {
      moments: moments.length,
      grounding: { frames: 0, failed: 0, failures: [] },
      honesty: { noHistoryMoments: 0, violations: [] },
      selection: { labelled: 0, agreed: 0, disagreed: 0, noSelection: 0, rate: null, denominator: 0, reason: null, momentsUnreached },
    };
    let anyHistory = false;
    for (const t of moments) {
      const at = new Date(t);
      const view = bundleView(await this.engine.computeAsOf(m, k.tenantId, profile, at));
      const frame = renderTemplateFrame(view);
      out.grounding.frames += 1;
      const g = grounding(frame, view, vocabulary);
      if (g.length) { out.grounding.failed += 1; out.grounding.failures.push({ at: at.toISOString(), checks: g }); }

      const rows = Object.values(view.precedent.coverage.sources).reduce((a, s) => a + s.rows, 0);
      if (rows > 0) anyHistory = true;
      if (view.precedent.modes.some((p) => p.state === 'no_history')) out.honesty.noHistoryMoments += 1;
      const h = coverageHonesty(frame, view);
      if (h.length) out.honesty.violations.push({ at: at.toISOString(), checks: h });

      // The work that followed this moment, if any was recorded against one failure mode.
      const label = labels.find((l) => l.createdAt >= t && l.createdAt <= to.getTime());
      if (!label) continue;
      out.selection.labelled += 1;
      const chosen = selectedMode(frame, view);
      if (chosen === null) out.selection.noSelection += 1;
      else if (chosen === label.mode) out.selection.agreed += 1;
      else out.selection.disagreed += 1;
    }
    // D28's third outcome: a machine with nothing to learn from reports that, not a rate.
    const a = anyHistory ? agreement(out.selection) : { rate: null, denominator: 0, reason: 'insufficient_history' };
    Object.assign(out.selection, a);
    return out;
  }

  /** Completed work orders raised from an alert whose signal exactly one failure mode names, earliest first. */
  private async labels(m: EntityManager, k: Machine, classSlug: string, events: AlertEvent[]): Promise<{ createdAt: number; mode: string }[]> {
    const orders = await m.getRepository(WorkOrder).find({
      where: { tenantId: k.tenantId, sourceSystem: k.sourceSystem, externalId: k.externalId, status: 'completed' },
      order: { createdAt: 'ASC' },
    });
    const linked = orders.filter((w) => w.alertId !== null);
    if (!linked.length) return [];
    const ruleIds = [...new Set(events.map((e) => e.ruleId))];
    const rules = ruleIds.length ? await m.getRepository(AlertRule).find({ where: { tenantId: k.tenantId, id: In(ruleIds) } }) : [];
    const signalOfRule = new Map(rules.map((r) => [r.id, ruleSignal(r)]));
    const eventSignal = new Map(events.map((e) => [e.id, signalOfRule.get(e.ruleId) ?? null]));
    const modes = await m.getRepository(ClientEquipmentClassFailureMode).find({
      where: { tenantId: k.tenantId, clientEquipmentClassSlug: classSlug },
    });
    const out: { createdAt: number; mode: string }[] = [];
    for (const w of linked) {
      const signal = eventSignal.get(w.alertId!);
      if (!signal) continue;
      const naming = modes.filter((f) => f.signals.includes(signal));
      if (naming.length === 1) out.push({ createdAt: w.createdAt.getTime(), mode: naming[0].code });
    }
    return out;
  }

  /** Every name the account's library could put in a sentence, for the grounding check's name test. */
  private async vocabulary(m: EntityManager, tenantId: string): Promise<Vocabulary> {
    const modes = await m.getRepository(ClientEquipmentClassFailureMode).find({ where: { tenantId } });
    const recs = await m.getRepository(ClientEquipmentClassRecommendation).find({ where: { tenantId } });
    return { names: [...modes.flatMap((f) => [f.name, ...f.signals]), ...recs.map((r) => r.action)] };
  }

  private async anySimulated(machines: Machine[], from: Date, to: Date): Promise<boolean> {
    const tenants = [...new Set(machines.map((k) => k.tenantId))];
    if (!tenants.length) return false;
    const rows = await withEvalSession(this.ds, { spanning: 'recommendation replay: is the dataset seeded' }, (m) => m.query(`
      SELECT 1 FROM "telemetry_reading"
       WHERE "tenant_id" = ANY($1) AND "source" = 'simulated' AND "source_timestamp" >= $2 AND "source_timestamp" < $3
       LIMIT 1`, [tenants, from, to]));
    return rows.length > 0;
  }
}
