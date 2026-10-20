import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { buildContext, FORECAST_RETENTION_DAYS, learnBand } from '../forecast/forecast-band';
import { ForecastModel } from '../forecast/forecast.entities';
import { ForecastReader } from '../forecast/forecast-reader';
import { FORECAST_WORKER, ForecastRequest, ForecastResponse, runWorker, WorkerCommand } from '../forecast/forecast-worker';
import { withEvalSession } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import {
  emptyLead, ExclusionReason, ForecastTrace, LeadAccumulator, leadMetrics, LeadMetrics, mergeInto, scoreSeries, SeriesScore,
  sumExclusions,
} from './backtest-scoring';
import { EvalDataset, EvalKind, EvalResult, EvalRun, EvalStatus } from './evaluation.entities';

/** Beside the shift (…001) and forecast (…002) pass locks: one per kind, so two runs of
 * one kind never interleave their writes and two kinds never wait on each other (§6). */
export const EVAL_LOCK_KEYS: Record<EvalKind, number> = {
  ttm_backtest: 8_742_310_011,
  retrieval: 8_742_310_012,
  recommendation_replay: 8_742_310_013,
};

/** Bumped when the scoring changes, so two runs' numbers are known to be comparable or not. */
export const BACKTEST_SCORER_VERSION = 'qeval1a-1';
/** Defaults for a run's budgets: a backtest that cannot finish says what it did not reach. */
export const DEFAULT_BUDGET_SECONDS = 15 * 60;
export const DEFAULT_BUDGET_SERIES = 5000;
/** How long after an anomalous stretch an alert or work order still counts as overlapping it. */
export const OVERLAP_AFTER_MS = 24 * 3_600_000;

const DAY_MS = 86_400_000;

export interface BacktestOptions {
  dataset: EvalDataset;
  datasetNote?: string;
  /** Defaults to the active model. */
  modelId?: string;
  /** Defaults to the 90-day hot window ending now. */
  from?: Date;
  to?: Date;
  /** Rolling-origin replay through the worker, one origin per UTC midnight, this many days back. 0 = none. */
  replayDays?: number;
  budgetSeconds?: number;
  budgetSeries?: number;
  /** Elapsed-time source for the budget; the tests drive it to exhaust the budget on cue. */
  clock?: () => number;
  /** Awaited once the lock is held; the concurrency test holds a run here. */
  onLocked?: () => Promise<void>;
}

export interface EvalSummary {
  runId: string;
  status: EvalStatus;
  dataset: EvalDataset;
  summary: Record<string, unknown> | null;
  error: string | null;
}

interface SeriesKey { tenantId: string; sourceSystem: string; externalId: string; signal: string }

interface AnomalyTally {
  normal: number; anomalous: number; baseline_not_established: number;
  stretches: number; stretchesWithAlert: number; stretchesWithWorkOrder: number;
}

/** Per-signal pooled numbers for the run's summary: aggregates only, never a machine (Q7). */
interface Pool { series: number; byLead: Map<number, LeadAccumulator> }

const keyOf = (k: SeriesKey) => `${k.tenantId}|${k.sourceSystem}|${k.externalId}|${k.signal}`;

