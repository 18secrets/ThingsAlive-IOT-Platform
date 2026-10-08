import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Bell, Clock3, Info, ShieldAlert } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, FleetThing, ThingsCareStatus, thingsCareFor } from '../data/fleetMockData';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';

const PAGE_SIZE = 12;

export const ThingsCarePage: React.FC = () => {
  usePageHeader({ title: 'ThingsCare', subtitle: 'Health & Prognostics' });
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [page, setPage] = useState(1);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const statuses = useMemo(() => new Map(matching.map((t) => [t.id, thingsCareFor(t)])), [matching]);

  const meanHealth = useMemo(() => {
    const healths = matching.map((t) => statuses.get(t.id)!.health).filter((h): h is number => h != null);
    return healths.length ? healths.reduce((a, b) => a + b, 0) / healths.length : null;
  }, [matching, statuses]);
  const activeAlerts = matching.reduce((n, t) => n + statuses.get(t.id)!.alertCount, 0);
  const highRisk = matching.filter((t) => (statuses.get(t.id)!.riskPct ?? 0) >= 20).length;

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = matching.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  function changeScope(next: typeof scope) {
    setScope(next);
    setPage(1);
  }

  return (
    <div id="things-care-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Machine Wellbeing</span>
          <span title="Health, risk and RUL are illustrative sample fixtures, not validated predictions.">
            <Info className="w-3.5 h-3.5 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">ThingsCare: Health &amp; Prognostics</h2>
      </div>

      <FleetFilters
        scope={scope}
        onChange={changeScope}
        things={matching}
        selectedId="all"
        onSelectId={(id) => { if (id !== 'all') navigate(`/things-care/${id}`); }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Things in scope" value={String(matching.length)} />
        <KpiTile label="Mean health" value={meanHealth != null ? `${meanHealth.toFixed(0)}%` : '—'} tone="emerald" />
        <KpiTile label="Active alerts" value={String(activeAlerts)} tone="amber" />
        <KpiTile label="Risk ≥ 20%" value={String(highRisk)} tone="rose" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Things overview</h3>
          <span className="text-[12px] text-slate-400 dark:text-slate-500">{matching.length} Things</span>
        </div>

        {pageItems.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            No Things match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pageItems.map((t) => (
              <ThingsCareCard key={t.id} thing={t} status={statuses.get(t.id)!} onOpen={() => navigate(`/things-care/${t.id}`)} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-[12px] text-slate-500 dark:text-slate-400 mt-4">
          <span>Page {pageSafe} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <button
              disabled={pageSafe <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button
              disabled={pageSafe >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'emerald' | 'amber' | 'rose' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className={`text-xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const STATE_STYLE = {
  healthy: { ring: 'border-emerald-200 dark:border-emerald-900', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', gauge: 'text-emerald-500 dark:text-emerald-400', badge: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400', label: 'Healthy' },
  'at-risk': { ring: 'border-amber-200 dark:border-amber-900', bg: 'bg-amber-50/60 dark:bg-amber-950/20', gauge: 'text-amber-500 dark:text-amber-400', badge: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400', label: 'At risk' },
  offline: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-900/40', gauge: 'text-slate-400', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400', label: 'Offline' },
} as const;

const ThingsCareCard: React.FC<{ thing: FleetThing; status: ThingsCareStatus; onOpen: () => void }> = ({ thing, status, onOpen }) => {
  const state: 'healthy' | 'at-risk' | 'offline' = status.health == null ? 'offline' : status.alertCount > 0 ? 'at-risk' : 'healthy';
  const style = STATE_STYLE[state];

  return (
    <button onClick={onOpen} className={`text-left w-full border ${style.ring} ${style.bg} rounded-xl p-4 shadow-xs space-y-3 hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-center gap-3">
        <span title="Sample health index">
          <RingGauge value={status.health} size={52} colorClass={style.gauge} />
        </span>
        <div className="min-w-0 flex-1">
          <span className={`inline-block px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded ${style.badge}`}>{style.label}</span>
          <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate mt-0.5" title={thing.name}>{thing.name}</h4>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{thing.id} · {thing.location}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Chip icon={ShieldAlert} tone={status.riskPct != null && status.riskPct >= 20 ? 'rose' : 'slate'} title="Illustrative sample failure risk">
            {status.riskPct != null ? `${status.riskPct}%` : '—'}
          </Chip>
          <Chip icon={Clock3} title="Illustrative remaining useful life (RUL)">{status.rulHours != null ? `${status.rulHours}h` : '—'}</Chip>
          <Chip icon={Bell} tone={status.alertCount > 0 ? 'amber' : 'slate'} title="Active configured range alerts">{status.alertCount}</Chip>
        </div>
        <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          Details <ChevronRight className="w-3 h-3" />
        </span>
      </div>
    </button>
  );
};
