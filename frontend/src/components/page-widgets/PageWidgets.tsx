import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import i18n from '../../i18n';
import { AlertTriangle, Bell, CheckCircle2, Wrench } from 'lucide-react';
import {
  PageWidget, PageKpiWidgetData, PageSignalChartData, PageForecastChartData, PageReadinessRow, PageAlertRow, PageWorkOrderRow,
  PageServiceDueData, PageFailureModeRow, PageRecommendationRow, PageMachineRow, PageSchematicData,
  PageParameterRow, ParameterScope,
} from '../../lib/api';
import { Chip } from '../common/Chip';
import { RingGauge } from '../common/RingGauge';
import { Sparkline } from '../dashboard/Sparkline';

/** Every widget a composed page (machine or site) can render, shared because the
 *  shape — `PageWidget[]` with a `readiness`/`reason` a widget can't fill — is the
 *  same at both levels; only what sits above the widget grid differs. */

/** Reason codes are labelled from the `equipment` namespace's `reason.*` map; an
 *  unknown code shows raw rather than blank. `t` is optional so a caller outside a
 *  component still gets the current language. */
export const reasonText = (reason?: string | null, t?: TFunction) => {
  const tr = t ?? i18n.getFixedT(null, 'equipment');
  return reason ? tr(`equipment:reason.${reason}`, { defaultValue: reason }) : tr('equipment:reason.not_available');
};

const READINESS_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  ready: 'emerald', not_available: 'amber', blocked: 'rose', not_configured: 'slate',
};

const Unfilled: React.FC<{ reason?: string }> = ({ reason }) => {
  const { t } = useTranslation('equipment');
  return <p className="text-xs text-slate-400 dark:text-slate-500">{reasonText(reason, t)}</p>;
};

const WidgetShell: React.FC<{ title: string | null; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
    {title && <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{title}</h3>}
    {children}
  </div>
);

/** Shown under a ready KPI widget when the page offers a drill-down (Equipment Page). */
const ExploreLink: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useTranslation('equipment');
  return (
    <button onClick={onClick} className="text-[11px] font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
      {t('widgets.details')}
    </button>
  );
};

function KpiWidget({ widget, onExplore }: { widget: PageWidget; onExplore?: (formulaKey: string) => void }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageKpiWidgetData;
  const explore = onExplore ? <ExploreLink onClick={() => onExplore(data.formulaKey)} /> : null;
  if (data.resultKind === 'series') {
    const points = (data.value as { t: string; v: number | null }[] ?? []).map((p) => p.v).filter((v): v is number => v != null);
    const latest = points[points.length - 1];
    return (
      <WidgetShell title={widget.title}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">
              {latest != null ? latest.toFixed(2) : '—'} <span className="text-sm font-normal text-slate-400">{data.unit}</span>
            </div>
            <p className="text-[11px] text-slate-400">{data.window.from.slice(0, 10)} – {data.window.to.slice(0, 10)}</p>
          </div>
          {points.length >= 2 && <Sparkline values={points} colorClass="text-sky-600 dark:text-sky-400" />}
        </div>
        {explore}
      </WidgetShell>
    );
  }
  const value = data.value as number | null;
  const showGauge = widget.widgetType === 'kpi_gauge' && data.unit === '%';
  return (
    <WidgetShell title={widget.title}>
      <div className="flex items-center gap-4">
        {showGauge && <RingGauge value={value} />}
        <div>
          <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">
            {value != null ? value.toFixed(2) : '—'} <span className="text-sm font-normal text-slate-400">{data.unit}</span>
          </div>
          {data.target != null && <p className="text-[11px] text-slate-400">{t('widgets.target', { value: data.target, unit: data.unit ?? '' })}</p>}
          {(data.targetMin != null || data.targetMax != null) && (
            <p className="text-[11px] text-slate-400">{t('widgets.range', { min: data.targetMin ?? '—', max: data.targetMax ?? '—', unit: data.unit ?? '' })}</p>
          )}
        </div>
      </div>
      {explore}
    </WidgetShell>
  );
}

function SignalChartWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageSignalChartData;
  const values = data.points.map((p) => p.v).filter((v): v is number => v != null);
  const latest = values[values.length - 1];
  return (
    <WidgetShell title={widget.title ?? data.signal}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">
          {latest != null ? latest.toFixed(2) : '—'} <span className="text-sm font-normal text-slate-400">{data.unit}</span>
        </div>
        {values.length >= 2 && <Sparkline values={values} colorClass="text-sky-600 dark:text-sky-400" />}
      </div>
      <p className="text-[11px] text-slate-400">{t('widgets.last24h')}</p>
    </WidgetShell>
  );
}

const ANOMALY_TONE: Record<PageForecastChartData['anomaly']['state'], 'emerald' | 'rose' | 'slate'> = {
  normal: 'emerald', anomalous: 'rose', baseline_not_established: 'slate',
};

const fmt = (v: number | null | undefined) => (v != null ? v.toFixed(2) : '—');

/** The forecast pass's horizon for one signal, and whether the latest reading sits inside
 *  the band learned from past residuals. The band is never drawn before it exists. */
function ForecastChartWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.forecast')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageForecastChartData;
  const values = data.horizon.map((p) => p.v);
  const hours = Math.round((data.horizon.length * data.stepSeconds) / 3600);
  const { anomaly } = data;
  return (
    <WidgetShell title={widget.title ?? t('widgets.forecast')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">
            {fmt(values[values.length - 1])} <span className="text-sm font-normal text-slate-400">{data.unit}</span>
          </div>
          <p className="text-[11px] text-slate-400">{t('widgets.forecastIn', { signal: data.signal, hours })}</p>
        </div>
        {values.length >= 2 && <Sparkline values={values} colorClass="text-violet-600 dark:text-violet-400" />}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Chip tone={ANOMALY_TONE[anomaly.state]}>{t(`widgets.anomaly.${anomaly.state}`)}</Chip>
        {anomaly.band && anomaly.actual != null && anomaly.predicted != null && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {/* The band bounds the residual (actual − predicted), so the expected reading is
                the prediction plus the band, not the band itself. */}
            {t('widgets.anomalyDetail', {
              actual: fmt(anomaly.actual), predicted: fmt(anomaly.predicted),
              lo: fmt(anomaly.predicted + anomaly.band.lo), hi: fmt(anomaly.predicted + anomaly.band.hi), unit: data.unit ?? '',
            })}
          </span>
        )}
        {!anomaly.band && anomaly.baselineReason === 'no_shift_schedule' && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">{t('widgets.noShiftSchedule')}</span>
        )}
      </div>
      <p className="text-[11px] text-slate-400">
        {t('widgets.forecastAt', { at: new Date(data.generatedAt).toLocaleString(), model: data.model.key })}
      </p>
    </WidgetShell>
  );
}

function ReadinessListWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.signalReadiness')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageReadinessRow[];
  return (
    <WidgetShell title={widget.title ?? t('widgets.signalReadiness')}>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={`${r.signal}-${i}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300 truncate">{r.signal}</span>
            <Chip tone={READINESS_TONE[r.readiness]}>{r.readiness === 'ready' ? t('readiness.ready') : reasonText(r.reason, t)}</Chip>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function AlertListWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  const rows = (widget.data as PageAlertRow[] | null) ?? [];
  return (
    <WidgetShell title={widget.title ?? t('widgets.alerts')}>
      {widget.readiness !== 'ready' ? (
        <Unfilled reason={widget.reason} />
      ) : rows.length === 0 ? (
        <Chip icon={CheckCircle2} tone="emerald">{t('widgets.noOpenAlerts')}</Chip>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div>
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{a.message}</p>
                <p className="text-[11px] text-slate-400">{a.signal ?? t('widgets.noSignal')} · {new Date(a.raisedAt).toLocaleString()}</p>
              </div>
              <Chip icon={AlertTriangle} tone={a.severity === 'critical' ? 'rose' : 'amber'}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}

function WorkOrderListWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  const rows = (widget.data as PageWorkOrderRow[] | null) ?? [];
  return (
    <WidgetShell title={widget.title ?? t('widgets.workOrders')}>
      {widget.readiness !== 'ready' ? (
        <Unfilled reason={widget.reason} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400">{t('widgets.noOpenWorkOrders')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((o) => (
            <div key={o.id} className="flex items-center gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <Wrench className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{o.title}</p>
                <p className="text-[11px] text-slate-400">{t(`workOrderStatus.${o.status}`, { defaultValue: o.status })}{o.dueAt ? ` · ${t('widgets.dueOn', { date: new Date(o.dueAt).toLocaleDateString() })}` : ''}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}

function ServiceDueWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.serviceDue')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageServiceDueData;
  return (
    <WidgetShell title={widget.title ?? t('widgets.serviceDue')}>
      <div className="text-xl font-bold text-slate-800 dark:text-slate-100">
        {data.hoursRemaining != null ? t('widgets.hoursRemaining', { hours: data.hoursRemaining.toFixed(0) }) : '—'}
      </div>
      <p className="text-[11px] text-slate-400">
        {data.nextDueAt ? t('widgets.due', { date: new Date(data.nextDueAt).toLocaleDateString() }) : t('widgets.noDueDate')} · {data.basis ?? t('widgets.basisUnknown')}
      </p>
    </WidgetShell>
  );
}

const FAILURE_TONE: Record<string, 'rose' | 'emerald' | 'slate'> = { active: 'rose', clear: 'emerald', unknown: 'slate' };

function FailureModesWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.failureModes')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageFailureModeRow[];
  return (
    <WidgetShell title={widget.title ?? t('widgets.failureModes')}>
      <div className="space-y-2">
        {rows.map((f) => (
          <div key={f.code} className="flex items-start justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
            <div>
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{f.name}</p>
              <p className="text-[11px] text-slate-400">{f.symptom}</p>
            </div>
            <Chip tone={FAILURE_TONE[f.status]}>{t(`failureStatus.${f.status}`, { defaultValue: f.status })}</Chip>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-slate-400">{t('widgets.noFailureModes')}</p>}
      </div>
    </WidgetShell>
  );
}

function RecommendationsWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.recommendations')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageRecommendationRow[];
  return (
    <WidgetShell title={widget.title ?? t('widgets.recommendations')}>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{r.action}</p>
            <p className="text-[11px] text-slate-400">{t(`urgency.${r.urgency}`, { defaultValue: r.urgency })}{r.estimatedHours != null ? ` · ~${r.estimatedHours}h` : ''}</p>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-slate-400">{t('widgets.noRecommendations')}</p>}
      </div>
    </WidgetShell>
  );
}

function MachineListWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.machines')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageMachineRow[];
  return (
    <WidgetShell title={widget.title ?? t('widgets.machines')}>
      <div className="space-y-1.5">
        {rows.map((m) => (
          <div key={`${m.sourceSystem}/${m.externalId}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300 truncate">{m.name ?? m.externalId}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {m.openAlerts > 0 && <Chip icon={Bell} tone="rose">{m.openAlerts}</Chip>}
              <Chip tone={READINESS_TONE[m.readiness]}>{t(`readiness.${m.readiness}`, { defaultValue: m.readiness })}</Chip>
            </div>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function SchematicWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.schematic')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageSchematicData;
  return (
    <WidgetShell title={widget.title ?? t('widgets.schematic')}>
      <div className="relative rounded-lg overflow-hidden border border-slate-100 dark:border-slate-800">
        <img src={data.imageUrl} alt={widget.title ?? t('widgets.equipmentSchematic')} className="w-full h-auto block" />
        {data.anchors.map((a) => (
          <span
            key={a.signal}
            title={`${a.label ?? a.signal}${a.value != null ? `: ${a.value} ${a.unit ?? ''}` : ` — ${reasonText(a.reason, t)}`}`}
            style={{ left: `${a.hotspotX}%`, top: `${a.hotspotY}%` }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow ${
              a.readiness === 'ready' ? 'bg-emerald-500' : a.readiness === 'blocked' ? 'bg-rose-500' : 'bg-amber-500'
            }`}
          />
        ))}
      </div>
      {data.unplacedSignals.length > 0 && (
        <p className="text-[11px] text-slate-400">{t('widgets.unplacedSignals', { count: data.unplacedSignals.length })}</p>
      )}
    </WidgetShell>
  );
}

/** Keys under `parameterScope.*`; the scope value itself stays the logic. */
const PARAMETER_SCOPES: ParameterScope[] = ['equipment', 'equipment_class', 'site', 'client'];

/** "nominal_fuel_per_hour" -> "Nominal fuel per hour". The catalog has no display labels. */
const humanise = (name: string) => {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatParameterValue = (value: unknown) => {
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

function ParameterListWidget({ widget }: { widget: PageWidget }) {
  const { t } = useTranslation('equipment');
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? t('widgets.parameters')}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageParameterRow[];
  // Cost units are stored as "currency/L"; the account's own currency is itself one of
  // these parameters, so the unit can say "INR/L" whenever it is set.
  const currency = rows.find((r) => r.name === 'currency' && typeof r.value === 'string')?.value as string | undefined;
  const unitText = (unit: string | null) => (unit && currency ? unit.replace(/currency/g, currency) : unit);
  return (
    <WidgetShell title={widget.title ?? t('widgets.parameters')}>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300 truncate" title={r.name}>{humanise(r.name)}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {r.source && r.value != null ? (
                <>
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">
                    {formatParameterValue(r.value)}
                    {r.name !== 'currency' && unitText(r.unit) && <span className="font-sans font-normal text-slate-400"> {unitText(r.unit)}</span>}
                  </span>
                  <Chip tone="slate">{PARAMETER_SCOPES.includes(r.source.scope) ? t(`parameterScope.${r.source.scope}`) : r.source.scope}</Chip>
                </>
              ) : (
                <span className="text-slate-400 dark:text-slate-500">{t('widgets.notSet')}</span>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-slate-400">{t('widgets.noParameters')}</p>}
      </div>
    </WidgetShell>
  );
}

export function Widget({ widget, onExploreKpi }: { widget: PageWidget; onExploreKpi?: (formulaKey: string) => void }) {
  const { t } = useTranslation('equipment');
  switch (widget.widgetType) {
    case 'kpi_number': case 'kpi_gauge': case 'kpi_chart': return <KpiWidget widget={widget} onExplore={onExploreKpi} />;
    case 'signal_chart': return <SignalChartWidget widget={widget} />;
    case 'readiness_list': return <ReadinessListWidget widget={widget} />;
    case 'alert_list': return <AlertListWidget widget={widget} />;
    case 'work_order_list': return <WorkOrderListWidget widget={widget} />;
    case 'service_due': return <ServiceDueWidget widget={widget} />;
    case 'failure_modes': return <FailureModesWidget widget={widget} />;
    case 'recommendations': return <RecommendationsWidget widget={widget} />;
    case 'machine_list': return <MachineListWidget widget={widget} />;
    case 'schematic': return <SchematicWidget widget={widget} />;
    case 'parameter_list': return <ParameterListWidget widget={widget} />;
    // Never filled until a forecast model exists (QML1); the backend says which absence it is.
    case 'forecast_chart': return <ForecastChartWidget widget={widget} />;
    default: return <WidgetShell title={widget.title}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
}

/** The two layout buckets every composed page (machine or site) splits its
 *  widgets into — gauges/numbers up top in a grid, lists below full-width. */
export const GAUGE_WIDGET_TYPES = ['kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'service_due'];
