import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, Bell, ClipboardList, ExternalLink, Gauge, Plus, ShieldCheck, Wrench } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import {
  AlertEvent, EffectiveParameter, EquipmentAvailability, EquipmentOee, EquipmentProfile, FleetLinkRow, Plant, Prediction,
  ShieldSummary, WorkOrder,
  apiGetDeviceHealthFleet, apiGetEffectiveParameters, apiGetEquipmentAvailability, apiGetEquipmentOee, apiGetLatestPredictions,
  apiGetShieldSummary, apiListAlerts, apiListEquipment, apiListPlants, apiListWorkOrders,
} from '../lib/api';

const DAY = 86_400_000;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const OEE_REASON: Record<string, string> = {
  no_shift_schedule: 'no shift schedule for this machine', no_readings: 'no readings this week',
  parameter_not_set: 'a required parameter is not set', unbound: 'a needed signal is not bound', stale: 'readings are stale',
};

const SEVERITY_TONE: Record<string, 'rose' | 'amber' | 'sky' | 'emerald' | 'slate'> = {
  critical: 'rose', high: 'rose', medium: 'amber', low: 'sky', none: 'emerald',
};

/**
 * One machine at a glance, from live data (the live dashboard's drill-down): status,
 * this week's OEE and availability, predictions, open alerts and jobs, its compliance
 * status and the cost parameters that apply to it. Each block comes from the page that
 * owns it and links there; the mock Thing Detail stays at /dashboard/:thingId for the
 * classic dashboard until one of the two dashboards is removed.
 */
