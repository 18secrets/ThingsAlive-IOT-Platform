import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, FleetThing } from '../data/fleetMockData';
import { ProductionSummary, productionSummaryFor } from '../data/productionMockData';

const PAGE_SIZE = 12;

export const ProductionMonitoringPage: React.FC = () => {
  usePageHeader({ title: 'Production Monitoring', subtitle: 'Output & Performance' });
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [page, setPage] = useState(1);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const summaries = useMemo(() => new Map(matching.map((t) => [t.id, productionSummaryFor(t)])), [matching]);

  const totals = useMemo(() => {
    const values = matching.map((t) => summaries.get(t.id)!);
    const meanOee = values.length ? values.reduce((a, s) => a + s.oeePercent, 0) / values.length : 0;
    return {
      count: matching.length,
      meanOee,
      uptimeSum: values.reduce((a, s) => a + s.uptimeHours, 0),
      downtimeSum: values.reduce((a, s) => a + s.downtimeHours, 0),
    };
  }, [matching, summaries]);

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = matching.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  function changeScope(next: typeof scope) {
    setScope(next);
    setPage(1);
  }

  return (
    <div id="production-monitoring-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Production Wellbeing</span>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Performance</h2>
        <p className="text-sm text-sky-100">Output, quality, equipment availability and next-shift planning.</p>
      </div>

      <FleetFilters
        scope={scope}
        onChange={changeScope}
        things={matching}
        selectedId="all"
        onSelectId={(id) => { if (id !== 'all') navigate(`/production-monitoring/${id}`); }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Things with production KPIs" value={String(totals.count)} />
        <KpiTile label="Mean OEE" value={`${totals.meanOee.toFixed(1)}%`} />
        <KpiTile label="Uptime (sum)" value={`${totals.uptimeSum.toFixed(1)} h`} />
        <KpiTile label="Downtime (sum)" value={`${totals.downtimeSum.toFixed(1)} h`} tone="warn" />
      </div>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">Sample machine counts are not finished-line throughput. Projections assume the recent production pattern continues.</p>

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
              <ProductionCard key={t.id} thing={t} summary={summaries.get(t.id)!} onOpen={() => navigate(`/production-monitoring/${t.id}`)} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-[12px] text-slate-500 dark:text-slate-400 mt-4">
          <span>Page {pageSafe} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <button disabled={pageSafe <= 1} onClick={() => setPage((p) => p - 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40">
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button disabled={pageSafe >= pageCount} onClick={() => setPage((p) => p + 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40">
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'warn' }> = ({ label, value, tone }) => (
  <div className={`border rounded-xl p-4 shadow-xs ${tone === 'warn' ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'}`}>
    <div className={`text-xl font-bold ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
    <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
  </div>
);

const ProductionCard: React.FC<{ thing: FleetThing; summary: ProductionSummary; onOpen: () => void }> = ({ thing, summary, onOpen }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
    <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={thing.name}>{thing.name}</h4>
    <p className="text-[11px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
    <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{summary.oeePercent.toFixed(1)}% OEE</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">{summary.uptimeHours.toFixed(1)} h uptime · {summary.downtimeHours.toFixed(1)} h downtime</p>
    <p className="text-[11px] text-slate-400 dark:text-slate-500">Output projection not applicable</p>
    <button onClick={onOpen} className="w-full mt-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-400">
      Open production details
    </button>
  </div>
);
