import { WidgetType } from '../catalog/layout/widget-types';
import { KpiEnvelope, Readiness, SeriesPoint } from '../kpi/types';

/**
 * Who answers each widget, and the shape of its `data` (task QPAGE1 Â§0, Â§4).
 *
 * The page composes; it does not compute. Every widget type names the one producer
 * its number already comes from, and a test fails naming any type in WIDGET_TYPES
 * that has no entry â€” the same pattern as QCE2's executor registry and QGRANT0's
 * inventory. A `Record<WidgetType, â€¦>` makes a missing entry a compile error too.
 */
export const WIDGET_PRODUCERS: Readonly<Record<WidgetType, string>> = Object.freeze({
  kpi_number: 'KpiEvaluatorService.evaluateAll',
  kpi_gauge: 'KpiEvaluatorService.evaluateAll',
  kpi_chart: 'KpiEvaluatorService.evaluateAll',
  signal_chart: 'TelemetryWindowReader.readBucketed',
  readiness_list: 'SignalBindingService.coverage',
  alert_list: 'AlertService.listEvents',
  work_order_list: 'WorkOrderService.list',
  service_due: 'ServiceForecastService.fleetForecast',
  failure_modes: 'client_equipment_class_failure_mode (QREC0a), status via AlertService.listEvents',
  recommendations: 'client_equipment_class_recommendation (QREC0a)',
  machine_list: 'SignalBindingService.coverage per machine, AlertService.listEvents',
  schematic: 'none until QREC0c',
});

export type PageReadiness = Readiness;

/** Reasons the page adds to the evaluator's own, each a state rather than an answer. */
export type PageReason = string;

export interface KpiWidgetData extends KpiEnvelope {
  target: number | null;
  targetMin: number | null;
  targetMax: number | null;
  targetDirection: string;
}

export interface SignalChartData { signal: string; unit: string | null; points: SeriesPoint[] }

export interface ReadinessRow {
  signal: string;
  /** Present because a composite machine requires one role per component; without it
   * two rows for the same signal would be indistinguishable. */
  componentScope: string;
  readiness: PageReadiness;
  reason: string | null;
  lastReadingAt: string | null;
  secondsSinceLastReading: number | null;
}

export interface AlertRow {
  id: string;
  severity: string;
  raisedAt: string;
  /** From the rule that raised it â€” `alert_event` carries no signal of its own. */
  signal: string | null;
  message: string;
  acknowledged: boolean;
}

export interface WorkOrderRow { id: string; status: string; title: string; assignedTo: string | null; dueAt: string | null }

export interface ServiceDueData { nextDueAt: string | null; hoursRemaining: number | null; basis: string | null }

export type FailureModeStatus = 'active' | 'clear' | 'unknown';

export interface FailureModeRow {
  code: string; name: string; symptom: string; severity: string | null; signals: string[]; status: FailureModeStatus;
}

export interface RecommendationRow {
  failureModeCode: string; action: string; urgency: string; estimatedHours: number | null;
}

export interface MachineRow {
  sourceSystem: string; externalId: string; name: string | null; readiness: PageReadiness; openAlerts: number;
}

export interface SiteKpiData {
  value: number | null;
  unit: string | null;
  aggregate: string;
  machinesIncluded: number;
  machinesExcluded: number;
  /** Separately, because a mixed fleet is normal and the two mean different things. */
  excluded: { notDeclared: number; notReady: number };
}

export type WidgetData =
  | KpiWidgetData | SignalChartData | ReadinessRow[] | AlertRow[] | WorkOrderRow[] | ServiceDueData
  | FailureModeRow[] | RecommendationRow[] | MachineRow[] | SiteKpiData;

export interface PageWidget {
  widgetKey: string;
  widgetType: WidgetType;
  title: string | null;
  position: number;
  size: string;
  /** Always null unless readiness is 'ready' â€” never 0, never [] standing in for nothing. */
  data: WidgetData | null;
  readiness: PageReadiness;
  reason?: PageReason;
}

/** A widget that cannot be filled still appears, carrying why. */
export const unfilled = <W extends Omit<PageWidget, 'data' | 'readiness' | 'reason'>>(
  w: W, readiness: Exclude<PageReadiness, 'ready'>, reason: PageReason,
): PageWidget => ({ ...w, data: null, readiness, reason });

export const filled = <W extends Omit<PageWidget, 'data' | 'readiness' | 'reason'>>(w: W, data: WidgetData): PageWidget =>
  ({ ...w, data, readiness: 'ready' });

/** Worst first â€” what a machine's single readiness reports when its signals disagree. */
export const READINESS_SEVERITY: Readonly<Record<PageReadiness, number>> = {
  ready: 0, not_available: 1, blocked: 2, not_configured: 3,
};

/**
 * One signal's readiness from the coverage result â€” the same mapping the evaluator
 * applies to a KPI's input (kpi-evaluator.service.ts `signalStatus`): unbound is
 * not_configured; no readings and stale are not_available. Restated here, not
 * re-derived, because the evaluator's is private and that file is shared with
 * Stream B until QPARAM1 merges; when it does, the evaluator should call this.
 */
export function signalReadiness(
  bound: boolean, freshness: 'ready' | 'stale' | 'no_readings',
): { readiness: PageReadiness; reason: string | null } {
  if (!bound) return { readiness: 'not_configured', reason: 'unbound' };
  if (freshness === 'no_readings') return { readiness: 'not_available', reason: 'no_readings' };
  if (freshness === 'stale') return { readiness: 'not_available', reason: 'stale' };
  return { readiness: 'ready', reason: null };
}
