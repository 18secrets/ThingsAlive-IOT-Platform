import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../kpi/services/kpi-evaluator.service';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { runTenantSpanning, withTenantId } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { overlapping } from '../signal-binding/services/signal-binding.service';
import {
  buildContext, FORECAST_BUDGET_RATIO, FORECAST_CADENCE_MS, FORECAST_PASS_LOCK_KEY, FORECAST_RETENTION_DAYS,
  FORECAST_STEP_SECONDS,
} from './forecast-band';
import { ForecastModel, ForecastResidual, ForecastRun, ForecastRunOutcome, ForecastRunSkip } from './forecast.entities';
import { forecastDeclarations, signalInputs } from './forecast-inputs';
import { FORECAST_WORKER, ForecastRequest, ForecastResponse, runWorker, WorkerCommand } from './forecast-worker';

/**
 * How far back the replay starts: the band's whole hot window (FORECAST_RETENTION_DAYS),
 * since residuals older than that are purged and never read. Not the fourteen days the
 * band needs: a machine that runs on some days and not others finds its fourteen steady
 * days over months, not weeks. On dev's fleet, 21 days gave 9 machines a fuel band and
 * 90 gave 29. A signal whose history is shorter replays what it has.
 */
export const WARM_START_DAYS = FORECAST_RETENTION_DAYS;
/**
 * Signals replayed per run. Ten at 90 days is about 5,400 past forecasts, a couple of
 * minutes of model time (TTM measured 14 ms a series in a batch on dev), so a run ends
 * well inside the five-minute tick it follows.
 */
export const WARM_START_SERIES_PER_RUN = 10;
/** Past forecasts per worker call: each is a 512-hour context, so a call stays far below the answer limit. */
export const WARM_START_CHUNK = 1500;

const HOUR_MS = FORECAST_STEP_SECONDS * 1000;
/** The pass re-forecasts a signal every cadence, so each forecast is judged on the hours before the next one. */
const STEPS_PER_FORECAST = FORECAST_CADENCE_MS / HOUR_MS;

export interface WarmStartOptions {
  budgetMs?: number;
  clock?: () => number;
  maxSeries?: number;
}

export interface WarmStartSummary {
  runId: string | null;
  outcome: ForecastRunOutcome;
  /** Signals given a band history this run. */
  warmed: number;
  /** Signals with too little history to replay, recorded so they are not tried again. */
  noHistory: number;
  residuals: number;
  error: string | null;
}

interface Owed { tenantId: string; profileId: string; sourceSystem: string; externalId: string; signal: string }

interface Replay {
  o: Owed;
  /** One past forecast per origin: the hour a pass would have run, and its context. */
  forecasts: { origin: number; values: number[] }[];
  actual: Map<number, number>;
  operatingAt: (hourStart: number) => boolean | null;
}

/**
 * The forecast band's history, replayed from a machine's own past (the warm start).
 *
 * The band that turns a forecast into anomaly detection is learned from residuals —
 * forecast against what happened — and the live pass makes one per hour as time passes:
 * fourteen days of steady running before a single verdict (D20). A machine that arrives
 * with months of history should not wait those weeks while the history that would have
 * produced them sits unread.
 *
 * So for each declared signal with no replay yet, this does what the pass would have done
 * had it been running: from three weeks ago, every cadence, a forecast by the active
 * model from the 512 hours of context that moment had — read the way the pass reads them,
 * the same coverage floor and interpolation — judged on the hours until the next one
 * against the hour's actual bucket, with the same operating gate. The residuals are
 * written with `origin = 'backtest'` under a `warm_start` run, so a band learned partly in
 * replay says so. A live residual already stored for an hour is kept; a replay never
 * overwrites what was measured.
 *
 * Its own entry, run after the pass by `forecast-main`, and under the pass's lock: the two
 * never overlap, and the pass's own accounting is untouched by it. All-or-nothing per run
 * — a worker that fails or answers for weights other than the registry's writes nothing.
 */
@Injectable()
export class ForecastWarmStart {
  private readonly logger = new Logger(ForecastWarmStart.name);
  private readonly reader = new TelemetryWindowReader();

  constructor(
    private readonly ds: DataSource,
    private readonly kpi: KpiEvaluatorService,
    @Inject(FORECAST_WORKER) private readonly worker: WorkerCommand,
  ) {}

