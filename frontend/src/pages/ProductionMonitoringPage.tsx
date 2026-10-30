import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DateRangePicker } from 'rsuite';
import { AlertCircle, ChevronRight, Clock3, Info } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';
import { ConnectionBadge } from '../components/common/ConnectionBadge';
import { ListTable } from '../components/common/ListTable';
import { LIST_PANEL, TablePagination, usePagination } from '../components/common/TablePagination';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import { SortSelect } from '../components/common/SortSelect';
import { sortRows, useSort } from '../lib/useSort';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import {
  ApiError, EquipmentOee, EquipmentProfile, FleetAvailability, FleetLinkRow, Plant, SiteOee,
  apiGetDeviceHealthFleet, apiGetFleetAvailability, apiGetSiteOee, apiListEquipment, apiListPlants,
} from '../lib/api';

const PAGE_SIZE = 12;
const DAYS = 7;

function periodLastNDays(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export const ProductionMonitoringPage: React.FC = () => {
  const { t } = useTranslation(['production', 'shared']);
  const [viewMode, setViewMode] = useViewMode('production-monitoring');
  // Lowest availability first: the machines losing the most time are the ones to look at.
  const { sort, setSort, toggle } = useSort<'availability' | 'downtime' | 'name'>({ key: 'availability', dir: 'asc' });
  usePageHeader({ title: t('translation:pages.productionMonitoring.title'), subtitle: t('page.subtitle') });
  const navigate = useNavigate();
  const [availability, setAvailability] = useState<FleetAvailability | null>(null);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  // OEE comes per site (GET /plants/:id/oee), which carries every machine's own OEE too —
  // one call per site instead of one per machine. A machine on no site has none here.
  const [siteOee, setSiteOee] = useState<Record<string, SiteOee>>({});
  // The availability period: the last seven days, or a range the person picks — the page
  // offered no other window (test report MIN-7 / P3-D4). OEE stays per calendar week.
  const [range, setRange] = useState<[Date, Date] | null>(null);
  const period = range ? { from: range[0].toISOString(), to: range[1].toISOString() } : null;

  useEffect(() => {
    let live = true;
    apiListEquipment().then((e) => { if (live) setEquipment(e); }).catch(() => {});
    apiListPlants().then((p) => {
      if (!live) return;
      setPlants(p);
      for (const plant of p) {
        apiGetSiteOee(plant.id, 'week')
          .then((o) => { if (live) setSiteOee((prev) => ({ ...prev, [plant.id]: o })); })
          .catch(() => {});
      }
    }).catch(() => {});
    apiGetDeviceHealthFleet({ days: DAYS }).then((rows) => { if (live) setLinkHealth(rows); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    const { from, to } = period ?? periodLastNDays(DAYS);
    setLoading(true);
    apiGetFleetAvailability(from, to)
      .then((a) => { if (live) { setAvailability(a); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.loadAvailability')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period?.from, period?.to]);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const name = (sourceSystem: string, externalId: string) => profileOf(sourceSystem, externalId)?.name ?? externalId;
  /** `dark` is offline; any other recorded link state is reporting, so online.
   *  A machine with no device-health row at all matches neither filter value. */
  const connectionOf = (externalId: string): 'online' | 'offline' | null => {
    const row = linkHealth.find((r) => r.externalId === externalId);
    if (!row) return null;
    return row.state === 'dark' ? 'offline' : 'online';
  };

  const machineOee = useMemo(() => {
    const byKey = new Map<string, EquipmentOee>();
    for (const site of Object.values(siteOee)) {
      for (const m of site.machines) byKey.set(`${m.sourceSystem}|${m.externalId}`, m);
    }
    return byKey;
  }, [siteOee]);
  const selectedSiteOee = scope.plantId !== 'all' ? siteOee[scope.plantId] : undefined;

  const equipmentClasses = useMemo(
    () => [...new Set(equipment.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))].sort(),
    [equipment],
  );

  const equipmentOptions = useMemo(
    () => equipment.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId, label: `${e.name ?? e.externalId} (${e.externalId})` })),
    [equipment],
  );

  const machines = useMemo(() => {
    const all = availability?.machines ?? [];
    const term = scope.query.trim().toLowerCase();
    return all.filter((m) => {
      const profile = profileOf(m.sourceSystem, m.externalId);
      const key = `${m.sourceSystem}|${m.externalId}`;
      const matchesSelected = selectedKey === 'all' || key === selectedKey;
      const matchesPlant = scope.plantId === 'all' || profile?.plantId === scope.plantId;
      const matchesClass = scope.classSlug === 'all' || profile?.equipmentClassSlug === scope.classSlug;
      const matchesConnection = scope.connection === 'all' || connectionOf(m.externalId) === scope.connection;
      const matchesQuery = !term
        || name(m.sourceSystem, m.externalId).toLowerCase().includes(term)
        || m.externalId.toLowerCase().includes(term);
      return matchesSelected && matchesPlant && matchesClass && matchesConnection && matchesQuery;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, equipment, linkHealth, scope, selectedKey]);

  // The tiles describe what the list shows. Unfiltered, that is the server's own fleet
  // figure; filtered, the same rule (hours summed, never ratios averaged — see
  // aggregateAvailability) over the machines left, as ThingsCare and Incidents do.
  const filtered = selectedKey !== 'all' || scope.plantId !== 'all' || scope.classSlug !== 'all'
    || scope.connection !== 'all' || scope.query.trim() !== '';
  const headline = useMemo(() => {
    if (!filtered) {
      return {
        measured: availability?.machinesMeasured ?? 0, availability: availability?.availability ?? null,
        uptime: availability?.uptimeHours ?? null, downtime: availability?.downtimeHours ?? null,
        excluded: availability?.excluded ?? { noShiftSchedule: 0, noReadings: 0 },
      };
    }
    const ready = machines.filter((m) => m.readiness === 'ready');
    const sum = (pick: (m: (typeof ready)[number]) => number | null) => ready.reduce((s, m) => s + (pick(m) ?? 0), 0);
    const scheduled = sum((m) => m.scheduledHours);
    const uptime = sum((m) => m.uptimeHours);
    return {
      measured: ready.length,
      availability: ready.length && scheduled > 0 ? Math.min(1, uptime / scheduled) : null,
      uptime: ready.length ? uptime : null,
      downtime: ready.length ? sum((m) => m.downtimeHours) : null,
      excluded: {
        noShiftSchedule: machines.filter((m) => m.reason === 'no_shift_schedule').length,
        noReadings: machines.filter((m) => m.reason === 'no_readings').length,
      },
    };
  }, [filtered, availability, machines]);

  const sorted = useMemo(() => sortRows(machines, sort, {
    availability: (m) => (m.readiness === 'ready' ? m.availability : null),
    downtime: (m) => (m.readiness === 'ready' ? m.downtimeHours : null),
    name: (m) => name(m.sourceSystem, m.externalId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [machines, sort, equipment]);

  // The shared rsuite pager, as every other list; back to page 1 when the filters change the count.
  const { pageItems, ...pager } = usePagination(sorted, PAGE_SIZE);

  return (
    <div id="production-monitoring-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">
            {range ? `${range[0].toLocaleDateString()} – ${range[1].toLocaleDateString()}` : t('hero.lastDays', { count: DAYS })}
          </span>
          <span title={t('hero.tooltip')}>
            <Info className="w-4 h-4 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">{t('hero.title')}</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('period.label')}</span>
        <DateRangePicker
          size="sm"
          format="yyyy-MM-dd"
          value={range}
          onChange={(v) => { setRange(v as [Date, Date] | null); pager.setPage(1); }}
          shouldDisableDate={(date) => date.getTime() > Date.now()}
          placeholder={t('hero.lastDays', { count: DAYS })}
          cleanable
        />
      </div>

      <EquipmentFilters
        scope={scope}
        onChange={setScope}
        plants={plants}
        classes={equipmentClasses}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
      />

      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : (
        <>
          <div className={`grid grid-cols-2 sm:grid-cols-4 ${selectedSiteOee ? 'lg:grid-cols-5' : ''} gap-4`}>
            <KpiTile label={t('kpi.machinesMeasured')} value={String(headline.measured)} />
            <KpiTile label={t('kpi.fleetAvailability')} value={headline.availability != null ? `${(headline.availability * 100).toFixed(0)}%` : '—'} />
            <KpiTile label={t('kpi.uptime')} value={headline.uptime != null ? `${headline.uptime.toFixed(0)}h` : '—'} />
            <KpiTile label={t('kpi.downtime')} value={headline.downtime != null ? `${headline.downtime.toFixed(0)}h` : '—'} tone="warn" />
            {selectedSiteOee && (
              <KpiTile
                label={t('kpi.siteOee', { count: selectedSiteOee.machinesIncluded })}
                value={selectedSiteOee.oee != null ? `${(selectedSiteOee.oee * 100).toFixed(0)}%` : '—'}
              />
            )}
          </div>
          {(headline.excluded.noShiftSchedule || headline.excluded.noReadings) ? (
            <p className="text-xs text-slate-400">
              {t('list.excluded', { noShift: headline.excluded.noShiftSchedule, noReadings: headline.excluded.noReadings })}
            </p>
          ) : null}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('list.heading')}</h3>
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-400 dark:text-slate-500">{t('list.count', { count: machines.length })}</span>
                <SortSelect
                  sort={sort}
                  onChange={(next) => { setSort(next); pager.setPage(1); }}
                  options={[
                    { key: 'availability', dir: 'asc', label: t('shared:sort.availabilityLow') },
                    { key: 'availability', dir: 'desc', label: t('shared:sort.availabilityHigh') },
                    { key: 'downtime', dir: 'desc', label: t('shared:sort.downtimeHigh') },
                    { key: 'name', dir: 'asc', label: t('shared:sort.nameAz') },
                  ]}
                />
                <ViewModeToggle mode={viewMode} onChange={setViewMode} />
              </div>
            </div>

            <div className={LIST_PANEL}>
              {pageItems.length === 0 ? (
                <div className="py-10 text-center text-slate-400 text-sm">
                  {t('list.empty')}
                </div>
              ) : viewMode === 'list' ? (
                <ListTable bare
                  columns={[
                    { label: t('listCol.machine'), sortKey: 'name' }, { label: t('listCol.connection') },
                    { label: t('listCol.availability'), align: 'right', sortKey: 'availability' }, { label: t('listCol.oeeWeek'), align: 'right' },
                    { label: t('listCol.up'), align: 'right' }, { label: t('listCol.down'), align: 'right', sortKey: 'downtime' },
                  ]}
                  sort={sort}
                  onSort={(key) => { toggle(key as 'availability' | 'downtime' | 'name', key === 'downtime' ? 'desc' : 'asc'); pager.setPage(1); }}
                  rows={pageItems}
                  rowKey={(m) => `${m.sourceSystem}/${m.externalId}`}
                  cells={(m) => {
                    const oee = machineOee.get(`${m.sourceSystem}|${m.externalId}`)?.oee;
                    const ready = m.readiness === 'ready';
                    return [
                      <span><span className="font-medium">{name(m.sourceSystem, m.externalId)}</span> <span className="text-slate-400">{m.externalId}</span></span>,
                      <ConnectionBadge state={connectionOf(m.externalId)} />,
                      // A ratio; and a reason in place of a number, as on the card.
                      ready && m.availability != null ? `${(m.availability * 100).toFixed(0)}%`
                        : <span className="text-slate-400">{m.reason ? t(`reason.${m.reason}`, { defaultValue: m.reason }) : '—'}</span>,
                      oee?.readiness === 'ready' && oee.value != null ? `${(oee.value * 100).toFixed(0)}%` : '—',
                      ready ? `${(m.uptimeHours ?? 0).toFixed(0)} h` : '—',
                      ready ? `${(m.downtimeHours ?? 0).toFixed(0)} h` : '—',
                    ];
                  }}
                  onOpen={(m) => navigate(`/production-monitoring/${encodeURIComponent(m.sourceSystem)}/${encodeURIComponent(m.externalId)}`)}
                />
              ) : (
                <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {pageItems.map((m) => (
                    <ProductionCard
                      key={`${m.sourceSystem}/${m.externalId}`}
                      machine={m}
                      name={name(m.sourceSystem, m.externalId)}
                      oee={machineOee.get(`${m.sourceSystem}|${m.externalId}`)}
                      connection={connectionOf(m.externalId)}
                      onOpen={() => navigate(`/production-monitoring/${encodeURIComponent(m.sourceSystem)}/${encodeURIComponent(m.externalId)}`)}
                    />
                  ))}
                </div>
              )}

              <TablePagination pinToBottom {...pager} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'warn' }> = ({ label, value, tone }) => (
  <div className={`border rounded-xl p-4 shadow-xs ${tone === 'warn' ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'}`}>
    <div className={`text-2xl font-bold ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
    <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
  </div>
);

const READINESS_STYLE = {
  ready: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-white dark:bg-slate-900', gauge: 'text-sky-500 dark:text-sky-400' },
  not_configured: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-800/20', gauge: 'text-slate-400' },
  not_available: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-800/20', gauge: 'text-slate-400' },
} as const;

const ProductionCard: React.FC<{
  machine: FleetAvailability['machines'][number]; name: string; oee?: EquipmentOee;
  connection: 'online' | 'offline' | null; onOpen: () => void;
}> = ({ machine, name, oee, connection, onOpen }) => {
  const { t } = useTranslation('production');
  const style = READINESS_STYLE[machine.readiness];
  // availability is a 0–1 ratio; the gauge draws a percentage.
  const gaugeValue = machine.readiness === 'ready' && machine.availability != null ? machine.availability * 100 : null;
  return (
    <button onClick={onOpen} className={`text-left w-full border ${style.ring} ${style.bg} rounded-xl p-4 shadow-xs space-y-3 hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-center gap-3">
        <RingGauge value={gaugeValue} size={60} colorClass={style.gauge} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate" title={name}>{name}</h4>
            <ConnectionBadge state={connection} />
          </div>
          <p className="text-sm text-slate-400 dark:text-slate-500 truncate">{machine.sourceSystem}/{machine.externalId}</p>
          {oee && (
            <p className="text-xs mt-1">
              {oee.oee.readiness === 'ready' && oee.oee.value != null ? (
                <Chip tone="emerald" title={t('card.oeeTitle')}>{t('card.oeeWeek', { value: (oee.oee.value * 100).toFixed(0) })}</Chip>
              ) : (
                <span className="text-slate-400" title={oee.oee.reason ? t(`oeeReason.${oee.oee.reason}`, { defaultValue: oee.oee.reason }) : oee.oee.readiness}>{t('common.oeeNotAvailable')}</span>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
        {machine.readiness === 'ready' ? (
          <div className="flex items-center gap-1.5">
            <Chip icon={Clock3} title={t('common.uptimeTitle')} size="md">{t('common.hoursUp', { hours: (machine.uptimeHours ?? 0).toFixed(0) })}</Chip>
            <Chip tone={(machine.downtimeHours ?? 0) > 0 ? 'amber' : 'slate'} title={t('common.downtimeTitle')} size="md">{t('common.hoursDown', { hours: (machine.downtimeHours ?? 0).toFixed(0) })}</Chip>
          </div>
        ) : (
          <span className="text-xs text-slate-400">{machine.reason ? t(`reason.${machine.reason}`, { defaultValue: machine.reason }) : t('common.notAvailable')}</span>
        )}
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          {t('common.details')} <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </button>
  );
};
