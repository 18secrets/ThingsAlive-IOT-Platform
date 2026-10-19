import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../kpi/services/kpi-evaluator.service';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { runTenantSpanning, withTenantId } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { overlapping } from '../signal-binding/services/signal-binding.service';
import {
  buildContext, FORECAST_BUDGET_RATIO, FORECAST_CADENCE_MS, FORECAST_PASS_LOCK_KEY, FORECAST_RETENTION_DAYS,
  FORECAST_STEP_SECONDS, intervalAt,
} from './forecast-band';
import {
  ForecastDailySample, ForecastInputBucket, ForecastLatest, ForecastModel, ForecastResidual, ForecastRun,
  ForecastRunOutcome, ForecastRunSkip, HorizonPoint, SkipReason,
} from './forecast.entities';
import { forecastDeclarations, signalInputs } from './forecast-inputs';
import { ForecastReader } from './forecast-reader';
import {
  FORECAST_WORKER, ForecastRequest, ForecastResponse, runWorker, WorkerCommand,
} from './forecast-worker';

export interface PassOptions {
  /** Defaults to a quarter of the cadence (Q4). */
  budgetMs?: number;
  /** Elapsed-time source for the budget; the tests drive it to exhaust the budget on cue. */
  clock?: () => number;
}

export interface PassSummary {
  runId: string;
  outcome: ForecastRunOutcome;
  considered: number;
  forecast: number;
  skipped: number;
  refused: number;
  error: string | null;
}

interface Candidate {
  tenantId: string; profileId: string; sourceSystem: string; externalId: string; signal: string;
  generatedAt: Date | null; contextTo: Date | null; modelId: string | null;
  alertOpen: boolean; alertSince: boolean;
}

interface Prepared {
  c: Candidate;
  profile: EquipmentProfile;
  requirement: EquipmentClassSensorRequirement;
  values: number[];
  coverage: number;
  imputed: number;
  newBuckets: { at: Date; value: number; readings: number }[];
  residuals: { stepAt: Date; lead: number; predicted: number; actual: number; operating: boolean | null }[];
}

interface Skip { c: Candidate; reason: SkipReason; detail?: string }

const HOUR_MS = FORECAST_STEP_SECONDS * 1000;

