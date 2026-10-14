import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, ChevronRight, ClipboardList, Cpu, Gauge, ShieldCheck, Siren, Sparkles, Wrench,
} from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
import { DashboardSwitch } from '../components/dashboard/DashboardSwitch';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import {
  AlertEvent, AssetForecast, EquipmentProfile, FleetAvailability, FleetLinkRow, IncidentRecord, OnboardingSummary,
  Plant, ShieldSummary, UtilizationSummaryRow, WorkOrder,
  apiGetDeviceHealthFleet, apiGetFleetAvailability, apiGetOnboardingSummary, apiGetServiceForecast, apiGetShieldSummary,
  apiGetUtilizationSummary, apiListAlerts, apiListEquipment, apiListIncidentRecords, apiListPlants, apiListWorkOrders,
} from '../lib/api';

const DAY = 86_400_000;
const lastDays = (days: number) => ({ from: new Date(Date.now() - days * DAY).toISOString(), to: new Date().toISOString() });

/**
 * The client dashboard built only on live data, beside the original mock one so the two
 * can be compared and one removed. Every number links to the page that owns it.
 */
export const LiveDashboardPage: React.FC = () => {
  usePageHeader({ title: 'Dashboard', subtitle: 'Operations overview — live data' });
  const navigate = useNavigate();
  const week = lastDays(7);

  const equipment = useSlot<EquipmentProfile[]>(() => apiListEquipment());
  const plants = useSlot<Plant[]>(() => apiListPlants());
  const health = useSlot<FleetLinkRow[]>(() => apiGetDeviceHealthFleet({ days: 7 }));
  const alerts = useSlot<AlertEvent[]>(() => apiListAlerts({ state: ['open'] }));
  const incidents = useSlot<IncidentRecord[]>(() => apiListIncidentRecords({ status: 'live' }));
  const orders = useSlot<WorkOrder[]>(() => apiListWorkOrders({ status: ['created', 'in-progress'] }));
  const service = useSlot<AssetForecast[]>(() => apiGetServiceForecast().then((r) => r.assets));
  const utilization = useSlot<UtilizationSummaryRow[]>(() => apiGetUtilizationSummary({ groupBy: 'plant', ...week }));
  const availability = useSlot<FleetAvailability>(() => apiGetFleetAvailability(week.from, week.to));
  const shield = useSlot<ShieldSummary>(() => apiGetShieldSummary());
  const onboarding = useSlot<OnboardingSummary>(() => apiGetOnboardingSummary());

  const machineName = (sourceSystem: string, externalId: string) =>
    equipment.state === 'ok' ? equipment.data.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId)?.name ?? externalId : externalId;
  const openMachine = (sourceSystem: string, externalId: string) =>
    navigate(`/dashboard/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`);
  const plantName = (id: string | null) =>
    !id ? 'No site' : plants.state === 'ok' ? plants.data.find((p) => p.id === id)?.name ?? id : id;

  const online = health.state === 'ok' ? health.data.filter((r) => r.state !== 'dark').length : null;
  const offline = health.state === 'ok' ? health.data.filter((r) => r.state === 'dark').length : null;
  const overdueOrders = orders.state === 'ok' ? orders.data.filter((o) => o.dueAt && new Date(o.dueAt).getTime() < Date.now()).length : 0;
  const breached = incidents.state === 'ok'
    ? incidents.data.filter((i) => i.sla.acknowledge.state === 'breached' || i.sla.resolve.state === 'breached').length : 0;
  const serviceDue = service.state === 'ok' ? service.data.filter((a) => a.status === 'due' || a.status === 'overdue') : [];

  return (
    <div id="live-dashboard-view" className="space-y-3">
      <DashboardSwitch current="live" />

      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Live · last 7 days where a period applies</span>
        <h2 className="text-xl font-bold">Operations overview</h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile icon={<Wrench className="w-4 h-4" />} label="Machines" slot={equipment} value={(d) => d.length}
          note={plants.state === 'ok' ? `${plants.data.length} site(s)` : undefined} onClick={() => navigate('/admin/equipment')} />
        <Tile icon={<Cpu className="w-4 h-4" />} label="Devices online" slot={health} value={() => online ?? 0}
          note={offline ? `${offline} offline` : 'none offline'} tone={offline ? 'warn' : undefined} onClick={() => navigate('/admin/devices')} />
        <Tile icon={<Bell className="w-4 h-4" />} label="Open alerts" slot={alerts} value={(d) => d.length}
          tone={alerts.state === 'ok' && alerts.data.length ? 'bad' : undefined} onClick={() => navigate('/alerts')} />
        <Tile icon={<Siren className="w-4 h-4" />} label="Live incidents" slot={incidents} value={(d) => d.length}
          note={breached ? `${breached} past response time` : undefined} tone={breached ? 'bad' : undefined} onClick={() => navigate('/incident-management')} />
        <Tile icon={<ClipboardList className="w-4 h-4" />} label="Open work orders" slot={orders} value={(d) => d.length}
          note={overdueOrders ? `${overdueOrders} overdue` : undefined} tone={overdueOrders ? 'warn' : undefined} onClick={() => navigate('/work-orders')} />
        <Tile icon={<Wrench className="w-4 h-4" />} label="Service due" slot={service} value={() => serviceDue.length}
          tone={serviceDue.some((a) => a.status === 'overdue') ? 'bad' : undefined} onClick={() => navigate('/work-orders')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title="Utilization by site · last 7 days" icon={<Gauge className="w-4 h-4" />} onOpen={() => navigate('/production-monitoring')} className="lg:col-span-2">
          {utilization.state === 'loading' ? <Muted>Loading…</Muted> : utilization.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : utilization.data.length === 0 ? (
            <Muted>No scored shifts in this period — utilization needs a shift schedule and readings.</Muted>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-slate-400 text-left">
                <tr><th className="py-1 font-medium">Site</th><th className="py-1 font-medium text-right">Utilization</th><th className="py-1 font-medium text-right">Productive</th><th className="py-1 font-medium text-right">Idle</th><th className="py-1 font-medium text-right">Coverage</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {utilization.data.map((r) => (
                  <tr key={r.key ?? 'none'}>
                    <td className="py-1.5 text-slate-700 dark:text-slate-200">{plantName(r.key)}</td>
                    <td className="py-1.5 text-right font-mono">{r.utilizationRate != null ? `${(r.utilizationRate * 100).toFixed(0)}%` : '—'}</td>
                    <td className="py-1.5 text-right font-mono">{(r.productiveSeconds / 3600).toFixed(1)} h</td>
                    <td className="py-1.5 text-right font-mono">{(r.idleSeconds / 3600).toFixed(1)} h</td>
                    <td className="py-1.5 text-right font-mono">{(r.coverage * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Fleet availability · last 7 days" icon={<Gauge className="w-4 h-4" />} onOpen={() => navigate('/production-monitoring')}>
          {availability.state === 'loading' ? <Muted>Loading…</Muted> : availability.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : (
            <div className="flex items-center gap-4">
              <RingGauge value={availability.data.availability} size={72} colorClass="text-sky-500 dark:text-sky-400" />
              <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <p>{availability.data.machinesMeasured} machine(s) measured</p>
                {availability.data.uptimeHours != null && <p>{availability.data.uptimeHours.toFixed(0)} h up · {(availability.data.downtimeHours ?? 0).toFixed(0)} h down</p>}
                {(availability.data.excluded.noShiftSchedule + availability.data.excluded.noReadings) > 0 && (
                  <p className="text-slate-400">{availability.data.excluded.noShiftSchedule} without a shift schedule, {availability.data.excluded.noReadings} without readings</p>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title="Live incidents" icon={<Siren className="w-4 h-4" />} onOpen={() => navigate('/incident-management')}>
          <List slot={incidents} empty="No live incidents." render={(d) => d.slice(0, 5).map((i) => (
            <Row key={i.id} onClick={() => openMachine(i.machine.sourceSystem, i.machine.externalId)} left={machineName(i.machine.sourceSystem, i.machine.externalId)}
              right={<><Chip tone={i.severity === 'critical' ? 'rose' : i.severity === 'high' ? 'amber' : 'slate'}>{i.severity}</Chip><span className="text-slate-400">{i.status}</span></>} />
          ))} />
        </Panel>
        <Panel title="Open alerts" icon={<Bell className="w-4 h-4" />} onOpen={() => navigate('/alerts')}>
          <List slot={alerts} empty="No open alerts." render={(d) => d.slice(0, 5).map((a) => (
            <Row key={a.id} onClick={() => openMachine(a.sourceSystem, a.externalId)} left={`${machineName(a.sourceSystem, a.externalId)} · ${a.summary}`}
              right={<Chip tone={a.severity === 'critical' ? 'rose' : a.severity === 'high' ? 'amber' : 'slate'}>{a.severity}</Chip>} />
          ))} />
        </Panel>
        <Panel title="Service due" icon={<Wrench className="w-4 h-4" />} onOpen={() => navigate('/work-orders')}>
          {service.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : service.state === 'loading' ? <Muted>Loading…</Muted> : serviceDue.length === 0 ? (
            <Muted>Nothing due or overdue.</Muted>
          ) : serviceDue.slice(0, 5).map((a) => (
            <Row key={`${a.sourceSystem}/${a.externalId}`} onClick={() => openMachine(a.sourceSystem, a.externalId)} left={a.name ?? a.externalId}
              right={<Chip tone={a.status === 'overdue' ? 'rose' : 'amber'}>{a.status}{a.hoursRemaining != null ? ` · ${Math.abs(a.hoursRemaining)} h` : ''}</Chip>} />
          ))}
        </Panel>
      </div>

      <Panel title="Machines" icon={<Wrench className="w-4 h-4" />} onOpen={() => navigate('/admin/equipment')}>
        <List slot={equipment} empty="No machines in your register yet." render={(d) => (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
            {d.map((m) => (
              <Row key={m.id} onClick={() => openMachine(m.sourceSystem, m.externalId)} left={m.name ?? m.externalId}
                right={<span className="text-slate-400">{plantName(m.plantId)}{m.equipmentClassSlug ? ` · ${m.equipmentClassSlug}` : ''}</span>} />
            ))}
          </div>
        )} />
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="ThingsShield" icon={<ShieldCheck className="w-4 h-4" />} onOpen={() => navigate('/things-shield')}>
          {shield.state === 'loading' ? <Muted>Loading…</Muted> : shield.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : (
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="rose">{shield.data.counts.action_required} action required</Chip>
              <Chip tone="rose">{shield.data.counts.overdue} overdue</Chip>
              <Chip tone="amber">{shield.data.counts.due_soon} due soon</Chip>
              <Chip tone="emerald">{shield.data.counts.current} current</Chip>
              <Chip tone="slate">{shield.data.counts.not_recorded} not recorded</Chip>
            </div>
          )}
        </Panel>
        <Panel title="Onboarding" icon={<Sparkles className="w-4 h-4" />} onOpen={() => navigate('/ai-onboarding')}>
          {onboarding.state === 'loading' ? <Muted>Loading…</Muted> : onboarding.state === 'unavailable' ? <Muted>Not available for your role.</Muted> : (() => {
            const totals = onboarding.data.sites.reduce((t, s) => ({ total: t.total + s.machines.total, done: t.done + s.machines.done }), { total: 0, done: 0 });
            return (
              <div className="flex items-center gap-3 text-xs">
                <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${totals.total ? (totals.done / totals.total) * 100 : 0}%` }} />
                </div>
                <span className="text-slate-500">{totals.done}/{totals.total} machines fully onboarded · {onboarding.data.sites.length} site(s)</span>
              </div>
            );
          })()}
        </Panel>
      </div>
    </div>
  );
};

function Tile<T>({ icon, label, slot, value, note, tone, onClick }: {
  icon: React.ReactNode; label: string; slot: Slot<T>; value: (d: T) => number;
  note?: string; tone?: 'warn' | 'bad'; onClick: () => void;
}) {
  const color = tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <button onClick={onClick} className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 cursor-pointer">
      <div className="flex items-center gap-1.5 text-slate-400 text-xs">{icon}{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>
        {slot.state === 'ok' ? value(slot.data) : slot.state === 'loading' ? '…' : '—'}
      </div>
      <div className="text-[11px] text-slate-400 min-h-[16px]">{slot.state === 'unavailable' ? 'not available for your role' : note}</div>
    </button>
  );
}

const Panel: React.FC<{ title: string; icon: React.ReactNode; onOpen: () => void; className?: string; children: React.ReactNode }> = ({ title, icon, onOpen, className, children }) => (
  <div className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 ${className ?? ''}`}>
    <button onClick={onOpen} className="w-full flex items-center justify-between gap-2 cursor-pointer group">
      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">{icon}{title}</span>
      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-sky-500" />
    </button>
    {children}
  </div>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-xs text-slate-400">{children}</p>;

const Row: React.FC<{ left: string; right: React.ReactNode; onClick?: () => void }> = ({ left, right, onClick }) => (
  <div
    onClick={onClick}
    className={`flex items-center justify-between gap-2 text-xs border-t border-slate-100 dark:border-slate-800 pt-1.5 ${onClick ? 'cursor-pointer hover:text-sky-600' : ''}`}
  >
    <span className="text-slate-700 dark:text-slate-200 truncate">{left}</span>
    <span className="flex items-center gap-1.5 shrink-0">{right}</span>
  </div>
);

function List<T>({ slot, empty, render }: { slot: Slot<T[]>; empty: string; render: (d: T[]) => React.ReactNode }) {
  if (slot.state === 'loading') return <Muted>Loading…</Muted>;
  if (slot.state === 'unavailable') return <Muted>Not available for your role.</Muted>;
  if (slot.data.length === 0) return <Muted>{empty}</Muted>;
  return <div className="space-y-1">{render(slot.data)}</div>;
}

