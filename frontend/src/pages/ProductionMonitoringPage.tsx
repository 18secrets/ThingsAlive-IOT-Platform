import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Clock3, AlertTriangle, Info } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, FleetThing } from '../data/fleetMockData';
import { ProductionSummary, productionSummaryFor } from '../data/productionMockData';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';

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
    <div id="production-monitoring-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">Production Wellbeing</span>
          <span title="Sample machine counts are not finished-line throughput. Projections assume the recent production pattern continues.">
            <Info className="w-3.5 h-3.5 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Performance</h2>
      </div>

      <FleetFilters
        scope={scope}
        onChange={changeScope}
        things={matching}
        selectedId="all"
        onSelectId={(id) => { if (id !== 'all') navigate(`/production-monitoring/${id}`); }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Things in scope" value={String(totals.count)} />
        <KpiTile label="Mean OEE" value={`${totals.meanOee.toFixed(0)}%`} />
        <KpiTile label="Uptime" value={`${totals.uptimeSum.toFixed(0)}h`} />
        <KpiTile label="Downtime" value={`${totals.downtimeSum.toFixed(0)}h`} tone="warn" />
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

const OEE_STYLE = {
  good: { ring: 'border-emerald-200 dark:border-emerald-900', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', gauge: 'text-emerald-500 dark:text-emerald-400' },
  fair: { ring: 'border-amber-200 dark:border-amber-900', bg: 'bg-amber-50/60 dark:bg-amber-950/20', gauge: 'text-amber-500 dark:text-amber-400' },
  poor: { ring: 'border-rose-200 dark:border-rose-900', bg: 'bg-rose-50/60 dark:bg-rose-950/20', gauge: 'text-rose-500 dark:text-rose-400' },
} as const;

const ProductionCard: React.FC<{ thing: FleetThing; summary: ProductionSummary; onOpen: () => void }> = ({ thing, summary, onOpen }) => {
  const level: 'good' | 'fair' | 'poor' = summary.oeePercent >= 75 ? 'good' : summary.oeePercent >= 60 ? 'fair' : 'poor';
  const style = OEE_STYLE[level];
  return (
    <button onClick={onOpen} className={`text-left w-full border ${style.ring} ${style.bg} rounded-xl p-4 shadow-xs space-y-3 hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-center gap-3">
        <span title="Illustrative OEE — uses the existing demonstration assumptions.">
          <RingGauge value={summary.oeePercent} size={52} colorClass={style.gauge} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={thing.name}>{thing.name}</h4>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{thing.id} · {thing.location}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5">
          <Chip icon={Clock3} title="Uptime hours">{summary.uptimeHours.toFixed(0)}h</Chip>
          <Chip icon={AlertTriangle} tone={summary.downtimeHours > 0 ? 'amber' : 'slate'} title="Downtime hours">{summary.downtimeHours.toFixed(0)}h</Chip>
        </div>
        <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          Details <ChevronRight className="w-3 h-3" />
        </span>
      </div>
    </button>
  );
};
