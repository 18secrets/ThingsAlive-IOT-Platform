import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { Severity } from '../../common/severity';
import { WORK_RAISER, WorkRaiser } from '../work-raiser';
import {
  influenceModelFrom, InfluenceOutcome, Sample, scoreInfluence,
} from './influence';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { EquipmentScenario } from '../../activation/entities/equipment-scenario.entity';
import { ClientScenario } from '../../client-catalog/entities/client-scenario.entity';
import { Prediction, PredictionSource } from '../entities/prediction.entity';
import { PredictionBaseline } from '../entities/prediction-baseline.entity';
import { DEFAULT_WINDOW_DAYS } from './baseline.service';
import {
  Confidence, DEFAULT_CRITICAL_SIGMA, DEFAULT_MINIMUM_SAMPLES, DEFAULT_WARNING_SIGMA,
  SignalObservation, scoreTier1,
} from './tier1';

/** How much of the recent past an influence model is scored over. A shift, give or take. */
export const DEFAULT_INFLUENCE_WINDOW_HOURS = 12;

/** So one fast logger cannot pull a million rows into memory for one score. */
const INFLUENCE_SAMPLE_CAP = 20_000;

export type SkipReason = 'no-device' | 'no-readings' | 'scenario-missing' | 'scenario-disabled';

export interface ScoreResult {
  written: Prediction[];
  /** Scenarios that were active but produced nothing, each with the reason. */
  skipped: { clientScenarioSlug: string; reason: SkipReason }[];
  /**
   * Jobs raised by this run. Usually empty, and empty is not the same as "nothing
   * was critical" — a machine already carrying a live job for the same scenario
   * raises nothing, which is the point of the de-duplication.
   */
  raised: { clientScenarioSlug: string; workOrderId: string }[];
}

interface LatestRow {
  signal: string;
  value: number;
  source_timestamp: Date;
  source: string;
}

/**
 * Scoring an asset's active scenarios and storing the outcomes (tasks P1-12, P1-14).
 *
 * Only `active` scenarios are scored. A proposed or paused one deliberately produces
 * nothing: a paused scenario that kept writing predictions would make pausing a
 * cosmetic act, and somebody would eventually rely on it having stopped.
 *
 * A scenario that cannot be scored is reported as skipped with a reason rather than
 * omitted. An asset that silently produces no predictions looks exactly like one
 * whose predictions are all fine, and that ambiguity is the expensive kind.
 */
@Injectable()
export class PredictionService {
  private readonly logger = new Logger(PredictionService.name);

  constructor(
    private readonly ds: DataSource,
    @Optional() @Inject(WORK_RAISER) private readonly raiser?: WorkRaiser,
  ) {}

  async scoreAsset(
    scope: RequestScope,
    target: { sourceSystem: string; externalId: string },
    now: Date = new Date(),
  ): Promise<ScoreResult> {
    return withTenantSession(this.ds, scope, async (m) => {
      const active = await m.getRepository(EquipmentScenario).find({
        where: {
          tenantId: scope.tenantId,
          sourceSystem: target.sourceSystem,
          externalId: target.externalId,
          state: 'active',
        },
      });

      const result: ScoreResult = { written: [], skipped: [], raised: [] };
      if (active.length === 0) return result;

      const devices = await m.getRepository(DeviceProjection).find({
        where: {
          tenantId: scope.tenantId,
          sourceSystem: target.sourceSystem,
          equipmentExternalId: target.externalId,
        },
      });
      const imeis = [...new Set(devices.map((d) => d.imei))];

      for (const row of active) {
        const scenario = await m.getRepository(ClientScenario).findOne({
          where: { tenantId: scope.tenantId, slug: row.clientScenarioSlug },
        });

        if (!scenario) {
          result.skipped.push({ clientScenarioSlug: row.clientScenarioSlug, reason: 'scenario-missing' });
          continue;
        }
        // Switched off at the catalog level while still active on this asset. The
        // activation is not wrong — the client may switch the scenario back on — so
        // this is a skip with a reason, not a state change made behind their back.
        if (!scenario.enabled) {
          result.skipped.push({ clientScenarioSlug: row.clientScenarioSlug, reason: 'scenario-disabled' });
          continue;
        }
        if (imeis.length === 0) {
          result.skipped.push({ clientScenarioSlug: row.clientScenarioSlug, reason: 'no-device' });
          continue;
        }

        const written = await this.scoreOne(m, scope, target, row, scenario, imeis, now);
        if (written) {
          result.written.push(written);
          // Raised in this same transaction, deliberately. A prediction that says
          // critical and a job that does not exist is a failure with two halves that
          // each look fine, and it surfaces as "nobody was ever sent" weeks later.
          const raised = await this.raiseWork(m, scope, target, written);
          if (raised) result.raised.push({ clientScenarioSlug: row.clientScenarioSlug, workOrderId: raised });
        }
        else result.skipped.push({ clientScenarioSlug: row.clientScenarioSlug, reason: 'no-readings' });
      }

      return result;
    });
  }