/**
 * The forecast pass (task QML1; D40, D41). Its own lock, its own ledger, its own entry
 * point (`forecast-main.ts`): it shares nothing in-process with the shift runner, so the
 * day it becomes its own Railway service is a configuration change, not a rewrite.
 *
 * In order: what the library declares (D40 §3) → what is owed (older than the cadence
 * with new readings, or alerted since) → by priority (open alert first; then the oldest
 * forecast — there is no per-tenant recommendation flag on main to rank a middle tier by,
 * QREC1 Q10) → as far as the budget reaches, the rest recorded as `budget_exhausted` →
 * one Python child for every series → written per account, residuals before the forecast
 * they measure is replaced. Nothing is written if the worker fails or answers wrongly.
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);
  private readonly reader = new TelemetryWindowReader();

  constructor(
    private readonly ds: DataSource,
    private readonly kpi: KpiEvaluatorService,
    private readonly forecasts: ForecastReader,
    @Inject(FORECAST_WORKER) private readonly worker: WorkerCommand,
  ) {}

  async runPass(now = new Date(), opts: PassOptions = {}): Promise<PassSummary> {
    const budgetMs = opts.budgetMs ?? FORECAST_CADENCE_MS * FORECAST_BUDGET_RATIO;
    const clock = opts.clock ?? Date.now;
    const lock = await tryTakePassLock(this.ds, FORECAST_PASS_LOCK_KEY);
    if (!lock) {
      // Never wait (QML1 §8): the other pass is doing this work, and a queue of passes
      // behind it would all re-do it. Recorded, so a stuck lock shows as a run of these.
      const run = await this.ds.getRepository(ForecastRun).save({
        startedAt: now, finishedAt: now, budgetSeconds: Math.ceil(budgetMs / 1000), modelId: null, outcome: 'lock_held',
      });
      return { runId: run.id, outcome: 'lock_held', considered: 0, forecast: 0, skipped: 0, refused: 0, error: null };
    }
    try {
      return await this.locked(now, budgetMs, clock);
    } finally {
      await lock.release();
    }
  }

  private async locked(now: Date, budgetMs: number, clock: () => number): Promise<PassSummary> {
    const t0 = clock();
    const runs = this.ds.getRepository(ForecastRun);
    const model = await this.ds.getRepository(ForecastModel).findOne({ where: { status: 'active' } });
    const run = await runs.save({
      startedAt: now, budgetSeconds: Math.ceil(budgetMs / 1000), modelId: model?.id ?? null, outcome: 'running' as const,
    });
    const summary: PassSummary = { runId: run.id, outcome: 'completed', considered: 0, forecast: 0, skipped: 0, refused: 0, error: null };
    const finish = async (outcome: ForecastRunOutcome, error: string | null, timing?: ForecastResponse['timing']) => {
      Object.assign(summary, { outcome, error });
      await runs.update(run.id, {
        outcome, error, finishedAt: new Date(now.getTime() + Math.max(0, clock() - t0)),
        considered: summary.considered, forecast: summary.forecast, skipped: summary.skipped, refused: summary.refused,
        pythonLoadSeconds: timing?.loadSeconds ?? null, pythonInferSeconds: timing?.inferSeconds ?? null,
      });
      return summary;
    };
    if (!model) return finish('failed', 'no active forecast model');

    try {
      const candidates = await this.enumerate(now);
      summary.considered = candidates.length;

      // Owed by the clock alone, before any per-account read: a forecast younger than the
      // cadence, made by the active model, with no alert since, is not touched (D40, incremental).
      const owed = candidates.filter((c) => !c.generatedAt || c.modelId !== model.id || c.alertSince
        || now.getTime() - c.generatedAt.getTime() >= FORECAST_CADENCE_MS);
      owed.sort((a, b) => Number(b.alertOpen || b.alertSince) - Number(a.alertOpen || a.alertSince)
        || (a.generatedAt?.getTime() ?? 0) - (b.generatedAt?.getTime() ?? 0));

      const hourEnd = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      const prepared: Prepared[] = [];
      const skips: Skip[] = [];
      let exhausted = false;
      for (const c of owed) {
        if (exhausted || clock() - t0 > budgetMs) {
          exhausted = true;
          skips.push({ c, reason: 'budget_exhausted' });
          continue;
        }
        const outcome = await withTenantId(this.ds, c.tenantId, (m) => this.prepare(m, c, model, now, hourEnd));
        if (outcome === null) continue;
        if ('reason' in outcome) skips.push(outcome);
        else prepared.push(outcome);
      }

      let response: ForecastResponse | null = null;
      if (prepared.length) {
        const request: ForecastRequest = {
          contract: 'forecast-request.v1',
          model: { key: model.key, revision: model.revision },
          contextLength: model.contextLength,
          predictionLength: model.predictionLength,
          series: prepared.map((p, i) => ({
            id: `s${i}`, stepSeconds: FORECAST_STEP_SECONDS,
            start: new Date(hourEnd - model.contextLength * HOUR_MS).toISOString(), values: p.values,
          })),
        };
        response = await runWorker(this.worker, request, Math.max(60_000, budgetMs - (clock() - t0)));
        // The weights the worker loaded must be the weights the registry names, or every
        // forecast this pass writes would carry provenance that is not true (QML1 §2).
        if (response.model.weightsSha256 !== model.weightsSha256) {
          return finish('failed', `worker loaded weights ${response.model.weightsSha256}, the registry names ${model.weightsSha256}`, response.timing);
        }
      }

      const byId = new Map((response?.series ?? []).map((s) => [s.id, s.values]));
      const refused = new Map((response?.refused ?? []).map((s) => [s.id, s.reason]));
      const tenants = new Set([...prepared.map((p) => p.c.tenantId), ...skips.map((s) => s.c.tenantId)]);
      for (const tenantId of tenants) {
        await withTenantId(this.ds, tenantId, async (m) => {
          for (const [i, p] of prepared.entries()) {
            if (p.c.tenantId !== tenantId) continue;
            const values = byId.get(`s${i}`);
            if (!values) {
              skips.push({ c: p.c, reason: 'refused', detail: refused.get(`s${i}`) });
              summary.refused += 1;
              continue;
            }
            await this.write(m, p, values, model, run.id, now, hourEnd);
            summary.forecast += 1;
          }
          const own = skips.filter((s) => s.c.tenantId === tenantId);
          if (own.length) {
            await m.getRepository(ForecastRunSkip).insert(own.map((s) => ({
              tenantId, runId: run.id, sourceSystem: s.c.sourceSystem, externalId: s.c.externalId,
              signal: s.c.signal, reason: s.reason, detail: s.detail ?? null,
            })));
          }
          await this.purge(m, tenantId, now);
        });
      }
      summary.skipped = skips.length;
      return finish(exhausted ? 'budget_exhausted' : 'completed', null, response?.timing);
    } catch (err) {
      this.logger.error(`forecast pass failed: ${(err as Error).message}`);
      return finish('failed', (err as Error).message.slice(0, 2000));
    }
  }

  /**
   * Every declared (machine, signal), across accounts, with its latest forecast and any
   * alert on it — the one tenant-spanning read, on the shift runner's pattern. An alert's
   * signal is its rule's; open, or fired since the last forecast, it puts the signal first
   * and re-forecasts it on this tick (D40 §4, "immediate").
   */
  private enumerate(now: Date): Promise<Candidate[]> {
    return runTenantSpanning(this.ds, 'forecast pass: what is declared and owed', async (m) => {
      const rows: Omit<Candidate, 'alertOpen' | 'alertSince'>[] = await m.query(`
        SELECT DISTINCT ON (p."tenant_id", p."source_system", p."external_id", r."measurement_role")
               p."tenant_id" AS "tenantId", p."id" AS "profileId", p."source_system" AS "sourceSystem",
               p."external_id" AS "externalId", r."measurement_role" AS "signal",
               fl."generated_at" AS "generatedAt", fl."context_to" AS "contextTo", fl."model_id" AS "modelId"
          FROM "equipment_profile" p
          JOIN "equipment_class_sensor_requirement" r
            ON r."class_slug" = p."equipment_class_slug" AND r."class_version" = p."class_version" AND r."forecast_enabled"
          LEFT JOIN "forecast_latest" fl
            ON fl."tenant_id" = p."tenant_id" AND fl."source_system" = p."source_system"
           AND fl."external_id" = p."external_id" AND fl."signal" = r."measurement_role"
         WHERE p."status" = 'active'
         ORDER BY p."tenant_id", p."source_system", p."external_id", r."measurement_role"`);
      const alerts: { tenantId: string; sourceSystem: string; externalId: string; signal: string; lastFired: Date; open: boolean }[] =
        await m.query(`
          SELECT e."tenant_id" AS "tenantId", e."source_system" AS "sourceSystem", e."external_id" AS "externalId",
                 ar."params"->>'signal' AS "signal", max(e."fired_at") AS "lastFired", bool_or(e."state" <> 'resolved') AS "open"
            FROM "alert_event" e JOIN "alert_rule" ar ON ar."id" = e."rule_id"
           WHERE e."fired_at" > $1 AND ar."params"->>'signal' IS NOT NULL
           GROUP BY 1, 2, 3, 4`, [new Date(now.getTime() - FORECAST_RETENTION_DAYS * 86_400_000)]);
      const k = (x: { tenantId: string; sourceSystem: string; externalId: string; signal: string }) =>
        `${x.tenantId}|${x.sourceSystem}|${x.externalId}|${x.signal}`;
      const byKey = new Map(alerts.map((a) => [k(a), a]));
      return rows.map((r) => {
        const a = byKey.get(k(r));
        const generatedAt = r.generatedAt ? new Date(r.generatedAt) : null;
        return {
          ...r, generatedAt, contextTo: r.contextTo ? new Date(r.contextTo) : null,
          alertOpen: !!a?.open,
          alertSince: !!a && !!generatedAt && new Date(a.lastFired) > generatedAt,
        };
      });
    });
  }

  /** One (machine, signal): fit to forecast, and its input — or why not, or null when it is not owed after all. */
  private async prepare(
    m: EntityManager, c: Candidate, model: ForecastModel, now: Date, hourEnd: number,
  ): Promise<Prepared | Skip | null> {
    const profile = await m.getRepository(EquipmentProfile).findOne({ where: { id: c.profileId, tenantId: c.tenantId } });
    if (!profile) return null;
    const requirement = (await forecastDeclarations(m, profile.equipmentClassSlug, profile.classVersion))
      .find((r) => r.measurementRole === c.signal);
    if (!requirement) return null;

    const input = (await signalInputs(m, c.tenantId, profile, [requirement], now)).get(c.signal)!;
    if (input.state !== 'ready') return { c, reason: input.state };
    // Older than the cadence but nothing new to say: not owed (D40, incremental).
    if (c.contextTo && c.modelId === model.id && !c.alertSince && input.lastReadingAt && input.lastReadingAt < c.contextTo) {
      return null;
    }

    const key = { tenantId: c.tenantId, sourceSystem: c.sourceSystem, externalId: c.externalId, signal: c.signal };
    const contextFrom = hourEnd - model.contextLength * HOUR_MS;
    const stored = await m.getRepository(ForecastInputBucket).createQueryBuilder('b')
      .where('b.tenant_id = :tenantId AND b.source_system = :sourceSystem AND b.external_id = :externalId AND b.signal = :signal', key)
      .andWhere('b.bucket_at >= :from', { from: new Date(contextFrom) })
      .getMany();
    const [{ last }] = await m.query(
      `SELECT max("bucket_at") AS "last" FROM "forecast_input_bucket"
        WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "signal" = $4`,
      [c.tenantId, c.sourceSystem, c.externalId, c.signal],
    );
    // Incremental (Q5): only raw readings after the newest stored bucket are read. Buckets
    // are stored only once their hour has ended, so a stored hour is complete. A reading
    // that arrives late for an hour already rolled up is not folded back in.
    const readFrom = Math.max(last ? new Date(last).getTime() + HOUR_MS : contextFrom, contextFrom);
    const buckets = new Map(stored.map((b) => [b.bucketAt.getTime(), b.value]));
    const newBuckets: Prepared['newBuckets'] = [];
    if (readFrom < hourEnd) {
      const segs = overlapping(input.segments, new Date(readFrom), new Date(hourEnd));
      const read = await this.reader.readBucketedSegments(
        m, c.tenantId, segs.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })),
        FORECAST_STEP_SECONDS, new Date(readFrom), new Date(hourEnd - 1),
      );
      for (const b of read.get(c.signal) ?? []) {
        if (b.bucket.getTime() >= hourEnd) continue;
        buckets.set(b.bucket.getTime(), b.avg);
        newBuckets.push({ at: b.bucket, value: b.avg, readings: b.count });
      }
    }

    const context = buildContext(buckets, contextFrom, model.contextLength, HOUR_MS);
    if ('reason' in context) return { c, reason: context.reason, detail: `input coverage ${context.coverage.toFixed(3)}` };

    // The previous forecast's elapsed steps, against what actually happened (§5), before
    // this pass replaces it. Only a forecast from the active model: a residual against a
    // retired model says nothing about this one's errors (Q10).
    const residuals: Prepared['residuals'] = [];
    const previous = c.modelId === model.id ? await m.getRepository(ForecastLatest).findOne({ where: key }) : null;
    if (previous) {
      for (const [i, p] of previous.horizon.entries()) {
        const t = new Date(p.t).getTime();
        if (t >= hourEnd) break;
        const actual = buckets.get(t);
        if (actual !== undefined) residuals.push({ stepAt: new Date(t), lead: i + 1, predicted: p.v, actual, operating: null });
      }
      if (residuals.length) {
        const from = residuals[0].stepAt;
        const to = new Date(residuals[residuals.length - 1].stepAt.getTime() + HOUR_MS);
        const gate = await this.kpi.loadOperatingGate(
          m, c.tenantId, { sourceSystem: c.sourceSystem, externalId: c.externalId }, from, to,
        );
        // An hour counts as operating when its midpoint is inside an operating period (Q12).
        for (const r of residuals) {
          const mid = r.stepAt.getTime() + HOUR_MS / 2;
          r.operating = gate.scheduled ? gate.periods.some((x) => mid >= x.start.getTime() && mid < x.end.getTime()) : null;
        }
      }
    }
    const ok = context as Extract<typeof context, { ok: true }>;
    return { c, profile, requirement, values: ok.values, coverage: ok.coverage, imputed: ok.imputed, newBuckets, residuals };
  }

  private async write(
    m: EntityManager, p: Prepared, values: number[], model: ForecastModel, runId: string, now: Date, hourEnd: number,
  ): Promise<void> {
    const key = { tenantId: p.c.tenantId, sourceSystem: p.c.sourceSystem, externalId: p.c.externalId, signal: p.c.signal };
    if (p.newBuckets.length) {
      await m.createQueryBuilder().insert().into(ForecastInputBucket)
        .values(p.newBuckets.map((b) => ({ ...key, bucketAt: b.at, value: b.value, readings: b.readings })))
        .orUpdate(['value', 'readings'], ['tenant_id', 'source_system', 'external_id', 'signal', 'bucket_at'])
        .execute();
    }
    if (p.residuals.length) {
      await m.createQueryBuilder().insert().into(ForecastResidual)
        .values(p.residuals.map((r) => ({
          ...key, modelId: model.id, runId, stepAt: r.stepAt, leadSteps: r.lead,
          predicted: r.predicted, actual: r.actual, residual: r.actual - r.predicted, operating: r.operating,
        })))
        .orIgnore().execute();
    }

    const band = await this.forecasts.band(m, key.tenantId, p.profile, key.signal, model.id, now);
    const steps = Math.min(model.predictionLength, p.requirement.forecastHorizonHours ?? model.predictionLength);
    const horizon: HorizonPoint[] = values.slice(0, steps).map((v, i) => ({
      t: new Date(hourEnd + i * HOUR_MS).toISOString(), v, ...intervalAt(band, i + 1, v),
    }));
    const row = {
      ...key, modelId: model.id, runId, generatedAt: now, stepSeconds: FORECAST_STEP_SECONDS,
      contextFrom: new Date(hourEnd - model.contextLength * HOUR_MS), contextTo: new Date(hourEnd),
      inputCoverage: p.coverage, imputedSteps: p.imputed, horizon,
    };
    await m.createQueryBuilder().insert().into(ForecastLatest).values(row)
      .orUpdate(
        ['model_id', 'run_id', 'generated_at', 'step_seconds', 'context_from', 'context_to', 'input_coverage', 'imputed_steps', 'horizon'],
        ['tenant_id', 'source_system', 'external_id', 'signal'],
      )
      .execute();
    // The first pass after 00:00 UTC keeps the day's full forecast for QEVAL1; the rest of
    // the day's passes find it there.
    await m.createQueryBuilder().insert().into(ForecastDailySample)
      .values({
        ...key, day: now.toISOString().slice(0, 10), modelId: model.id, runId, generatedAt: now,
        stepSeconds: FORECAST_STEP_SECONDS, horizon: values.map((v, i) => ({ t: new Date(hourEnd + i * HOUR_MS).toISOString(), v, lo: null, hi: null })),
      })
      .orIgnore().execute();
  }

  /** D14's hot window for what the pass accumulates (Q9). `forecast_latest` is replaced, not aged. */
  private async purge(m: EntityManager, tenantId: string, now: Date): Promise<void> {
    const before = new Date(now.getTime() - FORECAST_RETENTION_DAYS * 86_400_000);
    await m.query(`DELETE FROM "forecast_residual" WHERE "tenant_id" = $1 AND "step_at" < $2`, [tenantId, before]);
    await m.query(`DELETE FROM "forecast_input_bucket" WHERE "tenant_id" = $1 AND "bucket_at" < $2`, [tenantId, before]);
    await m.query(`DELETE FROM "forecast_daily_sample" WHERE "tenant_id" = $1 AND "day" < $2::date`, [tenantId, before]);
    await m.query(`DELETE FROM "forecast_run_skip" WHERE "tenant_id" = $1 AND "created_at" < $2`, [tenantId, before]);
  }
}
