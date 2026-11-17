import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity, AlertTriangle, ArrowUpRight, Bell, ChevronRight, ClipboardList, Clock3, Cpu, Gauge, MapPin, Search, ShieldCheck,
  Siren, Sparkles, Wrench,
} from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { ConnectionBadge } from '../components/common/ConnectionBadge';
import { LIST_PANEL, TablePagination, usePagination } from '../components/common/TablePagination';
import { ListTable } from '../components/common/ListTable';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import {
  AlertEvent, AssetForecast, EquipmentAvailability, EquipmentProfile, FleetAvailability, FleetLinkRow, IncidentRecord, MyDevice,
  OnboardingSummary, Plant, ShieldSummary, UtilizationSummaryRow, WorkOrder,
  apiGetDeviceHealthFleet, apiGetFleetAvailability, apiGetOnboardingSummary, apiGetServiceForecast, apiGetShieldSummary,
  apiGetUtilizationSummary, apiListAlerts, apiListEquipment, apiListIncidentRecords, apiListMyDevices, apiListPlants, apiListWorkOrders,
} from '../lib/api';
import { severityTone } from '../components/common/statusTone';
import { MachineIcon } from '../components/common/MachineIcon';
import { SelectPicker } from 'rsuite';
import { PanelRow, PanelRows, shortWhen } from '../components/common/PanelRow';
import { useAuth } from '../lib/AuthProvider';
import { Skeleton } from '../components/common/Skeleton';

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
  const devices = useSlot<MyDevice[]>(() => apiListMyDevices());
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

  // Counted over the devices fitted now, as the Devices register counts them. Link
  // health has a row for every IMEI heard in the week, including one taken off its
  // machine since, which made "83 online" beside a register of 82 (test report MAJ-8).
  // A fitted device with no window at all is silent, so offline. Without the register
  // (a role that cannot read it) the week's rows are all there is.
  const fitted = devices.state === 'ok' ? devices.data.filter((d) => d.state === 'assigned') : null;
  const latestByImei = health.state === 'ok' ? new Map(health.data.map((r) => [r.imei, r])) : null;
  const online = !latestByImei ? null
    : fitted ? fitted.filter((d) => { const r = latestByImei.get(d.imei); return !!r && r.state !== 'dark'; }).length
    : [...latestByImei.values()].filter((r) => r.state !== 'dark').length;
  const offline = !latestByImei ? null
    : fitted ? fitted.length - (online ?? 0)
    : [...latestByImei.values()].filter((r) => r.state === 'dark').length;
  const overdueOrders = orders.state === 'ok' ? orders.data.filter((o) => o.dueAt && new Date(o.dueAt).getTime() < Date.now()).length : 0;
  // An employee given a job saw only a count of open work orders here, never the job
  // (testing sheet TC_148). Their own jobs come first, then the rest, earliest due first.
  const { authUser } = useAuth();
  const me = authUser?.role === 'client' ? authUser.userId : undefined;
  const ordersMineFirst: Slot<WorkOrder[]> = orders.state === 'ok'
    ? {
      state: 'ok',
      data: orders.data.slice().sort((a, b) => {
        const mine = Number(b.assignedToUserId === me) - Number(a.assignedToUserId === me);
        if (mine) return mine;
        return (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
      }),
    }
    : orders;
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
        <Tile icon={<Cpu className="w-4 h-4" />} label={t('live.devicesOnline')} slot={devices.state === 'loading' ? { state: 'loading' } as Slot<FleetLinkRow[]> : health} value={() => online ?? 0}
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
          {utilization.state === 'loading' ? <Skeleton lines={2} /> : utilization.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : utilization.data.length === 0 ? (
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
          {availability.state === 'loading' ? <Skeleton lines={2} /> : availability.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
            <div className="flex items-center gap-4">
              <RingGauge value={availability.data.availability != null ? availability.data.availability * 100 : null} size={72} colorClass="text-sky-500 dark:text-sky-400" />
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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <Panel title={t('live.openWorkOrders')} icon={<ClipboardList className="w-4 h-4" />} onOpen={() => navigate('/work-orders')}>
          <List slot={ordersMineFirst} empty={t('live.noOpenWorkOrders')} render={(d) => d.slice(0, 5).map((o) => (
            <PanelRow key={o.id} onClick={() => navigate('/work-orders')} title={`${o.reference} · ${o.title}`}
              detail={`${machineName(o.sourceSystem, o.externalId)} · ${t(`workOrderStatus.${o.status}`, { defaultValue: o.status })}`}
              meta={o.dueAt ? t('live.due', { when: shortWhen(o.dueAt) }) : undefined}
              right={o.assignedToUserId === me && me
                ? <Chip tone="sky">{t('live.yours')}</Chip>
                : <Chip tone={o.priority === 'urgent' || o.priority === 'high' ? 'amber' : 'slate'}>{t(`priority.${o.priority}`, { defaultValue: o.priority })}</Chip>} />
          ))} />
        </Panel>
        <Panel title={t('live.liveIncidents')} icon={<Siren className="w-4 h-4" />} onOpen={() => navigate('/incident-management')}>
          <List slot={incidents} empty={t('live.noLiveIncidents')} render={(d) => d.slice(0, 5).map((i) => (
            <PanelRow key={i.id} onClick={() => openMachine(i.machine.sourceSystem, i.machine.externalId)} title={machineName(i.machine.sourceSystem, i.machine.externalId)}
              detail={`${t(`state.${i.status}`, { defaultValue: i.status })} · ${shortWhen(i.openedAt)}`}
              right={<Chip tone={severityTone(i.severity)}>{t(`severity.${i.severity}`, { defaultValue: i.severity })}</Chip>} />
          ))} />
        </Panel>
        <Panel title={t('live.openAlerts')} icon={<Bell className="w-4 h-4" />} onOpen={() => navigate('/alerts')}>
          <List slot={alerts} empty={t('live.noOpenAlerts')} render={(d) => d.slice(0, 5).map((a) => (
            <PanelRow key={a.id} onClick={() => openMachine(a.sourceSystem, a.externalId)} title={machineName(a.sourceSystem, a.externalId)}
              detail={a.summary} meta={shortWhen(a.firedAt)}
              right={<Chip tone={severityTone(a.severity)}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip>} />
          ))} />
        </Panel>
        <Panel title={t('live.serviceDue')} icon={<Wrench className="w-4 h-4" />} onOpen={() => navigate('/work-orders')}>
          {service.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : service.state === 'loading' ? <Skeleton lines={2} /> : serviceDue.length === 0 ? (
            <Muted>{t('live.nothingDue')}</Muted>
          ) : <PanelRows>{serviceDue.slice(0, 5).map((a) => (
            <PanelRow key={`${a.sourceSystem}/${a.externalId}`} onClick={() => openMachine(a.sourceSystem, a.externalId)} title={a.name ?? a.externalId}
              detail={a.hoursRemaining != null ? t(a.hoursRemaining < 0 ? 'live.hoursOverdue' : 'live.hoursLeft', { hours: Math.abs(a.hoursRemaining) }) : undefined}
              right={<Chip tone={a.status === 'overdue' ? 'rose' : 'amber'}>{a.status ? t(`serviceStatus.${a.status}`, { defaultValue: a.status }) : a.status}</Chip>} />
          ))}</PanelRows>}
        </Panel>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('live.machines')}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('live.machinesHint')}</p>
          </div>
          <button onClick={() => navigate('/admin/equipment')} className="inline-flex items-center gap-1 text-sm text-slate-400 dark:text-slate-500 hover:text-sky-600 cursor-pointer shrink-0">
            {equipment.state === 'ok' ? t('live.machinesCount', { count: equipment.data.length }) : ''}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        {equipment.state !== 'ok' || equipment.data.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            {equipment.state === 'loading' ? <Skeleton lines={2} /> : <Muted>{equipment.state === 'unavailable' ? t('common.unavailable') : t('live.noMachines')}</Muted>}
          </div>
        ) : (
          <MachineCards
            machines={equipment.data}
            plantName={plantName}
            // Same reading as Production Monitoring: `dark` is offline, any other recorded
            // link state is reporting; no row at all is "no link data", not either.
            connectionOf={(externalId) => {
              if (health.state !== 'ok') return null;
              const row = health.data.find((r) => r.externalId === externalId);
              return row ? (row.state === 'dark' ? 'offline' : 'online') : null;
            }}
            availabilityOf={(m) => availability.state === 'ok'
              ? availability.data.machines.find((a) => a.sourceSystem === m.sourceSystem && a.externalId === m.externalId)
              : undefined}
            onOpen={(m) => openMachine(m.sourceSystem, m.externalId)}
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title={t('translation:sidebar.thingsShield')} icon={<ShieldCheck className="w-4 h-4" />} onOpen={() => navigate('/things-shield')}>
          {shield.state === 'loading' ? <Skeleton lines={2} /> : shield.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
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
          {onboarding.state === 'loading' ? <Skeleton lines={2} /> : onboarding.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (() => {
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

/**
 * The equipment cards of the original dashboard, over live data. The original showed
 * an illustrative OEE; per-machine OEE would cost one request per card, so the first
 * chip is 7-day availability, which the fleet availability call already carries.
 */
const MachineCards: React.FC<{
  machines: EquipmentProfile[];
  plantName: (id: string | null) => string;
  connectionOf: (externalId: string) => 'online' | 'offline' | null;
  availabilityOf: (m: EquipmentProfile) => EquipmentAvailability | undefined;
  onOpen: (m: EquipmentProfile) => void;
}> = ({ machines, plantName, connectionOf, availabilityOf, onOpen }) => {
  const { t } = useTranslation('dashboard');
  const { t: ts } = useTranslation('shared');
  const [viewMode, setViewMode] = useViewMode('dashboard-machines');
  // Eighty-odd machines over seven pages had no way to find one (test report MIN-7).
  const [query, setQuery] = useState('');
  // And narrowing by where, what and whether it reports, from what the cards already show (2 Nov 2026).
  const [site, setSite] = useState('all');
  const [kind, setKind] = useState('all');
  const [link, setLink] = useState<'all' | 'online' | 'offline' | 'none'>('all');
  const siteOptions = useMemo(() => [...new Set(machines.map((m) => m.plantId ?? ''))]
    .map((id) => ({ label: plantName(id || null), value: id || 'none' }))
    .sort((a, b) => a.label.localeCompare(b.label)), [machines, plantName]);
  const kindOptions = useMemo(() => [...new Set(machines.map((m) => m.equipmentClassSlug ?? ''))]
    .map((slug) => ({ label: slug || t('live.notClassified'), value: slug || 'none' }))
    .sort((a, b) => a.label.localeCompare(b.label)), [machines, t]);
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return machines.filter((m) => {
      if (site !== 'all' && (m.plantId ?? 'none') !== site) return false;
      if (kind !== 'all' && (m.equipmentClassSlug ?? 'none') !== kind) return false;
      if (link !== 'all' && (connectionOf(m.externalId) ?? 'none') !== link) return false;
      return !q || (m.name ?? '').toLowerCase().includes(q) || m.externalId.toLowerCase().includes(q)
        || plantName(m.plantId).toLowerCase().includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, query, plantName, site, kind, link]);
  const { pageItems, ...pager } = usePagination(matching);
  const hours = (h: number | null | undefined) => (h == null ? '—' : `${h.toFixed(0)}h`);
  // availability arrives as a 0–1 ratio (availability.ts rounds uptime / scheduled).
  const figures = (m: EquipmentProfile) => {
    const a = availabilityOf(m);
    const ready = a?.readiness === 'ready';
    return {
      ready,
      availability: ready && a?.availability != null ? `${(a.availability * 100).toFixed(0)}%` : '—',
      uptime: hours(ready ? a?.uptimeHours : null),
      downtime: hours(ready ? a?.downtimeHours : null),
      down: ready && Math.round(a?.downtimeHours ?? 0) > 0,
    };
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('live.searchMachines')}
            className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
        <SelectPicker
          size="sm"
          data={[{ label: ts('filters.allSitesPlants'), value: 'all' }, ...siteOptions]}
          value={site}
          onChange={(v) => setSite(v ?? 'all')}
          searchable={siteOptions.length > 8}
          cleanable={false}
        />
        <SelectPicker
          size="sm"
          data={[{ label: ts('filters.allClasses'), value: 'all' }, ...kindOptions]}
          value={kind}
          onChange={(v) => setKind(v ?? 'all')}
          searchable={kindOptions.length > 8}
          cleanable={false}
        />
        <SelectPicker
          size="sm"
          data={[
            { label: ts('filters.allConnections'), value: 'all' },
            { label: ts('connection.online'), value: 'online' },
            { label: ts('connection.offline'), value: 'offline' },
            { label: ts('connection.noData'), value: 'none' },
          ]}
          value={link}
          onChange={(v) => setLink((v ?? 'all') as typeof link)}
          searchable={false}
          cleanable={false}
        />
        <span className="ml-auto">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        </span>
      </div>
      <div className={LIST_PANEL}>
        {matching.length === 0 ? (
          <div className="p-4"><Muted>{t('live.noMachineMatches')}</Muted></div>
        ) : viewMode === 'list' ? (
          <ListTable bare
            columns={[
              { label: ts('listCol.machine') }, { label: ts('listCol.type') }, { label: ts('listCol.site') },
              { label: ts('listCol.connection') }, { label: t('common.availability'), align: 'right' },
              { label: t('common.uptimeHours'), align: 'right' }, { label: t('common.downtimeHours'), align: 'right' },
            ]}
            rows={pageItems}
            rowKey={(m) => m.id}
            cells={(m) => {
              const f = figures(m);
              return [
                <span><span className="font-medium">{m.name ?? m.externalId}</span> <span className="text-slate-400">{m.externalId}</span></span>,
                m.equipmentClassSlug ?? t('live.notClassified'),
                plantName(m.plantId),
                <ConnectionBadge state={connectionOf(m.externalId)} />,
                f.availability,
                f.uptime,
                <span className={f.down ? 'text-rose-600 dark:text-rose-400' : ''}>{f.downtime}</span>,
              ];
            }}
            onOpen={onOpen}
          />
        ) : (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {pageItems.map((m) => {
            const a = availabilityOf(m);
            const ready = a?.readiness === 'ready';
            return (
              <button key={m.id} onClick={() => onOpen(m)} className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 transition-colors space-y-2 group cursor-pointer">
                <div className="flex items-center justify-between">
                  <span className="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 flex items-center justify-center"><MachineIcon classSlug={m.equipmentClassSlug} name={m.name} className="w-4.5 h-4.5" /></span>
                  <ConnectionBadge state={connectionOf(m.externalId)} />
                </div>
                <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug truncate" title={m.name ?? m.externalId}>{m.name ?? m.externalId}</h4>
                <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{m.externalId} · {m.equipmentClassSlug ?? t('live.notClassified')}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1"><MapPin className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{plantName(m.plantId)}</span></p>
                <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Chip icon={Activity} title={ready ? t('common.availability') : t('live.availabilityNotReady')} size="md">
                      {ready && a?.availability != null ? `${(a.availability * 100).toFixed(0)}%` : '—'}
                    </Chip>
                    <Chip icon={Clock3} title={t('common.uptimeHours')} size="md">{hours(ready ? a?.uptimeHours : null)}</Chip>
                    <Chip icon={AlertTriangle} tone={ready && Math.round(a?.downtimeHours ?? 0) > 0 ? 'rose' : 'slate'} title={t('common.downtimeHours')} size="md">{hours(ready ? a?.downtimeHours : null)}</Chip>
                  </div>
                  <span className="inline-flex items-center text-xs font-medium text-sky-600 dark:text-sky-400 shrink-0">
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        )}
        <TablePagination {...pager} />
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
      <div className="text-xs text-slate-400 min-h-[16px]">{slot.state === 'unavailable' ? t('common.unavailableShort') : slot.state === 'loading' ? '' : note}</div>
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


function List<T>({ slot, empty, render }: { slot: Slot<T[]>; empty: string; render: (d: T[]) => React.ReactNode }) {
  const { t } = useTranslation('dashboard');
  if (slot.state === 'loading') return <Skeleton lines={2} />;
  if (slot.state === 'unavailable') return <Muted>{t('common.unavailable')}</Muted>;
  if (slot.data.length === 0) return <Muted>{empty}</Muted>;
  return <PanelRows>{render(slot.data)}</PanelRows>;
}

