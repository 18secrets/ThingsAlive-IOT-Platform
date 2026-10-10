import React from 'react';
import { AlertTriangle, Bell, CheckCircle2, Wrench } from 'lucide-react';
import {
  PageWidget, PageKpiWidgetData, PageSignalChartData, PageReadinessRow, PageAlertRow, PageWorkOrderRow,
  PageServiceDueData, PageFailureModeRow, PageRecommendationRow, PageMachineRow, PageSchematicData,
} from '../../lib/api';
import { Chip } from '../common/Chip';
import { RingGauge } from '../common/RingGauge';
import { Sparkline } from '../dashboard/Sparkline';

/** Every widget a composed page (machine or site) can render, shared because the
 *  shape — `PageWidget[]` with a `readiness`/`reason` a widget can't fill — is the
 *  same at both levels; only what sits above the widget grid differs. */

const REASON_LABEL: Record<string, string> = {
  unbound: 'Unbound', stale: 'Stale', no_readings: 'No readings', mapping_required: 'Mapping required',
  baseline_not_established: 'Baseline not established', insufficient_coverage: 'Insufficient coverage',
  undefined_result: 'Undefined result', parameter_not_set: 'Parameter not set',
  site_boundary_not_set: 'Site boundary not set', unclassified: 'Equipment not classified',
  formula_not_in_account: "Formula not in this account's catalog", not_ready: 'Not ready',
  no_requirements: 'No signal requirements declared', no_device: 'No device assigned',
  not_forecast: 'Not in the service forecast', no_visual: 'No equipment image configured',
  upload_pending: 'Image upload pending', assets_unavailable: 'Image storage not configured',
  not_on_this_page: 'Not available on this page',
};

export const reasonText = (reason?: string | null) => (reason ? REASON_LABEL[reason] ?? reason : 'Not available');

const READINESS_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  ready: 'emerald', not_available: 'amber', blocked: 'rose', not_configured: 'slate',
};

const Unfilled: React.FC<{ reason?: string }> = ({ reason }) => (
  <p className="text-xs text-slate-400 dark:text-slate-500">{reasonText(reason)}</p>
);

const WidgetShell: React.FC<{ title: string | null; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
    {title && <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{title}</h3>}
    {children}
  </div>
);

function KpiWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageKpiWidgetData;
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
          {data.target != null && <p className="text-[11px] text-slate-400">Target: {data.target} {data.unit}</p>}
          {(data.targetMin != null || data.targetMax != null) && (
            <p className="text-[11px] text-slate-400">Range: {data.targetMin ?? '—'} – {data.targetMax ?? '—'} {data.unit}</p>
          )}
        </div>
      </div>
    </WidgetShell>
  );
}

function SignalChartWidget({ widget }: { widget: PageWidget }) {
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
      <p className="text-[11px] text-slate-400">Last 24 hours</p>
    </WidgetShell>
  );
}

function ReadinessListWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Signal readiness'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageReadinessRow[];
  return (
    <WidgetShell title={widget.title ?? 'Signal readiness'}>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={`${r.signal}-${i}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300 truncate">{r.signal}</span>
            <Chip tone={READINESS_TONE[r.readiness]}>{r.readiness === 'ready' ? 'Ready' : reasonText(r.reason)}</Chip>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function AlertListWidget({ widget }: { widget: PageWidget }) {
  const rows = (widget.data as PageAlertRow[] | null) ?? [];
  return (
    <WidgetShell title={widget.title ?? 'Alerts'}>
      {widget.readiness !== 'ready' ? (
        <Unfilled reason={widget.reason} />
      ) : rows.length === 0 ? (
        <Chip icon={CheckCircle2} tone="emerald">No open alerts</Chip>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div>
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{a.message}</p>
                <p className="text-[11px] text-slate-400">{a.signal ?? 'no signal'} · {new Date(a.raisedAt).toLocaleString()}</p>
              </div>
              <Chip icon={AlertTriangle} tone={a.severity === 'critical' ? 'rose' : 'amber'}>{a.severity}</Chip>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}

function WorkOrderListWidget({ widget }: { widget: PageWidget }) {
  const rows = (widget.data as PageWorkOrderRow[] | null) ?? [];
  return (
    <WidgetShell title={widget.title ?? 'Work orders'}>
      {widget.readiness !== 'ready' ? (
        <Unfilled reason={widget.reason} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400">No open work orders.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((o) => (
            <div key={o.id} className="flex items-center gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <Wrench className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{o.title}</p>
                <p className="text-[11px] text-slate-400">{o.status}{o.dueAt ? ` · due ${new Date(o.dueAt).toLocaleDateString()}` : ''}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}

function ServiceDueWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Service due'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageServiceDueData;
  return (
    <WidgetShell title={widget.title ?? 'Service due'}>
      <div className="text-xl font-bold text-slate-800 dark:text-slate-100">
        {data.hoursRemaining != null ? `${data.hoursRemaining.toFixed(0)} h remaining` : '—'}
      </div>
      <p className="text-[11px] text-slate-400">
        {data.nextDueAt ? `Due ${new Date(data.nextDueAt).toLocaleDateString()}` : 'No due date'} · {data.basis ?? 'basis unknown'}
      </p>
    </WidgetShell>
  );
}

const FAILURE_TONE: Record<string, 'rose' | 'emerald' | 'slate'> = { active: 'rose', clear: 'emerald', unknown: 'slate' };

function FailureModesWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Failure modes'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageFailureModeRow[];
  return (
    <WidgetShell title={widget.title ?? 'Failure modes'}>
      <div className="space-y-2">
        {rows.map((f) => (
          <div key={f.code} className="flex items-start justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
            <div>
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{f.name}</p>
              <p className="text-[11px] text-slate-400">{f.symptom}</p>
            </div>
            <Chip tone={FAILURE_TONE[f.status]}>{f.status}</Chip>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-slate-400">No failure modes declared for this class.</p>}
      </div>
    </WidgetShell>
  );
}

function RecommendationsWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Recommendations'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageRecommendationRow[];
  return (
    <WidgetShell title={widget.title ?? 'Recommendations'}>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{r.action}</p>
            <p className="text-[11px] text-slate-400">{r.urgency}{r.estimatedHours != null ? ` · ~${r.estimatedHours}h` : ''}</p>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-slate-400">No recommendations for this class.</p>}
      </div>
    </WidgetShell>
  );
}

function MachineListWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Machines'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const rows = widget.data as PageMachineRow[];
  return (
    <WidgetShell title={widget.title ?? 'Machines'}>
      <div className="space-y-1.5">
        {rows.map((m) => (
          <div key={`${m.sourceSystem}/${m.externalId}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-300 truncate">{m.name ?? m.externalId}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {m.openAlerts > 0 && <Chip icon={Bell} tone="rose">{m.openAlerts}</Chip>}
              <Chip tone={READINESS_TONE[m.readiness]}>{m.readiness}</Chip>
            </div>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function SchematicWidget({ widget }: { widget: PageWidget }) {
  if (widget.readiness !== 'ready' || !widget.data) {
    return <WidgetShell title={widget.title ?? 'Schematic'}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
  const data = widget.data as PageSchematicData;
  return (
    <WidgetShell title={widget.title ?? 'Schematic'}>
      <div className="relative rounded-lg overflow-hidden border border-slate-100 dark:border-slate-800">
        <img src={data.imageUrl} alt={widget.title ?? 'Equipment schematic'} className="w-full h-auto block" />
        {data.anchors.map((a) => (
          <span
            key={a.signal}
            title={`${a.label ?? a.signal}${a.value != null ? `: ${a.value} ${a.unit ?? ''}` : ` — ${reasonText(a.reason)}`}`}
            style={{ left: `${a.hotspotX}%`, top: `${a.hotspotY}%` }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow ${
              a.readiness === 'ready' ? 'bg-emerald-500' : a.readiness === 'blocked' ? 'bg-rose-500' : 'bg-amber-500'
            }`}
          />
        ))}
      </div>
      {data.unplacedSignals.length > 0 && (
        <p className="text-[11px] text-slate-400">{data.unplacedSignals.length} signal(s) not placed on the image.</p>
      )}
    </WidgetShell>
  );
}

export function Widget({ widget }: { widget: PageWidget }) {
  switch (widget.widgetType) {
    case 'kpi_number': case 'kpi_gauge': case 'kpi_chart': return <KpiWidget widget={widget} />;
    case 'signal_chart': return <SignalChartWidget widget={widget} />;
    case 'readiness_list': return <ReadinessListWidget widget={widget} />;
    case 'alert_list': return <AlertListWidget widget={widget} />;
    case 'work_order_list': return <WorkOrderListWidget widget={widget} />;
    case 'service_due': return <ServiceDueWidget widget={widget} />;
    case 'failure_modes': return <FailureModesWidget widget={widget} />;
    case 'recommendations': return <RecommendationsWidget widget={widget} />;
    case 'machine_list': return <MachineListWidget widget={widget} />;
    case 'schematic': return <SchematicWidget widget={widget} />;
    default: return <WidgetShell title={widget.title}><Unfilled reason={widget.reason} /></WidgetShell>;
  }
}

/** The two layout buckets every composed page (machine or site) splits its
 *  widgets into — gauges/numbers up top in a grid, lists below full-width. */
export const GAUGE_WIDGET_TYPES = ['kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'service_due'];