  private async scoreOne(
    m: EntityManager,
    scope: RequestScope,
    target: { sourceSystem: string; externalId: string },
    row: EquipmentScenario,
    scenario: ClientScenario,
    imeis: string[],
    now: Date,
  ): Promise<Prediction | null> {
    const windowDays = this.numberParam(row, scenario, 'baseline_window_days', DEFAULT_WINDOW_DAYS);
    const signals = scenario.requiredSignals;
    if (signals.length === 0) return null;

    // One row per signal, the most recent by the logger's clock. DISTINCT ON is the
    // reason this is raw SQL: the alternative is a query per signal, which is fine on
    // a fixture and is a hundred round trips on a real asset.
    const latest: LatestRow[] = await m.query(
      `SELECT DISTINCT ON ("signal") "signal", "value", "source_timestamp", "source"
         FROM "telemetry_reading"
        WHERE "tenant_id" = $1 AND "imei" = ANY($2::text[]) AND "signal" = ANY($3::text[])
        ORDER BY "signal", "source_timestamp" DESC`,
      [scope.tenantId, imeis, signals],
    );

    // No reading for any required signal means there is no moment this prediction
    // would be about. A prediction needs an `occurred_at`, and inventing one from the
    // server clock would date the score to now and make a replay write duplicates.
    if (latest.length === 0) return null;

    const observations: SignalObservation[] = latest.map((r) => ({
      signal: r.signal,
      value: Number(r.value),
      at: r.source_timestamp,
    }));

    // Physics before history. A scenario that carries an influence model is asking a
    // better question than a baseline can — "is this machine where its load says it
    // should be" rather than "is this unusual for this machine" — and it can be
    // answered on the first shift instead of after thirty days of it.
    const influence = await this.scoreByInfluence(m, scope, target, row, scenario, imeis, now);
    if (influence) {
      return this.write(m, scope, target, row, influence.occurredAt, {
        severity: influence.severity,
        riskScore: influence.riskScore,
        abnormalCount: influence.outcome.severityLevel === 'none' ? 0 : 1,
        highPriority: influence.outcome.severityLevel === 'critical',
        confidence: influence.outcome.confidence,
        signals: influence.signals,
      }, windowDays, 'influence@1', influence.source, now);
    }

    const baselines = await m.getRepository(PredictionBaseline).find({
      where: {
        tenantId: scope.tenantId,
        sourceSystem: target.sourceSystem,
        externalId: target.externalId,
        windowDays,
      },
    });

    const outcome = scoreTier1({
      requiredSignals: signals,
      observations,
      baselines: baselines.map((b) => ({
        signal: b.signal,
        mean: Number(b.mean),
        stddev: Number(b.stddev),
        sampleCount: b.sampleCount,
      })),
      warningSigma: this.numberParam(row, scenario, 'warning_sigma', DEFAULT_WARNING_SIGMA),
      criticalSigma: this.numberParam(row, scenario, 'critical_sigma', DEFAULT_CRITICAL_SIGMA),
      minimumSamples: this.numberParam(row, scenario, 'minimum_samples', DEFAULT_MINIMUM_SAMPLES),
    });

    const occurredAt = new Date(Math.max(...latest.map((r) => new Date(r.source_timestamp).getTime())));
    // Replayed only when every reading behind the score was replayed. A prediction
    // built partly from live telemetry is a live prediction; labelling it otherwise
    // would let someone dismiss a real one as an artefact of a backfill.
    const source: PredictionSource = latest.every((r) => r.source !== 'live') ? 'replayed' : 'live';

    return this.write(m, scope, target, row, occurredAt, {
      severity: outcome.severity,
      riskScore: outcome.riskScore,
      abnormalCount: outcome.abnormalCount,
      highPriority: outcome.highPriority,
      confidence: outcome.confidence,
      signals: outcome.signals,
    }, windowDays, 'tier1@1', source, now);
  }

