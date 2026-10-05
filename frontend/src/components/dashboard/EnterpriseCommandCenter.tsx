import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowUpRight, Bell, Box, CheckCircle2, Clock3, Fuel, MapPin, Search, Wrench } from 'lucide-react';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../fleet/FleetFilters';
import { FLEET, isBreaching, weeklyPerformanceFor } from '../../data/fleetMockData';
import { MOCK_WORK_ORDERS } from '../../data/clientOpsMockData';
import { SiteScene, SiteInsights } from './SiteScene';
import { PerformanceTrend } from './PerformanceTrend';

const TONE_STYLE: Record<string, string> = {
  neutral: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400',
  positive: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400',
  negative: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400',
  maintenance: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400',
};

export const EnterpriseCommandCenter: React.FC = () => {
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const visible = useMemo(() => matchingFleet(FLEET, scope), [scope]);

  const online = visible.filter((t) => !t.offline).length;
  const offline = visible.length - online;
  const alerts = visible.filter(isBreaching);
  const perf = useMemo(() => visible.map((t) => ({ id: t.id, p: weeklyPerformanceFor(t) })), [visible]);
  const openOrders = alerts.length + MOCK_WORK_ORDERS.filter((o) => o.status === 'Open' || o.status === 'In Progress').length;
  const oeeWeek = perf.length ? perf.reduce((n, x) => n + (x.p.availability / 100) * (x.p.performance / 100) * (x.p.quality / 100), 0) / perf.length * 100 : 0;
  const uptimeHours = perf.reduce((n, x) => n + x.p.workingHours, 0);
  const downtimeHours = perf.reduce((n, x) => n + x.p.breakdownHours, 0);

  const kpis = [
    { label: 'Total Things', value: visible.length, icon: Box, tone: 'neutral' },
    { label: 'Online', value: online, icon: CheckCircle2, tone: 'positive' },
    { label: 'Offline', value: offline, icon: Fuel, tone: 'neutral' },
    { label: 'Active alerts', value: alerts.length, icon: Bell, tone: 'negative' },
    { label: 'Work orders', value: openOrders, icon: Wrench, tone: 'maintenance' },
    { label: 'OEE (week)', value: `${oeeWeek.toFixed(1)}%`, icon: Activity, tone: 'neutral' },
    { label: 'Uptime hours', value: Math.round(uptimeHours), icon: Clock3, tone: 'neutral' },
    { label: 'Downtime hours', value: Math.round(downtimeHours), icon: Clock3, tone: 'neutral' },
  ];

  const visibleOrders = MOCK_WORK_ORDERS.filter((o) => o.status === 'Open' || o.status === 'In Progress');

  return (
    <div id="enterprise-command-center" className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Enterprise Command Center</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Construction sites, Things performance and maintenance priorities.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {kpis.map((k) => (
          <div key={k.label} className="flex items-center gap-2.5 p-3 border-r border-b sm:border-b-0 border-slate-100 dark:border-slate-800 last:border-r-0">
            <span className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${TONE_STYLE[k.tone]}`}><k.icon className="w-4 h-4" /></span>
            <div className="min-w-0">
              <strong className="block text-lg font-bold text-slate-900 dark:text-white leading-tight">{k.value}</strong>
              <span className="block text-[10px] text-slate-500 dark:text-slate-400 truncate">{k.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <SiteScene things={visible} onOpen={(id) => navigate(`/dashboard/${id}`)} />
        <SiteInsights things={visible} onOpen={(id) => navigate(`/dashboard/${id}`)} />
      </div>

      <PerformanceTrend thingsCount={visible.length} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Attention &amp; next actions</h3>
          <Bell className="w-4 h-4 text-slate-400" />
        </div>
        <div className="space-y-2">
          {alerts.slice(0, 3).map((t) => (
            <button key={t.id} onClick={() => navigate(`/alerts`)} className="w-full text-left flex items-center justify-between gap-3 border border-slate-100 dark:border-slate-800 rounded-lg p-3 hover:border-rose-200">
              <div>
                <span className="inline-block px-1.5 py-0.5 text-[9px] font-medium rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 mb-1">Alert</span>
                <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Coolant temperature: {t.coolantNowC.toFixed(2)} °C · outside configured range</p>
              </div>
              <span className="text-[11px] text-sky-700 dark:text-sky-400 inline-flex items-center gap-1 shrink-0">Review alerts <ArrowUpRight className="w-3 h-3" /></span>
            </button>
          ))}
          {visibleOrders.slice(0, 2).map((o) => (
            <button key={o.id} onClick={() => navigate('/work-orders')} className="w-full text-left flex items-center justify-between gap-3 border border-slate-100 dark:border-slate-800 rounded-lg p-3 hover:border-amber-200">
              <div>
                <span className="inline-block px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 mb-1">Maintenance</span>
                <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{o.title}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{o.equipmentName} · Open work order</p>
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

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Things</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">Select a Thing to inspect readings and existing maintenance records.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((t) => {
            const p = weeklyPerformanceFor(t);
            const breach = isBreaching(t);
            return (
              <button key={t.id} onClick={() => navigate(`/dashboard/${t.id}`)} className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 transition-colors space-y-2">
                <div className="flex items-center justify-between">
                  <span className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 flex items-center justify-center"><Box className="w-4 h-4" /></span>
                  <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${t.offline ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'}`}>
                    {t.offline ? 'Offline' : 'Online'}
                  </span>
                </div>
                <h4 className="font-semibold text-slate-900 dark:text-white text-sm leading-snug">{t.name}</h4>
                <p className="text-[12px] text-slate-500 dark:text-slate-400">{t.id} · {t.category}</p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 flex items-center gap-1"><MapPin className="w-3 h-3" />{t.location}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">OEE {((p.availability / 100) * (p.performance / 100) * (p.quality / 100) * 100).toFixed(1)}% · Uptime {p.workingHours} h · Downtime {p.breakdownHours} h</p>
                <div className="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
                  {breach ? (
                    <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">Action required</span>
                  ) : (
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">Health not assessed</span>
                  )}
                  <ArrowUpRight className="w-4 h-4 text-slate-300" />
                </div>
              </button>
            );
          })}
        </div>
        {!visible.length && (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
            <Search className="w-6 h-6" /> No Things match these filters.
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Financial impact</span>
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm mt-1">Fuel savings and wastage</h3>
        <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">Sample week · rates effective 23 September 2026 · configured fuel baseline.</p>
        <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-3">
          Configure fuel rates and baselines in Cost Administration to see net savings here. Equipment-level ROI appears on each Thing&apos;s detail page.
        </p>
      </div>
    </div>
  );
};
