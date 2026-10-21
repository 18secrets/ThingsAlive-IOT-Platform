import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bell, ChevronRight, ClipboardList, Cpu, Gauge, ShieldCheck, Siren, Sparkles, Wrench,
} from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
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
 * The client dashboard, built only on live data; it replaced the original mock one on
 * 2026-10-21. Every number links to the page that owns it.
 */
export const LiveDashboardPage: React.FC = () => {
  const { t } = useTranslation('dashboard');
  usePageHeader({ title: t('translation:sidebar.dashboard'), subtitle: t('live.subtitle') });
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
    !id ? t('live.noSite') : plants.state === 'ok' ? plants.data.find((p) => p.id === id)?.name ?? id : id;

  const online = health.state === 'ok' ? health.data.filter((r) => r.state !== 'dark').length : null;
  const offline = health.state === 'ok' ? health.data.filter((r) => r.state === 'dark').length : null;
  const overdueOrders = orders.state === 'ok' ? orders.data.filter((o) => o.dueAt && new Date(o.dueAt).getTime() < Date.now()).length : 0;
  const breached = incidents.state === 'ok'
    ? incidents.data.filter((i) => i.sla.acknowledge.state === 'breached' || i.sla.resolve.state === 'breached').length : 0;
  const serviceDue = service.state === 'ok' ? service.data.filter((a) => a.status === 'due' || a.status === 'overdue') : [];

  return (
    <div id="live-dashboard-view" className="space-y-3">

      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('live.banner')}</span>
        <h2 className="text-xl font-bold">{t('live.heading')}</h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile icon={<Wrench className="w-4 h-4" />} label={t('live.machines')} slot={equipment} value={(d) => d.length}
          note={plants.state === 'ok' ? t('common.sites', { count: plants.data.length }) : undefined} onClick={() => navigate('/admin/equipment')} />
        <Tile icon={<Cpu className="w-4 h-4" />} label={t('live.devicesOnline')} slot={health} value={() => online ?? 0}
          note={offline ? t('live.offlineCount', { count: offline }) : t('live.noneOffline')} tone={offline ? 'warn' : undefined} onClick={() => navigate('/admin/devices')} />
        <Tile icon={<Bell className="w-4 h-4" />} label={t('live.openAlerts')} slot={alerts} value={(d) => d.length}
          tone={alerts.state === 'ok' && alerts.data.length ? 'bad' : undefined} onClick={() => navigate('/alerts')} />
        <Tile icon={<Siren className="w-4 h-4" />} label={t('live.liveIncidents')} slot={incidents} value={(d) => d.length}
          note={breached ? t('live.pastResponse', { count: breached }) : undefined} tone={breached ? 'bad' : undefined} onClick={() => navigate('/incident-management')} />
        <Tile icon={<ClipboardList className="w-4 h-4" />} label={t('live.openWorkOrders')} slot={orders} value={(d) => d.length}
          note={overdueOrders ? t('live.overdueCount', { count: overdueOrders }) : undefined} tone={overdueOrders ? 'warn' : undefined} onClick={() => navigate('/work-orders')} />
        <Tile icon={<Wrench className="w-4 h-4" />} label={t('live.serviceDue')} slot={service} value={() => serviceDue.length}
          tone={serviceDue.some((a) => a.status === 'overdue') ? 'bad' : undefined} onClick={() => navigate('/work-orders')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title={t('live.utilizationTitle')} icon={<Gauge className="w-4 h-4" />} onOpen={() => navigate('/production-monitoring')} className="lg:col-span-2">
          {utilization.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : utilization.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : utilization.data.length === 0 ? (
            <Muted>{t('live.utilizationEmpty')}</Muted>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-slate-400 text-left">
                <tr><th className="py-1 font-medium">{t('live.colSite')}</th><th className="py-1 font-medium text-right">{t('live.colUtilization')}</th><th className="py-1 font-medium text-right">{t('live.colProductive')}</th><th className="py-1 font-medium text-right">{t('live.colIdle')}</th><th className="py-1 font-medium text-right">{t('live.colCoverage')}</th></tr>
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

        <Panel title={t('live.availabilityTitle')} icon={<Gauge className="w-4 h-4" />} onOpen={() => navigate('/production-monitoring')}>
          {availability.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : availability.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
            <div className="flex items-center gap-4">
              <RingGauge value={availability.data.availability} size={72} colorClass="text-sky-500 dark:text-sky-400" />
              <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <p>{t('live.machinesMeasured', { count: availability.data.machinesMeasured })}</p>
                {availability.data.uptimeHours != null && <p>{t('live.upDown', { up: availability.data.uptimeHours.toFixed(0), down: (availability.data.downtimeHours ?? 0).toFixed(0) })}</p>}
                {(availability.data.excluded.noShiftSchedule + availability.data.excluded.noReadings) > 0 && (
                  <p className="text-slate-400">{t('live.excluded', { noShift: availability.data.excluded.noShiftSchedule, noReadings: availability.data.excluded.noReadings })}</p>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title={t('live.liveIncidents')} icon={<Siren className="w-4 h-4" />} onOpen={() => navigate('/incident-management')}>
          <List slot={incidents} empty={t('live.noLiveIncidents')} render={(d) => d.slice(0, 5).map((i) => (
            <Row key={i.id} onClick={() => openMachine(i.machine.sourceSystem, i.machine.externalId)} left={machineName(i.machine.sourceSystem, i.machine.externalId)}
              right={<><Chip tone={i.severity === 'critical' ? 'rose' : i.severity === 'high' ? 'amber' : 'slate'}>{t(`severity.${i.severity}`, { defaultValue: i.severity })}</Chip><span className="text-slate-400">{t(`state.${i.status}`, { defaultValue: i.status })}</span></>} />
          ))} />
        </Panel>
        <Panel title={t('live.openAlerts')} icon={<Bell className="w-4 h-4" />} onOpen={() => navigate('/alerts')}>
          <List slot={alerts} empty={t('live.noOpenAlerts')} render={(d) => d.slice(0, 5).map((a) => (
            <Row key={a.id} onClick={() => openMachine(a.sourceSystem, a.externalId)} left={`${machineName(a.sourceSystem, a.externalId)} · ${a.summary}`}
              right={<Chip tone={a.severity === 'critical' ? 'rose' : a.severity === 'high' ? 'amber' : 'slate'}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip>} />
          ))} />
        </Panel>
        <Panel title={t('live.serviceDue')} icon={<Wrench className="w-4 h-4" />} onOpen={() => navigate('/work-orders')}>
          {service.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : service.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : serviceDue.length === 0 ? (
            <Muted>{t('live.nothingDue')}</Muted>
          ) : serviceDue.slice(0, 5).map((a) => (
            <Row key={`${a.sourceSystem}/${a.externalId}`} onClick={() => openMachine(a.sourceSystem, a.externalId)} left={a.name ?? a.externalId}
              right={<Chip tone={a.status === 'overdue' ? 'rose' : 'amber'}>{a.status ? t(`serviceStatus.${a.status}`, { defaultValue: a.status }) : a.status}{a.hoursRemaining != null ? ` · ${Math.abs(a.hoursRemaining)} h` : ''}</Chip>} />
          ))}
        </Panel>
      </div>

      <Panel title={t('live.machines')} icon={<Wrench className="w-4 h-4" />} onOpen={() => navigate('/admin/equipment')}>
        <List slot={equipment} empty={t('live.noMachines')} render={(d) => (
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
          {shield.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : shield.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="rose">{t('live.shieldCount.action_required', { count: shield.data.counts.action_required })}</Chip>
              <Chip tone="rose">{t('live.shieldCount.overdue', { count: shield.data.counts.overdue })}</Chip>
              <Chip tone="amber">{t('live.shieldCount.due_soon', { count: shield.data.counts.due_soon })}</Chip>
              <Chip tone="emerald">{t('live.shieldCount.current', { count: shield.data.counts.current })}</Chip>
              <Chip tone="slate">{t('live.shieldCount.not_recorded', { count: shield.data.counts.not_recorded })}</Chip>
            </div>
          )}
        </Panel>
        <Panel title={t('live.onboarding')} icon={<Sparkles className="w-4 h-4" />} onOpen={() => navigate('/ai-onboarding')}>
          {onboarding.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : onboarding.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (() => {
            const totals = onboarding.data.sites.reduce((acc, s) => ({ total: acc.total + s.machines.total, done: acc.done + s.machines.done }), { total: 0, done: 0 });
            return (
              <div className="flex items-center gap-3 text-xs">
                <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${totals.total ? (totals.done / totals.total) * 100 : 0}%` }} />
                </div>
                <span className="text-slate-500">{t('live.onboarded', { done: totals.done, total: totals.total })} · {t('common.sites', { count: onboarding.data.sites.length })}</span>
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
  const { t } = useTranslation('dashboard');
  const color = tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <button onClick={onClick} className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 cursor-pointer">
      <div className="flex items-center gap-1.5 text-slate-400 text-xs">{icon}{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>
        {slot.state === 'ok' ? value(slot.data) : slot.state === 'loading' ? '…' : '—'}
      </div>
      <div className="text-[11px] text-slate-400 min-h-[16px]">{slot.state === 'unavailable' ? t('common.unavailableShort') : note}</div>
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
  const { t } = useTranslation('dashboard');
  if (slot.state === 'loading') return <Muted>{t('common.loading')}</Muted>;
  if (slot.state === 'unavailable') return <Muted>{t('common.unavailable')}</Muted>;
  if (slot.data.length === 0) return <Muted>{empty}</Muted>;
  return <div className="space-y-1">{render(slot.data)}</div>;
}