  /**
   * Score against the scenario's influence model, if it has one.
   *
   * A separate query from the one the baseline path uses, and it has to be: that one
   * takes the newest reading per signal, and a residual needs the whole window so a
   * target can be paired with the influence that was true at the same moment.
   *
   * Returns null when there is no model, or when nothing in the window could be
   * paired — and the caller then falls back to the baseline scorer rather than
   * reporting nothing. Physics first, history second, silence last.
   */
  private async scoreByInfluence(
    m: EntityManager, scope: RequestScope,
    target: { sourceSystem: string; externalId: string },
    row: EquipmentScenario, scenario: ClientScenario, imeis: string[], now: Date,
  ): Promise<{
    outcome: InfluenceOutcome; severity: Severity; riskScore: number;
    signals: unknown[]; occurredAt: Date; source: PredictionSource;
  } | null> {
    const model = influenceModelFrom(scenario.parameters as any, row.parameterOverrides as any);
    if (!model) return null;

    const hours = this.numberParam(row, scenario, 'influence_window_hours', DEFAULT_INFLUENCE_WINDOW_HOURS);
    const from = new Date(now.getTime() - hours * 3_600_000);
    const wanted = [model.target, ...model.terms.map((t) => t.signal)];

    const rows: { signal: string; value: string; source_timestamp: Date; source: string }[] =
      await m.query(
        `SELECT "signal", "value", "source_timestamp", "source"
           FROM "telemetry_reading"
          WHERE "tenant_id" = $1 AND "imei" = ANY($2::text[]) AND "signal" = ANY($3::text[])
            AND "source_timestamp" > $4 AND "source_timestamp" <= $5
          ORDER BY "source_timestamp" ASC
          LIMIT ${INFLUENCE_SAMPLE_CAP}`,
        [scope.tenantId, imeis, wanted, from, now],
      );
    if (rows.length === 0) return null;

    const samples: Sample[] = rows.map((r) => ({
      signal: r.signal,
      value: Number(r.value),
      at: new Date(r.source_timestamp).getTime(),
    }));
    const outcome = scoreInfluence(model, samples);
    // Not scored means the window could not answer the question this model asks. The
    // baseline scorer asks a different one and may still be able to.
    if (!outcome.scored || !outcome.worst) return null;

    const severity = outcome.severityLevel === 'critical'
      ? Severity.Critical
      : outcome.severityLevel === 'warning' ? Severity.High : Severity.None;

    return {
      outcome,
      severity,
      // Zero when the machine is on its curve — scored and nothing wrong, which is a
      // different statement from unknown. Otherwise the residual as a fraction of the
      // warning threshold, capped, so one very hot reading cannot read as 400%.
      riskScore: outcome.severityLevel === 'none'
        ? 0
        : Math.round(Math.min(100, 50 + 50 * Math.min(1, outcome.exceedance ?? 0))),
      signals: [{
        signal: model.target,
        state: outcome.severityLevel === 'none' ? 'normal' : outcome.severityLevel,
        value: outcome.worst.actual,
        expected: Math.round(outcome.worst.expected * 100) / 100,
        residual: Math.round(outcome.worst.residual * 100) / 100,
        influences: outcome.worst.influences,
        at: new Date(outcome.worst.at).toISOString(),
        samples: outcome.residuals.length,
      }],
      occurredAt: new Date(Math.max(...samples.map((s) => s.at))),
      source: rows.every((r) => r.source !== 'live') ? 'replayed' : 'live',
    };
  }

