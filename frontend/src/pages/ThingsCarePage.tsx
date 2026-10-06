import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, FleetThing, ThingsCareStatus, thingsCareFor } from '../data/fleetMockData';

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
    <div id="things-care-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Machine Wellbeing</span>
        <h2 className="text-xl font-bold">ThingsCare: Health &amp; Prognostics</h2>
        <p className="text-sm text-sky-100">Condition, degradation, sample prognosis and maintenance priorities.</p>
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
        <KpiTile label="Sample mean health" value={meanHealth != null ? `${meanHealth.toFixed(1)}%` : '—'} />
        <KpiTile label="Active range alerts" value={String(activeAlerts)} />
        <KpiTile label="Sample risk ≥ 20%" value={String(highRisk)} />
      </div>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">Health, failure probability and RUL are illustrative sample fixtures, not validated predictions.</p>

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

const KpiTile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
    <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
    <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
  </div>
);

const ThingsCareCard: React.FC<{ thing: FleetThing; status: ThingsCareStatus; onOpen: () => void }> = ({ thing, status, onOpen }) => {
  const state: 'healthy' | 'at-risk' | 'offline' = status.health == null ? 'offline' : status.alertCount > 0 ? 'at-risk' : 'healthy';
  const styles = {
    healthy: { ring: 'border-emerald-200 dark:border-emerald-900', badge: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400', label: 'Healthy' },
    'at-risk': { ring: 'border-amber-200 dark:border-amber-900', badge: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400', label: 'At risk' },
    offline: { ring: 'border-slate-200 dark:border-slate-800', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400', label: 'Not assessed' },
  }[state];

  return (
    <div className={`bg-white dark:bg-slate-900 border ${styles.ring} rounded-xl p-4 shadow-xs space-y-2`}>
      <div className="flex items-center justify-between">
        <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${styles.badge}`}>{styles.label}</span>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">{status.alertCount} alert{status.alertCount === 1 ? '' : 's'}</span>
      </div>
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={thing.name}>{thing.name}</h4>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
      <div className="grid grid-cols-2 gap-2 pt-1">
        <div>
          <div className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{status.health != null ? `${status.health}%` : '—'}</div>
          <div className="text-[10px] text-slate-400 dark:text-slate-500">Health</div>
        </div>
        <div>
          <div className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{status.rulHours != null ? `${status.rulHours} h` : '—'}</div>
          <div className="text-[10px] text-slate-400 dark:text-slate-500">Illustrative RUL</div>
        </div>
      </div>
      <button onClick={onOpen} className="w-full mt-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
        Open ThingsCare details
      </button>
    </div>
  );
};