/**
 * QEVAL1a: the evaluation run namespace and the TTM backtest (QEVAL1 §1, §2, §6).
 *
 * Everything it touches goes through `withEvalSession`, which runs as `ta_eval`: it reads
 * what QML1 stored and writes `eval_run` and `eval_result`, and the database refuses it
 * anything else (G10). The one place it invokes the model is the rolling-origin replay,
 * and that goes through QML1's own worker and input path (`runWorker`, `buildContext`),
 * not a second inference implementation.
 *
 * It reports and does not judge: no metric is gated, because no acceptance target exists
 * (Q2). A metric over nothing is null with its reason.
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly forecasts: ForecastReader,
    @Inject(FORECAST_WORKER) private readonly worker: WorkerCommand,
  ) {}

  async runBacktest(opts: BacktestOptions, now = new Date()): Promise<EvalSummary> {
    const to = opts.to ?? now;
    const from = opts.from ?? new Date(to.getTime() - FORECAST_RETENTION_DAYS * DAY_MS);
    const budgetSeconds = opts.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
    const budgetSeries = opts.budgetSeries ?? DEFAULT_BUDGET_SERIES;
    const base = {
      kind: 'ttm_backtest' as const, dataset: opts.dataset, datasetNote: opts.datasetNote ?? null,
      windowFrom: from, windowTo: to, budgetSeconds, budgetSeries, startedAt: now,
    };

    const lock = await tryTakePassLock(this.ds, EVAL_LOCK_KEYS.ttm_backtest);
    if (!lock) {
      // Never wait: the run holding the lock is doing this work. Recorded, so a stuck lock
      // shows as a run of these rather than as silence.
      const run = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).save({
        ...base, versions: { scorer: BACKTEST_SCORER_VERSION }, status: 'lock_held', finishedAt: now,
      }));
      return { runId: run.id, status: 'lock_held', dataset: opts.dataset, summary: null, error: null };
    }
    try {
      await opts.onLocked?.();
      return await this.backtest(opts, base, now);
    } finally {
      await lock.release();
    }
  }

  private async backtest(
    opts: BacktestOptions,
    base: Omit<EvalRun, 'id' | 'status' | 'versions' | 'finishedAt' | 'unreached' | 'summary' | 'error'>,
    now: Date,
  ): Promise<EvalSummary> {
    const clock = opts.clock ?? Date.now;
    const t0 = clock();
    const overBudget = () => clock() - t0 > base.budgetSeconds * 1000;
    const replayDays = Math.max(0, Math.floor(opts.replayDays ?? 0));

    const model = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(ForecastModel).findOne({
      where: opts.modelId ? { id: opts.modelId } : { status: 'active' },
    }));
    if (!model) throw new Error(opts.modelId ? `no forecast model ${opts.modelId}` : 'no active forecast model');
    const stepMs = 3_600_000;
    const versions = {
      scorer: BACKTEST_SCORER_VERSION,
      model: { id: model.id, key: model.key, revision: model.revision, weightsSha256: model.weightsSha256, status: model.status },
      contextLength: model.contextLength, predictionLength: model.predictionLength,
      actuals: 'forecast_input_bucket (hourly means, the values the model is fed)',
      replayDays,
    };

    // A seeded run is labelled seeded whatever it was asked to be (§5): seeded telemetry
    // measures the seeder, and nobody should read its numbers as the model's.
    const series = await this.enumerate(model.id, base.windowFrom, base.windowTo, replayDays > 0);
    let dataset = base.dataset;
    let datasetNote = base.datasetNote;
    if (dataset === 'real' && await this.anySimulated(series, base.windowFrom, base.windowTo)) {
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
      const daily = new Map<string, Pool>();
      const replay = new Map<string, Pool>();
      const excluded: Partial<Record<ExclusionReason, number>> = {};
      const replayExcluded: Partial<Record<ExclusionReason, number>> = {};
      const anomaly = new Map<string, AnomalyTally>();
      const unreached: SeriesKey[] = [];
      const contexts: { key: SeriesKey; origin: number; values: number[]; actuals: Map<number, number> }[] = [];
      let reached = 0;

      for (const key of series) {
        if (reached >= base.budgetSeries || overBudget()) { unreached.push(key); continue; }
        reached += 1;
        await withEvalSession(this.ds, { tenantId: key.tenantId }, async (m) => {
          const actuals = await this.actuals(m, key);

          const traces = await this.dailySamples(m, key, model.id, base.windowFrom, base.windowTo);
          if (traces.length) {
            const score = scoreSeries(actuals, traces, stepMs);
            pool(daily, key.signal, score);
            sumExclusions(excluded, score.excluded);
            results.push(this.result(run.id, key, 'daily_sample', seriesMetrics(score)));
          }

          const tally = await this.anomalyStates(m, key, model.id, base.windowFrom, base.windowTo, stepMs);
          if (tally) {
            addTally(anomaly, key.signal, tally);
            results.push(this.result(run.id, key, 'anomaly_states', { ...tally }));
          }

          for (let d = 1; d <= replayDays; d++) {
            const origin = Math.floor(base.windowTo.getTime() / DAY_MS) * DAY_MS - (d - 1) * DAY_MS
              - model.predictionLength * stepMs;
            if (origin < base.windowFrom.getTime()) break;
            const ctx = buildContext(actuals, origin - model.contextLength * stepMs, model.contextLength, stepMs);
            if (ctx.ok) contexts.push({ key, origin, values: ctx.values, actuals });
          }
        });
      }

      let replaySummary: Record<string, unknown> = !replayDays
        ? { ran: false, reason: 'not_requested' }
        : { ran: false, reason: reached ? 'no_buildable_context' : 'no_series' };
      if (contexts.length && overBudget()) {
        replaySummary = { ran: false, reason: 'budget_exhausted' };
        for (const c of contexts) unreached.push(c.key);
      } else if (contexts.length) {
        const request: ForecastRequest = {
          contract: 'forecast-request.v1',
          model: { key: model.key, revision: model.revision },
          contextLength: model.contextLength, predictionLength: model.predictionLength,
          series: contexts.map((c, i) => ({
            id: `r${i}`, stepSeconds: stepMs / 1000,
            start: new Date(c.origin - model.contextLength * stepMs).toISOString(), values: c.values,
          })),
        };
        const remaining = base.budgetSeconds * 1000 - (clock() - t0);
        const response: ForecastResponse = await runWorker(this.worker, request, Math.max(60_000, remaining));
        // The same provenance check the pass makes: numbers from weights other than the
        // registry's would be an evaluation of a model nobody asked about.
        if (response.model.weightsSha256 !== model.weightsSha256) {
          throw new Error(`worker loaded weights ${response.model.weightsSha256}, the registry names ${model.weightsSha256}`);
        }
        const values = new Map(response.series.map((s) => [s.id, s.values]));
        const bySeries = new Map<string, { key: SeriesKey; actuals: Map<number, number>; traces: ForecastTrace[]; refused: number }>();
        for (const [i, c] of contexts.entries()) {
          const entry = bySeries.get(keyOf(c.key)) ?? { key: c.key, actuals: c.actuals, traces: [], refused: 0 };
          bySeries.set(keyOf(c.key), entry);
          const v = values.get(`r${i}`);
          if (!v) { entry.refused += 1; continue; }
          entry.traces.push({
            stepMs, points: v.map((x, j) => ({ t: c.origin + j * stepMs, v: x, lo: null, hi: null })),
          });
        }
        for (const e of bySeries.values()) {
          const score = scoreSeries(e.actuals, e.traces, stepMs);
          pool(replay, e.key.signal, score);
          sumExclusions(replayExcluded, score.excluded);
          results.push(this.result(run.id, e.key, 'replay', { ...seriesMetrics(score), refusedByWorker: e.refused }));
        }
        replaySummary = {
          ran: true, origins: contexts.length, refusedByWorker: response.refused.length,
          timing: response.timing, bySignal: poolSummary(replay), excluded: replayExcluded,
        };
      }

      const unreachedKeys = new Map(unreached.map((k) => [keyOf(k), k]));
      for (const k of unreachedKeys.values()) results.push(this.result(run.id, k, 'unreached', { reason: 'budget_exhausted' }));
      const byTenant = new Map<string, typeof results>();
      for (const r of results) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, rows] of byTenant) {
        await withEvalSession(this.ds, { tenantId }, (m) => m.getRepository(EvalResult).insert(rows));
      }

      const summary = {
        dataset, datasetNote,
        claim: dataset === 'seeded'
          ? 'smoke test: seeded telemetry measures the seeder, not the model; no model-quality claim is made'
          : 'measurement against recorded data; no acceptance target exists (QEVAL1 Q2), so nothing is gated',
        series: { enumerated: series.length, reached, unreached: unreachedKeys.size },
        dailySample: { overall: overall(allLeads(daily)), bySignal: poolSummary(daily), excluded },
        replay: replaySummary,
        anomalyStates: {
          bySignal: Object.fromEntries(anomaly),
          note: 'overlap of anomalous stretches with a later alert or work order (within 24 h) is reported as overlap, not precision (G07)',
        },
      };
      return finish(unreachedKeys.size ? 'budget_exhausted' : 'completed', summary, null, unreachedKeys.size);
    } catch (err) {
      this.logger.error(`ttm backtest failed: ${(err as Error).message}`);
      return finish('failed', null, (err as Error).message.slice(0, 2000));
    }
  }

  private result(runId: string, k: SeriesKey, variant: string, metrics: Record<string, unknown>): Omit<EvalResult, 'id' | 'createdAt'> {
    return { runId, tenantId: k.tenantId, sourceSystem: k.sourceSystem, externalId: k.externalId, subject: k.signal, variant, metrics };
  }

  /** Every (machine, signal) with something to score: a daily sample or residuals of this
   * model in the window, or — for the replay — an hourly rollup to build a context from. */
  private enumerate(modelId: string, from: Date, to: Date, withBuckets: boolean): Promise<SeriesKey[]> {
    return withEvalSession(this.ds, { spanning: 'ttm backtest: which series have forecasts or inputs' }, (m) => m.query(`
      SELECT DISTINCT "tenant_id" AS "tenantId", "source_system" AS "sourceSystem", "external_id" AS "externalId", "signal"
        FROM (
          SELECT "tenant_id", "source_system", "external_id", "signal" FROM "forecast_daily_sample"
           WHERE "model_id" = $1 AND "day" >= $2::date AND "day" <= $3::date
          UNION ALL
          SELECT "tenant_id", "source_system", "external_id", "signal" FROM "forecast_residual"
           WHERE "model_id" = $1 AND "step_at" >= $2 AND "step_at" < $3
          UNION ALL
          SELECT "tenant_id", "source_system", "external_id", "signal" FROM "forecast_input_bucket"
           WHERE $4 AND "bucket_at" >= $2 AND "bucket_at" < $3
        ) s
       ORDER BY 1, 2, 3, 4`, [modelId, from, to, withBuckets]));
  }

  private async anySimulated(series: SeriesKey[], from: Date, to: Date): Promise<boolean> {
    const tenants = [...new Set(series.map((s) => s.tenantId))];
    if (!tenants.length) return false;
    const rows = await withEvalSession(this.ds, { spanning: 'ttm backtest: is the dataset seeded' }, (m) => m.query(`
      SELECT 1 FROM "telemetry_reading"
       WHERE "tenant_id" = ANY($1) AND "source" = 'simulated' AND "source_timestamp" >= $2 AND "source_timestamp" < $3
       LIMIT 1`, [tenants, from, to]));
    return rows.length > 0;
  }

  private async actuals(m: EntityManager, k: SeriesKey): Promise<Map<number, number>> {
    const rows: { at: Date; value: number }[] = await m.query(`
      SELECT "bucket_at" AS "at", "value" FROM "forecast_input_bucket"
       WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "signal" = $4`,
    [k.tenantId, k.sourceSystem, k.externalId, k.signal]);
    return new Map(rows.map((r) => [new Date(r.at).getTime(), Number(r.value)]));
  }

  private async dailySamples(m: EntityManager, k: SeriesKey, modelId: string, from: Date, to: Date): Promise<ForecastTrace[]> {
    const rows: { stepSeconds: number; horizon: { t: string; v: number; lo: number | null; hi: number | null }[] }[] = await m.query(`
      SELECT "step_seconds" AS "stepSeconds", "horizon" FROM "forecast_daily_sample"
       WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "signal" = $4
         AND "model_id" = $5 AND "day" >= $6::date AND "day" <= $7::date
       ORDER BY "day"`, [k.tenantId, k.sourceSystem, k.externalId, k.signal, modelId, from, to]);
    return rows.map((r) => ({
      stepMs: r.stepSeconds * 1000,
      points: r.horizon.map((p) => ({ t: new Date(p.t).getTime(), v: p.v, lo: p.lo ?? null, hi: p.hi ?? null })),
    }));
  }

  /**
   * How often the (machine, signal) was normal, anomalous or without a band (§2), each
   * residual judged against a band learned from the days before its own — the reader's
   * rule, applied day by day so a day's residuals never teach the band that judges them.
   */
  private async anomalyStates(
    m: EntityManager, k: SeriesKey, modelId: string, from: Date, to: Date, stepMs: number,
  ): Promise<AnomalyTally | null> {
    const rows: { stepAt: Date; lead: number; residual: number; operating: boolean | null }[] = await m.query(`
      SELECT "step_at" AS "stepAt", "lead_steps" AS "lead", "residual", "operating" FROM "forecast_residual"
       WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "signal" = $4 AND "model_id" = $5
         AND "step_at" < $6
       ORDER BY "step_at"`, [k.tenantId, k.sourceSystem, k.externalId, k.signal, modelId, to]);
    const inWindow = rows.filter((r) => new Date(r.stepAt) >= from);
    if (!inWindow.length) return null;
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: k.tenantId, sourceSystem: k.sourceSystem, externalId: k.externalId },
    });
    if (!profile) return null;
    const dirty = await this.forecasts.dirtyRanges(m, k.tenantId, profile, k.signal, to);
    const points = rows.map((r) => ({ stepAt: new Date(r.stepAt), lead: r.lead, residual: Number(r.residual), operating: r.operating }));

    const tally: AnomalyTally = {
      normal: 0, anomalous: 0, baseline_not_established: 0, stretches: 0, stretchesWithAlert: 0, stretchesWithWorkOrder: 0,
    };
    const anomalous: number[] = [];
    let day = -1;
    let band = learnBand([], dirty);
    for (const p of points) {
      if (p.stepAt < from) continue;
      const d = Math.floor(p.stepAt.getTime() / DAY_MS);
      if (d !== day) {
        day = d;
        band = learnBand(points.filter((x) => x.stepAt.getTime() < d * DAY_MS), dirty);
      }
      if (!band.established) { tally.baseline_not_established += 1; continue; }
      if (p.residual < band.lo || p.residual > band.hi) {
        tally.anomalous += 1;
        anomalous.push(p.stepAt.getTime());
      } else {
        tally.normal += 1;
      }
    }

    const stretches: { start: number; end: number }[] = [];
    for (const t of anomalous) {
      const last = stretches[stretches.length - 1];
      if (last && t - last.end <= stepMs) last.end = t;
      else stretches.push({ start: t, end: t });
    }
    tally.stretches = stretches.length;
    if (stretches.length) {
      const alerts: { firedAt: Date }[] = await m.query(`
        SELECT e."fired_at" AS "firedAt" FROM "alert_event" e JOIN "alert_rule" r ON r."id" = e."rule_id"
         WHERE e."tenant_id" = $1 AND e."source_system" = $2 AND e."external_id" = $3 AND r."params"->>'signal' = $4`,
      [k.tenantId, k.sourceSystem, k.externalId, k.signal]);
      const orders: { createdAt: Date }[] = await m.query(`
        SELECT "created_at" AS "createdAt" FROM "work_order"
         WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3`,
      [k.tenantId, k.sourceSystem, k.externalId]);
      const within = (at: Date, s: { start: number; end: number }) =>
        at.getTime() >= s.start && at.getTime() <= s.end + stepMs + OVERLAP_AFTER_MS;
      for (const s of stretches) {
        if (alerts.some((a) => within(new Date(a.firedAt), s))) tally.stretchesWithAlert += 1;
        if (orders.some((o) => within(new Date(o.createdAt), s))) tally.stretchesWithWorkOrder += 1;
      }
    }
    return tally;
  }
}