export const ThingDetailLivePage: React.FC = () => {
  const { sourceSystem = '', externalId = '' } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const key = [sourceSystem, externalId];

  const profile = useSlot<EquipmentProfile | null>(
    () => apiListEquipment().then((l) => l.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId) ?? null), key);
  const plants = useSlot<Plant[]>(() => apiListPlants(), []);
  const link = useSlot<FleetLinkRow | null>(
    () => apiGetDeviceHealthFleet({ days: 7 }).then((rows) => rows.find((r) => r.externalId === externalId) ?? null), key);
  const oee = useSlot<EquipmentOee>(() => apiGetEquipmentOee(sourceSystem, externalId, 'week'), key);
  const availability = useSlot<EquipmentAvailability>(
    () => apiGetEquipmentAvailability(sourceSystem, externalId, new Date(Date.now() - 7 * DAY).toISOString(), new Date().toISOString()), key);
  const predictions = useSlot<Prediction[]>(() => apiGetLatestPredictions(sourceSystem, externalId), key);
  const alerts = useSlot<AlertEvent[]>(() => apiListAlerts({ state: ['open', 'acknowledged'], equipment: externalId }), key);
  const orders = useSlot<WorkOrder[]>(() => apiListWorkOrders({ status: ['created', 'in-progress'], equipment: externalId }), key);
  const shield = useSlot<ShieldSummary>(() => apiGetShieldSummary(), key);
  // Parameters resolve per machine by its register id, which only the profile carries.
  const params = useSlot<EffectiveParameter[]>(
    () => (profile.state === 'ok' && profile.data ? apiGetEffectiveParameters({ scope: 'equipment', scopeRef: profile.data.id }) : Promise.reject(new Error('no profile'))),
    [profile.state],
  );

  const name = profile.state === 'ok' && profile.data ? profile.data.name ?? externalId : externalId;
  usePageHeader({ title: name, subtitle: 'Equipment Detail · live', onBack: () => navigate('/dashboard-live') });

  if (profile.state === 'ok' && !profile.data) {
    return <p className="text-sm text-slate-500">This machine is not in your register.</p>;
  }

  const p = profile.state === 'ok' ? profile.data : null;
  const siteName = p?.plantId && plants.state === 'ok' ? plants.data.find((x) => x.id === p.plantId)?.name : undefined;
  const shieldCells = shield.state === 'ok'
    ? shield.data.machines.find((m) => m.machine.sourceSystem === sourceSystem && m.machine.externalId === externalId)?.categories
    : undefined;
  const enc = (s: string) => encodeURIComponent(s);

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Equipment detail · live</span>
        <h2 className="text-xl font-bold">{name}</h2>
        <p className="text-xs text-sky-100">
          {sourceSystem}/{externalId}{p?.equipmentClassSlug ? ` · ${p.equipmentClassSlug}` : ' · not classified'}{siteName ? ` · ${siteName}` : ''}
        </p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex items-center gap-5 flex-wrap">
        <span title="OEE this calendar week">
          <RingGauge value={oee.state === 'ok' && oee.data.oee.value != null ? oee.data.oee.value * 100 : null} size={72} colorClass="text-emerald-500 dark:text-emerald-400" />
        </span>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            {link.state === 'ok' && (link.data
              ? <Chip tone={link.data.state === 'dark' ? 'rose' : link.data.state === 'healthy' ? 'emerald' : 'amber'}>{link.data.state === 'dark' ? 'offline' : `online · ${link.data.state}`}</Chip>
              : <Chip tone="slate">no logger health yet</Chip>)}
            <Chip tone="slate">OEE this week {oee.state === 'ok' && oee.data.oee.readiness === 'ready' ? pct(oee.data.oee.value) : '—'}</Chip>
            <Chip tone="slate">
              availability 7d {availability.state === 'ok' && availability.data.availability != null ? `${availability.data.availability.toFixed(0)}%` : '—'}
            </Chip>
          </div>
          {oee.state === 'ok' && oee.data.oee.readiness !== 'ready' && (
            <p className="text-slate-400">OEE not available: {OEE_REASON[oee.data.oee.reason ?? ''] ?? oee.data.oee.reason ?? oee.data.oee.readiness}</p>
          )}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <LinkButton label="Equipment page" onClick={() => navigate(`/admin/equipment/${enc(sourceSystem)}/${enc(externalId)}/page`)} />
            <LinkButton label="ThingsCare" onClick={() => navigate(`/things-care/${enc(sourceSystem)}/${enc(externalId)}`)} />
            <LinkButton label="Production" onClick={() => navigate(`/production-monitoring/${enc(sourceSystem)}/${enc(externalId)}`)} />
            <LinkButton label="ThingsShield" onClick={() => navigate(`/things-shield/${enc(sourceSystem)}/${enc(externalId)}`)} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Predictions" icon={<Activity className="w-4 h-4" />} slot={predictions} empty="No active scenario has produced a prediction for this machine yet."
          render={(d) => d.map((x) => (
            <Row key={x.id} left={x.clientScenarioSlug}
              right={<><Chip tone={SEVERITY_TONE[x.severity] ?? 'slate'}>{x.severity}</Chip><span className="text-slate-400">risk {x.riskScore} · {x.confidence}</span></>} />
          ))} />
        <Panel title="Open alerts" icon={<Bell className="w-4 h-4" />} slot={alerts} empty="No open alerts on this machine."
          render={(d) => d.map((a) => (
            <Row key={a.id} left={a.summary} right={<><Chip tone={SEVERITY_TONE[a.severity] ?? 'slate'}>{a.severity}</Chip><span className="text-slate-400">{a.state}</span></>} />
          ))} />
        <Panel title="Open work orders" icon={<ClipboardList className="w-4 h-4" />} slot={orders} empty="No open work orders on this machine."
          action={<button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> Create</button>}
          render={(d) => d.map((o) => (
            <Row key={o.id} left={`${o.reference} · ${o.title}`} right={<span className="text-slate-400">{o.status} · {o.priority}{o.dueAt ? ` · due ${new Date(o.dueAt).toLocaleDateString()}` : ''}</span>} />
          ))} />
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><ShieldCheck className="w-4 h-4" />Compliance</p>
          {shield.state === 'loading' ? <Muted>Loading…</Muted> : !shieldCells ? <Muted>Not available for your role.</Muted> : (
            <div className="flex gap-1.5 flex-wrap">
              {(['compliance', 'safety', 'security'] as const).map((c) => (
                <Chip key={c} tone={{ current: 'emerald', due_soon: 'amber', overdue: 'rose', action_required: 'rose', not_recorded: 'slate' }[shieldCells[c].status] as 'emerald'}>
                  {c}: {shieldCells[c].status.replace('_', ' ')}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Gauge className="w-4 h-4" />This week (OEE)</p>
          {oee.state !== 'ok' ? <Muted>{oee.state === 'loading' ? 'Loading…' : 'Not available for your role.'}</Muted> : (
            <div className="grid grid-cols-3 gap-2 text-xs">
              {([['Availability', oee.data.availability], ['Performance', oee.data.performance], ['Quality', oee.data.quality]] as const).map(([label, f]) => (
                <div key={label} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{f.readiness === 'ready' ? pct(f.value) : '—'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Wrench className="w-4 h-4" />Cost parameters for this machine</p>
          {params.state === 'loading' ? <Muted>Loading…</Muted> : params.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : (
            <div className="space-y-1">
              {/* Cost units are stored as "currency/L"; the account's currency is itself a parameter. */}
              {params.data.map((x) => (
                <Row key={x.name} left={x.name.replace(/_/g, ' ')}
                  right={x.source && x.value != null
                    ? <><span className="font-mono text-slate-700 dark:text-slate-200">{String(x.value)}{x.unit && x.name !== 'currency' ? ` ${x.unit.replace(/currency/g, String(params.data.find((c) => c.name === 'currency')?.value ?? 'currency'))}` : ''}</span><Chip tone="slate">{x.source.scope}</Chip></>
                    : <span className="text-slate-400">not set</span>} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const LinkButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300 cursor-pointer">
    <ExternalLink className="w-3 h-3" /> {label}
  </button>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-xs text-slate-400">{children}</p>;

const Row: React.FC<{ left: string; right: React.ReactNode }> = ({ left, right }) => (
  <div className="flex items-center justify-between gap-2 text-xs border-t border-slate-100 dark:border-slate-800 pt-1.5">
    <span className="text-slate-700 dark:text-slate-200 truncate">{left}</span>
    <span className="flex items-center gap-1.5 shrink-0">{right}</span>
  </div>
);

function Panel<T>({ title, icon, slot, empty, render, action }: {
  title: string; icon: React.ReactNode; slot: Slot<T[]>; empty: string; render: (d: T[]) => React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">{icon}{title}</p>
        {action}
      </div>
      {slot.state === 'loading' ? <Muted>Loading…</Muted>
        : slot.state === 'unavailable' ? <Muted>Not available for your role.</Muted>
          : slot.data.length === 0 ? <Muted>{empty}</Muted>
            : <div className="space-y-1">{render(slot.data)}</div>}
    </div>
  );
}