  /**
   * Write the prediction, whichever scorer produced it.
   *
   * `modelRef` is the only thing that differs between them from here on, and it is the
   * column that makes "which scorer said this" answerable. Two scorers disagreeing
   * about the same asset is a question somebody will ask, and without this it has no
   * answer.
   */
  private async write(
    m: EntityManager, scope: RequestScope,
    target: { sourceSystem: string; externalId: string },
    row: EquipmentScenario, occurredAt: Date,
    verdict: {
      severity: Severity; riskScore: number; abnormalCount: number;
      highPriority: boolean; confidence: Confidence; signals: unknown[];
    },
    windowDays: number, modelRef: string, source: PredictionSource, now: Date,
  ): Promise<Prediction> {
    const [saved]: Prediction[] = await m.query(
      `INSERT INTO "prediction"
         ("tenant_id", "source_system", "external_id", "client_scenario_slug", "occurred_at",
          "severity", "risk_score", "abnormal_count", "high_priority", "confidence",
          "signals", "window_days", "model_ref", "model_tier", "source", "computed_at")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
       ON CONFLICT ("tenant_id", "source_system", "external_id", "client_scenario_slug", "occurred_at")
       DO UPDATE SET
         "severity" = EXCLUDED."severity",
         "risk_score" = EXCLUDED."risk_score",
         "abnormal_count" = EXCLUDED."abnormal_count",
         "high_priority" = EXCLUDED."high_priority",
         "confidence" = EXCLUDED."confidence",
         "signals" = EXCLUDED."signals",
         "window_days" = EXCLUDED."window_days",
         "model_ref" = EXCLUDED."model_ref",
         "model_tier" = EXCLUDED."model_tier",
         "source" = EXCLUDED."source",
         "computed_at" = EXCLUDED."computed_at"
       RETURNING
         "id", "occurred_at" AS "occurredAt", "tenant_id" AS "tenantId",
         "source_system" AS "sourceSystem", "external_id" AS "externalId",
         "client_scenario_slug" AS "clientScenarioSlug", "severity",
         "risk_score" AS "riskScore", "abnormal_count" AS "abnormalCount",
         "high_priority" AS "highPriority", "confidence", "signals",
         "window_days" AS "windowDays", "model_ref" AS "modelRef",
         "model_tier" AS "modelTier", "source", "computed_at" AS "computedAt"`,
      [
        scope.tenantId, target.sourceSystem, target.externalId, row.clientScenarioSlug, occurredAt,
        verdict.severity, verdict.riskScore, verdict.abnormalCount, verdict.highPriority,
        verdict.confidence, JSON.stringify(verdict.signals), windowDays,
        modelRef, 1, source, now,
      ],
    );
    return saved;
  }

  /**
   * Hand the prediction to whoever raises work, if anybody does.
   *
   * A scorer that could not score dispatches nobody: confidence 'none' means the
   * signals were missing or flat, and a fitter sent on the strength of that is a
   * fitter who stops trusting the next one.
   */
  private async raiseWork(
    m: EntityManager, scope: RequestScope,
    target: { sourceSystem: string; externalId: string },
    written: Prediction,
  ): Promise<string | null> {
    if (!this.raiser) return null;
    if (written.confidence === 'none') return null;
    try {
      return await this.raiser.raiseFromPrediction(m, scope, {
        sourceSystem: target.sourceSystem,
        externalId: target.externalId,
        predictionId: written.id,
        clientScenarioSlug: written.clientScenarioSlug,
        severity: written.severity,
        riskScore: written.riskScore,
        occurredAt: written.occurredAt,
      });
    } catch (error) {
      // Deliberately not swallowed quietly and deliberately not fatal either: the
      // prediction is the product and losing it because a job could not be raised
      // would be the wrong trade. Loud enough to find, and the gap is recoverable
      // from the prediction itself.
      this.logger.error(
        `Scored ${target.externalId} but could not raise work: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** The latest prediction per scenario for one asset. */
  async latestFor(
    scope: RequestScope, target: { sourceSystem: string; externalId: string },
  ): Promise<Prediction[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.query(
        `SELECT DISTINCT ON ("client_scenario_slug")
                "id", "occurred_at" AS "occurredAt", "client_scenario_slug" AS "clientScenarioSlug",
                "severity", "risk_score" AS "riskScore", "abnormal_count" AS "abnormalCount",
                "high_priority" AS "highPriority", "confidence", "signals",
                "window_days" AS "windowDays", "model_ref" AS "modelRef", "source",
                "computed_at" AS "computedAt"
           FROM "prediction"
          WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3
          ORDER BY "client_scenario_slug", "occurred_at" DESC`,
        [scope.tenantId, target.sourceSystem, target.externalId],
      ),
    );
  }

  /** The history of one scenario on one asset, newest first. */
  async historyFor(
    scope: RequestScope,
    target: { sourceSystem: string; externalId: string; clientScenarioSlug: string },
    take = 100,
  ): Promise<Prediction[]> {
    if (take < 1 || take > 1000) throw new NotFoundException('take must be between 1 and 1000.');
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(Prediction).find({
        where: {
          tenantId: scope.tenantId,
          sourceSystem: target.sourceSystem,
          externalId: target.externalId,
          clientScenarioSlug: target.clientScenarioSlug,
        },
        order: { occurredAt: 'DESC' },
        take,
      }),
    );
  }

  /**
   * A scenario parameter, as a number, from the asset override or the scenario
   * default. Falls back rather than throwing: a scenario that does not declare a
   * sigma is using the platform's, which is the common case.
   */
  private numberParam(
    row: EquipmentScenario, scenario: ClientScenario, key: string, fallback: number,
  ): number {
    const override = row.parameterOverrides?.[key];
    const declared = scenario.parameters?.find((p) => p.key === key)?.default;
    const value = override ?? declared;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  }
}