function pool(into: Map<string, Pool>, signal: string, score: SeriesScore): void {
  const p = into.get(signal) ?? { series: 0, byLead: new Map() };
  into.set(signal, p);
  p.series += 1;
  mergeInto(p.byLead, score.byLead);
}

/** All leads pooled into one line, so a reader has one number before 96. Over nothing it
 * is the same shape with every metric null and the reason beside it, never a zero. */
function overall(byLead: Map<number, LeadAccumulator>): Omit<LeadMetrics, 'lead'> & { reason: string | null } {
  const one = new Map<number, LeadAccumulator>([[0, emptyLead()]]);
  for (const [, acc] of byLead) mergeInto(one, new Map([[0, acc]]));
  const { lead: _pooled, ...m } = leadMetrics(one)[0];
  return { ...m, reason: m.n ? null : 'no_scorable_steps' };
}

function allLeads(pools: Map<string, Pool>): Map<number, LeadAccumulator> {
  const all = new Map<number, LeadAccumulator>();
  for (const p of pools.values()) mergeInto(all, p.byLead);
  return all;
}

function seriesMetrics(score: SeriesScore): Record<string, unknown> {
  return {
    traces: score.traces, scale: score.scale,
    overall: overall(score.byLead), byLead: leadMetrics(score.byLead), excluded: score.excluded,
  };
}

function poolSummary(pools: Map<string, Pool>): Record<string, unknown> {
  return Object.fromEntries([...pools].map(([signal, p]) => [signal, {
    series: p.series, overall: overall(p.byLead), byLead: leadMetrics(p.byLead),
  }]));
}

function addTally(into: Map<string, AnomalyTally>, signal: string, t: AnomalyTally): void {
  const a = into.get(signal) ?? {
    normal: 0, anomalous: 0, baseline_not_established: 0, stretches: 0, stretchesWithAlert: 0, stretchesWithWorkOrder: 0,
  };
  into.set(signal, a);
  for (const k of Object.keys(a) as (keyof AnomalyTally)[]) a[k] += t[k];
}
