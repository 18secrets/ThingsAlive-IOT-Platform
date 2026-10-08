import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowUpRight, Bell, Box, CheckCircle2, ChevronLeft, ChevronRight, Clock3, MapPin, Search } from 'lucide-react';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../fleet/FleetFilters';
import { FLEET, isBreaching, weeklyPerformanceFor } from '../../data/fleetMockData';
import { MOCK_WORK_ORDERS } from '../../data/clientOpsMockData';
import { SiteScene } from './SiteScene';
import { PerformanceTrend } from './PerformanceTrend';
import { Chip } from '../common/Chip';

const PAGE_SIZE = 12;

export const EnterpriseCommandCenter: React.FC = () => {
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [page, setPage] = useState(1);
  const visible = useMemo(() => matchingFleet(FLEET, scope), [scope]);

  const online = visible.filter((t) => !t.offline).length;
  const offline = visible.length - online;
  const alerts = visible.filter(isBreaching);
  const perf = useMemo(() => visible.map((t) => ({ id: t.id, p: weeklyPerformanceFor(t) })), [visible]);
  const openOrders = alerts.length + MOCK_WORK_ORDERS.filter((o) => o.status === 'Open' || o.status === 'In Progress').length;
  const oeeWeek = perf.length ? perf.reduce((n, x) => n + (x.p.availability / 100) * (x.p.performance / 100) * (x.p.quality / 100), 0) / perf.length * 100 : 0;
  const uptimeHours = perf.reduce((n, x) => n + x.p.workingHours, 0);
  const downtimeHours = perf.reduce((n, x) => n + x.p.breakdownHours, 0);

  const kpis: { label: string; value: string; tone?: 'emerald' | 'amber' | 'rose' }[] = [
    { label: 'Total Things', value: String(visible.length) },
    { label: 'Online', value: String(online), tone: 'emerald' },
    { label: 'Offline', value: String(offline) },
    { label: 'Active alerts', value: String(alerts.length), tone: 'rose' },
    { label: 'Work orders', value: String(openOrders), tone: 'amber' },
    { label: 'OEE (week)', value: `${oeeWeek.toFixed(1)}%` },
    { label: 'Uptime hours', value: String(Math.round(uptimeHours)) },
    { label: 'Downtime hours', value: String(Math.round(downtimeHours)), tone: 'amber' },
  ];

  const visibleOrders = MOCK_WORK_ORDERS.filter((o) => o.status === 'Open' || o.status === 'In Progress');

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = visible.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  function changeScope(next: typeof scope) {
    setScope(next);
    setPage(1);
  }

  return (
    <div id="enterprise-command-center" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Enterprise Command Center</h2>
        <p className="text-sm text-sky-100">Construction sites, Things performance and maintenance priorities.</p>
      </div>

      <FleetFilters scope={scope} onChange={changeScope} />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {kpis.map((k) => <KpiTile key={k.label} label={k.label} value={k.value} tone={k.tone} />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <SiteScene things={visible} onOpen={(id) => navigate(`/dashboard/${id}`)} />
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs h-[360px] flex flex-col">
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h3 className="font-semibold text-slate-900 dark:text-white text-base">Attention &amp; next actions</h3>
            <Bell className="w-4 h-4 text-slate-400" />
          </div>
          <div className="space-y-2 overflow-y-auto min-h-0 flex-1">
            {alerts.slice(0, 3).map((t) => (
              <button key={t.id} onClick={() => navigate(`/alerts`)} className="w-full text-left flex items-center justify-between gap-3 border border-slate-100 dark:border-slate-800 rounded-lg p-3 hover:border-rose-200">
                <div>
                  <span className="inline-block px-1.5 py-0.5 text-[10px] font-medium rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 mb-1">Alert</span>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Coolant temperature: {t.coolantNowC.toFixed(2)} °C · outside configured range</p>
                </div>
                <span className="text-xs text-sky-700 dark:text-sky-400 inline-flex items-center gap-1 shrink-0">Review alerts <ArrowUpRight className="w-3.5 h-3.5" /></span>
              </button>
            ))}
            {visibleOrders.slice(0, 2).map((o) => (
              <button key={o.id} onClick={() => navigate('/work-orders')} className="w-full text-left flex items-center justify-between gap-3 border border-slate-100 dark:border-slate-800 rounded-lg p-3 hover:border-amber-200">
                <div>
                  <span className="inline-block px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 mb-1">Maintenance</span>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{o.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{o.equipmentName} · Open work order</p>
                </div>
              </button>
            ))}
            {!alerts.length && !visibleOrders.length && (
              <div className="text-center py-6 text-slate-400 text-sm flex flex-col items-center gap-2">
                <CheckCircle2 className="w-6 h-6" /> No recorded actions in this selection.
              </div>
            )}
          </div>
        </div>
      </div>

      <PerformanceTrend thingsCount={visible.length} />

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-base">Things</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Select a Thing to inspect readings and existing maintenance records.</p>
          </div>
          <span className="text-sm text-slate-400 dark:text-slate-500">{visible.length} Things</span>
        </div>

        {pageItems.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
            <Search className="w-6 h-6" /> No Things match these filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pageItems.map((t) => {
              const p = weeklyPerformanceFor(t);
              const breach = isBreaching(t);
              const oee = (p.availability / 100) * (p.performance / 100) * (p.quality / 100) * 100;
              return (
                <button key={t.id} onClick={() => navigate(`/dashboard/${t.id}`)} className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 transition-colors space-y-2 group">
                  <div className="flex items-center justify-between">
                    <span className="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 flex items-center justify-center"><Box className="w-4.5 h-4.5" /></span>
                    <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${t.offline ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'}`}>
                      {t.offline ? 'Offline' : 'Online'}
                    </span>
                  </div>
                  <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">{t.name}</h4>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t.id} · {t.category}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{t.location}</p>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Chip icon={Activity} title="Illustrative OEE" size="md">{oee.toFixed(0)}%</Chip>
                      <Chip icon={Clock3} title="Uptime hours" size="md">{p.workingHours}h</Chip>
                      <Chip icon={AlertTriangle} tone={breach ? 'rose' : 'slate'} title="Downtime hours" size="md">{p.breakdownHours}h</Chip>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all shrink-0">
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400 mt-4">
          <span>Page {pageSafe} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <button
              disabled={pageSafe <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <button
              disabled={pageSafe >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Financial impact</span>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mt-1">Fuel savings and wastage</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Sample week · rates effective 23 September 2026 · configured fuel baseline.</p>
        <p className="text-sm text-slate-400 dark:text-slate-500 mt-3">
          Configure fuel rates and baselines in Cost Administration to see net savings here. Equipment-level ROI appears on each Thing&apos;s detail page.
        </p>
      </div> */}
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'emerald' | 'amber' | 'rose' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2 shadow-xs flex flex-col items-center justify-center">
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};
