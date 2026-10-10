import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Bell, CheckCircle2, Clock3, Gauge, Plus, Wrench } from 'lucide-react';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import {
  ApiError, EquipmentShift, MachinePage, PageWidget, ShiftInput, ShiftRun, Weekday, apiCreateShift,
  apiGetMachinePage, apiGetShiftRuns, apiListShifts, apiReinstateShift, apiRetireShift,
  PageKpiWidgetData, PageSignalChartData, PageReadinessRow, PageAlertRow, PageWorkOrderRow,
  PageServiceDueData, PageFailureModeRow, PageRecommendationRow, PageMachineRow, PageSchematicData,
} from '../lib/api';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { Sparkline } from '../components/dashboard/Sparkline';
import { Modal } from '../components/common/Modal';

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

const reasonText = (reason?: string | null) => (reason ? REASON_LABEL[reason] ?? reason : 'Not available');

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

function Widget({ widget }: { widget: PageWidget }) {
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

const DAY_LABEL: Record<Weekday, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
const DAY_OPTIONS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

const RUN_STATUS_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  scored: 'emerald', 'nothing-to-score': 'slate', 'not-running': 'amber', failed: 'rose',
};

function ShiftSchedule({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const [shifts, setShifts] = useState<EquipmentShift[]>([]);
  const [runs, setRuns] = useState<ShiftRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => apiListShifts(sourceSystem, externalId).then(setShifts);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGetShiftRuns(sourceSystem, externalId).then((r) => { if (live) setRuns(r); }).catch(() => {});
    apiListShifts(sourceSystem, externalId)
      .then((s) => { if (live) { setShifts(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load the shift schedule.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  async function toggle(shift: EquipmentShift) {
    setBusyId(shift.id);
    try {
      if (shift.status === 'active') await apiRetireShift(sourceSystem, externalId, shift.id);
      else await apiReinstateShift(sourceSystem, externalId, shift.id);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not change this shift.');
    } finally {
      setBusyId(null);
    }
  }

  async function create(input: ShiftInput) {
    try {
      await apiCreateShift(sourceSystem, externalId, input);
      setAdding(false);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not add this shift.');
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Shift schedule</h3>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add shift
        </button>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : shifts.length === 0 ? (
        <p className="text-xs text-slate-400">No shifts configured. Utilization and availability stay "not_configured" until one exists.</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{s.name}</p>
                <p className="text-[11px] text-slate-400">
                  {s.days.slice().sort().map((d) => DAY_LABEL[d]).join(', ')} · {minutesToClock(s.startMinute)}–{minutesToClock(s.endMinute)} ({s.timeZone})
                </p>
              </div>
              <button
                disabled={busyId === s.id}
                onClick={() => toggle(s)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 shrink-0 ${s.status === 'active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                title={s.status === 'active' ? 'Retire' : 'Reinstate'}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.status === 'active' ? 'translate-x-4.5' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Recent shift runs</p>
          {runs.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1"><Clock3 className="w-3 h-3" />{r.localDate} · {r.shiftName}</span>
              <Chip tone={RUN_STATUS_TONE[r.status] ?? 'slate'}>{r.detail ?? r.status}</Chip>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="Add shift" subtitle="Working Hours" maxWidth="max-w-md">
        <ShiftForm onCancel={() => setAdding(false)} onCreate={create} />
      </Modal>
    </div>
  );
}

const ShiftForm: React.FC<{ onCancel: () => void; onCreate: (input: ShiftInput) => void }> = ({ onCancel, onCreate }) => {
  const [name, setName] = useState('');
  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('18:00');
  const [days, setDays] = useState<Weekday[]>([1, 2, 3, 4, 5]);
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

  const valid = useMemo(() => {
    const s = clockToMinutes(start);
    const e = clockToMinutes(end);
    return !!name.trim() && s != null && e != null && e > s && days.length > 0 && !!timeZone.trim();
  }, [name, start, end, days, timeZone]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const startMinute = clockToMinutes(start);
        const endMinute = clockToMinutes(end);
        if (!valid || startMinute == null || endMinute == null) return;
        onCreate({ name: name.trim(), startMinute, endMinute, days, timeZone: timeZone.trim() });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
        <Input required value={name} onChange={(value) => setName(value)} placeholder="e.g. Day shift" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Start (HH:MM)</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">End (HH:MM)</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Days</span>
        <CheckPicker
          data={DAY_OPTIONS.map((d) => ({ label: DAY_LABEL[d], value: d }))}
          value={days}
          onChange={(value) => setDays((value ?? []) as Weekday[])}
          block
          searchable={false}
          cleanable={false}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Time zone (IANA)</span>
        <Input required value={timeZone} onChange={(value) => setTimeZone(value)} placeholder="e.g. Asia/Kolkata" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!valid} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          Add shift
        </button>
      </div>
    </form>
  );
};

export const EquipmentPagePage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState<MachinePage | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  usePageHeader({
    title: page?.equipment.name ?? externalId ?? 'Equipment',
    subtitle: 'Equipment page',
    onBack: () => navigate('/admin/equipment'),
  });

  useEffect(() => {
    if (!sourceSystem || !externalId) return;
    let live = true;
    setLoading(true);
    apiGetMachinePage(sourceSystem, externalId)
      .then((result) => { if (live) { setPage(result); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load this equipment page.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
      </div>
    );
  }
  if (!page) return null;

  const gauges = page.widgets.filter((w) => ['kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'service_due'].includes(w.widgetType));
  const lists = page.widgets.filter((w) => !gauges.includes(w));

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-5 text-white space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4" />
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Equipment page</span>
        </div>
        <h2 className="text-lg font-bold">{page.equipment.name ?? page.equipment.externalId}</h2>
        <p className="text-xs text-sky-100">
          {page.equipment.sourceSystem}/{page.equipment.externalId}
          {page.equipment.classSlug ? ` · ${page.equipment.classSlug}` : ' · Not classified'}
          {page.layout.fallback ? ' · fallback layout' : ''}
        </p>
      </div>

      {page.widgets.length === 0 && (
        <p className="text-sm text-slate-400">No widgets configured for this equipment's class yet.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {gauges.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {lists.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>

      <ShiftSchedule sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} />
    </div>
  );
};