  async run(now = new Date(), opts: WarmStartOptions = {}): Promise<WarmStartSummary> {
    const budgetMs = opts.budgetMs ?? FORECAST_CADENCE_MS * FORECAST_BUDGET_RATIO;
    const clock = opts.clock ?? Date.now;
    const lock = await tryTakePassLock(this.ds, FORECAST_PASS_LOCK_KEY);
    if (!lock) return { runId: null, outcome: 'lock_held', warmed: 0, noHistory: 0, residuals: 0, error: null };
    try {
      return await this.locked(now, budgetMs, clock, opts.maxSeries ?? WARM_START_SERIES_PER_RUN);
    } finally {
      await lock.release();
    }
  }

  private async locked(now: Date, budgetMs: number, clock: () => number, maxSeries: number): Promise<WarmStartSummary> {
    const t0 = clock();
    const model = await this.ds.getRepository(ForecastModel).findOne({ where: { status: 'active' } });
    const summary: WarmStartSummary = { runId: null, outcome: 'completed', warmed: 0, noHistory: 0, residuals: 0, error: null };
    if (!model) return summary;
    const owed = await this.owed(model.id, maxSeries);
    // Nothing owed is the steady state once every signal has been replayed: no ledger row for it.
    if (!owed.length) return summary;

    const runs = this.ds.getRepository(ForecastRun);
    const run = await runs.save({
      startedAt: now, budgetSeconds: Math.ceil(budgetMs / 1000), modelId: model.id, outcome: 'running' as const, kind: 'warm_start' as const,
    });
    summary.runId = run.id;
    const finish = async (outcome: ForecastRunOutcome, error: string | null) => {
      Object.assign(summary, { outcome, error });
      await runs.update(run.id, {
        outcome, error, finishedAt: new Date(now.getTime() + Math.max(0, clock() - t0)),
        considered: owed.length, forecast: summary.warmed, skipped: summary.noHistory,
      });
      return summary;
    };

    try {
      const hourEnd = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      const replays: Replay[] = [];
      const empty: Owed[] = [];
      let exhausted = false;
      for (const o of owed) {
        if (clock() - t0 > budgetMs) { exhausted = true; break; }
        const r = await withTenantId(this.ds, o.tenantId, (m) => this.prepare(m, o, model, now, hourEnd));
        if (r?.forecasts.length) replays.push(r);
        else empty.push(o);
      }

      // Every past forecast through the worker, in chunks, before anything is written.
      const jobs = replays.flatMap((r, i) => r.forecasts.map((f, j) => ({ id: `w${i}_${j}`, f })));
      const answers = new Map<string, number[]>();
      for (let k = 0; k < jobs.length; k += WARM_START_CHUNK) {
        const chunk = jobs.slice(k, k + WARM_START_CHUNK);
        const request: ForecastRequest = {
          contract: 'forecast-request.v1',
          model: { key: model.key, revision: model.revision },
          contextLength: model.contextLength,
          predictionLength: model.predictionLength,
          series: chunk.map(({ id, f }) => ({
            id, stepSeconds: FORECAST_STEP_SECONDS,
            start: new Date(f.origin - model.contextLength * HOUR_MS).toISOString(), values: f.values,
          })),
        };
        const response: ForecastResponse = await runWorker(this.worker, request, Math.max(60_000, budgetMs - (clock() - t0)));
        if (response.model.weightsSha256 !== model.weightsSha256) {
          return finish('failed', `worker loaded weights ${response.model.weightsSha256}, the registry names ${model.weightsSha256}`);
        }
        for (const s of response.series) answers.set(s.id, s.values);
      }

      for (const [i, r] of replays.entries()) {
        const rows: Partial<ForecastResidual>[] = [];
        for (const [j, f] of r.forecasts.entries()) {
          const values = answers.get(`w${i}_${j}`);
          if (!values) continue;
          for (let step = 0; step < STEPS_PER_FORECAST; step++) {
            const t = f.origin + step * HOUR_MS;
            if (t >= hourEnd) break;
            const actual = r.actual.get(t);
            if (actual === undefined) continue;
            rows.push({
              tenantId: r.o.tenantId, sourceSystem: r.o.sourceSystem, externalId: r.o.externalId, signal: r.o.signal,
              modelId: model.id, runId: run.id, stepAt: new Date(t), leadSteps: step + 1,
              predicted: values[step], actual, residual: actual - values[step],
              operating: r.operatingAt(t), origin: 'backtest',
            });
          }
        }
        if (!rows.length) { empty.push(r.o); continue; }
        await withTenantId(this.ds, r.o.tenantId, async (m) => {
          for (let k = 0; k < rows.length; k += 1000) {
            await m.createQueryBuilder().insert().into(ForecastResidual).values(rows.slice(k, k + 1000)).orIgnore().execute();
          }
        });
        summary.warmed += 1;
        summary.residuals += rows.length;
      }

      for (const o of empty) {
        await withTenantId(this.ds, o.tenantId, (m) => m.getRepository(ForecastRunSkip).insert({
          tenantId: o.tenantId, runId: run.id, sourceSystem: o.sourceSystem, externalId: o.externalId, signal: o.signal,
          reason: 'warm_start_no_history', detail: `no ${WARM_START_DAYS}-day replay possible: too little context`,
        }));
      }
      summary.noHistory = empty.length;
      return finish(exhausted ? 'budget_exhausted' : 'completed', null);
    } catch (err) {
      this.logger.error(`forecast warm start failed: ${(err as Error).message}`);
      return finish('failed', (err as Error).message.slice(0, 2000));
    }
  }

