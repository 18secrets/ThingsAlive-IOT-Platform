import { Injectable } from '@nestjs/common';
import { EntityManager, MoreThan } from 'typeorm';
import { ExcludedRange, openWorkOrderExcludedRanges } from '../catalog/formula/baseline-operators';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../kpi/services/kpi-evaluator.service';
import { WorkOrder } from '../work/entities/work-order.entity';
import {
  Band, FORECAST_CADENCE_MS, FORECAST_RETENTION_DAYS, learnBand, ResidualPoint,
} from './forecast-band';
import { ForecastLatest, ForecastModel, ForecastResidual, HorizonPoint } from './forecast.entities';
import { forecastDeclarations, signalInputs } from './forecast-inputs';

export type AnomalyState = 'normal' | 'anomalous' | 'baseline_not_established';

export interface ForecastChartData {
  signal: string;
  unit: string | null;
  stepSeconds: number;
  generatedAt: string;
  model: { key: string; revision: string };
  runId: string;
  horizon: HorizonPoint[];
  anomaly: {
    state: AnomalyState;
    /** Why a band does not exist yet, when it does not. */
    baselineReason: 'baseline_not_established' | 'no_shift_schedule' | null;
    at: string | null; actual: number | null; predicted: number | null; residual: number | null;
    band: { lo: number; hi: number; n: number; learnedFrom: string; learnedTo: string } | null;
  };
}

export type ForecastChartAnswer =
  | { readiness: 'ready'; data: ForecastChartData }
  | { readiness: 'not_configured' | 'not_available' | 'blocked'; reason: string };

/** Q13: older than the cadence plus one tick means the pass has missed it at least once. */
export function forecastStaleAfterMs(tickSeconds: number): number {
  return FORECAST_CADENCE_MS + tickSeconds * 1000;
}

export const DEFAULT_FORECAST_TICK_SECONDS = 300;

/**
 * What the machine page's `forecast_chart` shows (QML1 §7). It reads; it never invokes
 * the model (the page composes, QPAGE1).
 *
 * D26 read strictly: a future number appears with its interval or not at all. The
 * interval comes from the residual band, so while the band is `baseline_not_established`
 * — every machine's first 14 days, and any machine after a model change — the chart says
 * so instead of drawing a forecast with nothing to bound it (Q7).
 */
@Injectable()
export class ForecastReader {
  private readonly staleAfterMs = forecastStaleAfterMs(
    Number(process.env.FORECAST_TICK_SECONDS ?? DEFAULT_FORECAST_TICK_SECONDS),
  );

  constructor(private readonly kpi: KpiEvaluatorService) {}

  async chart(m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, at: Date): Promise<ForecastChartAnswer> {
    const declared = (await forecastDeclarations(m, profile.equipmentClassSlug, profile.classVersion))
      .find((r) => r.measurementRole === signal);
    if (!declared) return { readiness: 'not_configured', reason: 'forecast_not_declared' };

    const key = { tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, signal };
    const latest = await m.getRepository(ForecastLatest).findOne({ where: key });
    if (!latest) return { readiness: 'not_available', reason: 'no_forecast_model' };

    const input = (await signalInputs(m, tenantId, profile, [declared], at)).get(signal)!;
    if (input.state === 'unbound') return { readiness: 'not_configured', reason: 'unbound' };
    if (input.state !== 'ready') return { readiness: 'blocked', reason: input.state };
    if (at.getTime() - latest.generatedAt.getTime() > this.staleAfterMs) return { readiness: 'blocked', reason: 'stale' };
    if (latest.horizon.some((p) => p.lo === null || p.hi === null)) {
      return { readiness: 'not_available', reason: 'baseline_not_established' };
    }

    const model = await m.getRepository(ForecastModel).findOne({ where: { id: latest.modelId } });
    const anomaly = await this.anomaly(m, tenantId, profile, signal, latest.modelId, at);
    return {
      readiness: 'ready',
      data: {
        signal, unit: declared.canonicalUnit, stepSeconds: latest.stepSeconds, generatedAt: latest.generatedAt.toISOString(),
        model: { key: model!.key, revision: model!.revision }, runId: latest.runId, horizon: latest.horizon, anomaly,
      },
    };
  }

  /** The newest step with an actual, judged against a band learned from the steps before it (D20). */
  async anomaly(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, modelId: string, at: Date,
  ): Promise<ForecastChartData['anomaly']> {
    const rows = await residualsFor(m, tenantId, profile, signal, modelId, at);
    const newest = rows.length ? rows[rows.length - 1] : null;
    const band = learnBand(rows.slice(0, -1).map(toPoint), await this.dirtyRanges(m, tenantId, profile, signal, at));
    const base = {
      at: newest?.stepAt.toISOString() ?? null, actual: newest?.actual ?? null,
      predicted: newest?.predicted ?? null, residual: newest?.residual ?? null,
    };
    if (!band.established || !newest) {
      return {
        state: 'baseline_not_established', baselineReason: 'reason' in band ? band.reason : 'baseline_not_established',
        ...base, band: null,
      };
    }
    const outside = newest.residual < band.lo || newest.residual > band.hi;
    return {
      state: outside ? 'anomalous' : 'normal', baselineReason: null, ...base,
      band: { lo: band.lo, hi: band.hi, n: band.n, learnedFrom: band.learnedFrom, learnedTo: band.learnedTo },
    };
  }

  /** The band for a (machine, signal, model), as the pass needs it to put intervals on a new forecast. */
  async band(m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, modelId: string, at: Date): Promise<Band> {
    const rows = await residualsFor(m, tenantId, profile, signal, modelId, at);
    return learnBand(rows.map(toPoint), await this.dirtyRanges(m, tenantId, profile, signal, at));
  }

  /**
   * Windows a band must not learn from (D20): alerts on this signal and open work orders
   * on the machine — the KPI baseline's own two rules, called rather than copied.
   */
  async dirtyRanges(m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, at: Date): Promise<ExcludedRange[]> {
    const ref = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };
    const alerts = await this.kpi.loadAlertExcludedRangesBySignal(m, tenantId, ref, profile, [signal], at);
    const orders = await m.getRepository(WorkOrder).find({ where: { tenantId, ...ref } });
    return [
      ...(alerts.get(signal) ?? []),
      ...openWorkOrderExcludedRanges(orders.map((o) => ({
        status: o.status as 'created' | 'in-progress' | 'completed' | 'cancelled',
        startedAt: o.startedAt, createdAt: o.createdAt, endedAt: o.endedAt,
      })), at),
    ];
  }
}

function residualsFor(
  m: EntityManager, tenantId: string, profile: EquipmentProfile, signal: string, modelId: string, at: Date,
): Promise<ForecastResidual[]> {
  return m.getRepository(ForecastResidual).find({
    where: {
      tenantId, sourceSystem: profile.sourceSystem, externalId: profile.externalId, signal, modelId,
      stepAt: MoreThan(new Date(at.getTime() - FORECAST_RETENTION_DAYS * 86_400_000)),
    },
    order: { stepAt: 'ASC' },
  });
}

const toPoint = (r: ForecastResidual): ResidualPoint =>
  ({ stepAt: r.stepAt, lead: r.leadSteps, residual: r.residual, operating: r.operating });