  /**
   * Declared signals with no replay yet under the active model, and none already found to
   * have too little history. Tenant-spanning, as the pass's own enumeration is.
   */
  private owed(modelId: string, limit: number): Promise<Owed[]> {
    return runTenantSpanning(this.ds, 'forecast warm start: what is owed', (m) => m.query(`
      SELECT DISTINCT p."tenant_id" AS "tenantId", p."id" AS "profileId", p."source_system" AS "sourceSystem",
             p."external_id" AS "externalId", r."measurement_role" AS "signal"
        FROM "equipment_profile" p
        JOIN "equipment_class_sensor_requirement" r
          ON r."class_slug" = p."equipment_class_slug" AND r."class_version" = p."class_version" AND r."forecast_enabled"
       WHERE p."status" = 'active'
         AND NOT EXISTS (SELECT 1 FROM "forecast_residual" x
                          WHERE x."tenant_id" = p."tenant_id" AND x."source_system" = p."source_system"
                            AND x."external_id" = p."external_id" AND x."signal" = r."measurement_role"
                            AND x."model_id" = $1 AND x."origin" = 'backtest')
         AND NOT EXISTS (SELECT 1 FROM "forecast_run_skip" s
                          WHERE s."tenant_id" = p."tenant_id" AND s."source_system" = p."source_system"
                            AND s."external_id" = p."external_id" AND s."signal" = r."measurement_role"
                            AND s."reason" = 'warm_start_no_history')
       ORDER BY 1, 4, 5
       LIMIT $2`, [modelId, limit]));
  }

  /** One signal's past: its hourly buckets, the forecasts the pass would have made, and the operating gate. */
  private async prepare(m: EntityManager, o: Owed, model: ForecastModel, now: Date, hourEnd: number): Promise<Replay | null> {
    const profile = await m.getRepository(EquipmentProfile).findOne({ where: { id: o.profileId, tenantId: o.tenantId } });
    if (!profile) return null;
    const requirement = (await forecastDeclarations(m, profile.equipmentClassSlug, profile.classVersion))
      .find((r) => r.measurementRole === o.signal);
    if (!requirement) return null;
    const input = (await signalInputs(m, o.tenantId, profile, [requirement], now)).get(o.signal)!;
    if (!input.segments.length) return null;

    const firstOrigin = hourEnd - WARM_START_DAYS * 24 * HOUR_MS;
    const readFrom = firstOrigin - model.contextLength * HOUR_MS;
    const segs = overlapping(input.segments, new Date(readFrom), new Date(hourEnd));
    const read = await this.reader.readBucketedSegments(
      m, o.tenantId, segs.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })),
      FORECAST_STEP_SECONDS, new Date(readFrom), new Date(hourEnd - 1),
    );
    const actual = new Map((read.get(o.signal) ?? []).filter((b) => b.bucket.getTime() < hourEnd)
      .map((b) => [b.bucket.getTime(), b.avg]));

    const forecasts: Replay['forecasts'] = [];
    for (let origin = firstOrigin; origin + HOUR_MS <= hourEnd; origin += FORECAST_CADENCE_MS) {
      const context = buildContext(actual, origin - model.contextLength * HOUR_MS, model.contextLength, HOUR_MS);
      if ('reason' in context) continue;
      forecasts.push({ origin, values: (context as Extract<typeof context, { ok: true }>).values });
    }

    // An hour counts as operating when its midpoint is inside an operating period (Q12), as in the pass.
    const gate = await this.kpi.loadOperatingGate(
      m, o.tenantId, { sourceSystem: o.sourceSystem, externalId: o.externalId }, new Date(firstOrigin), new Date(hourEnd),
    );
    const operatingAt = (t: number) => (gate.scheduled
      ? gate.periods.some((x) => t + HOUR_MS / 2 >= x.start.getTime() && t + HOUR_MS / 2 < x.end.getTime())
      : null);
    return { o, forecasts, actual, operatingAt };
  }
}
