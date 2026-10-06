import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, FleetThing } from '../data/fleetMockData';
import { MOCK_INCIDENTS, ShieldIncident, ShieldSummary, shieldSummaryFor } from '../data/shieldMockData';
import { IncidentManagementSection } from '../components/shield/IncidentManagementSection';

const PAGE_SIZE = 12;

export const ThingsShieldPage: React.FC = () => {
  usePageHeader({ title: 'ThingsShield', subtitle: 'Safety, Compliance & Risk' });
  const navigate = useNavigate();
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [page, setPage] = useState(1);
  const [incidents, setIncidents] = useState<ShieldIncident[]>(MOCK_INCIDENTS);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const summaries = useMemo(() => new Map(matching.map((t) => [t.id, shieldSummaryFor(t, incidents)])), [matching, incidents]);
  const matchingIds = useMemo(() => new Set(matching.map((t) => t.id)), [matching]);

  const totals = useMemo(() => {
    const values = matching.map((t) => summaries.get(t.id)!);
    return values.reduce(
      (acc, s) => ({
        evidenceRecords: acc.evidenceRecords + s.evidenceRecords,
        currentPassed: acc.currentPassed + s.currentPassed,
        overdueFailed: acc.overdueFailed + s.overdueFailed,
        dueSoon: acc.dueSoon + s.dueSoon,
        openIncidents: acc.openIncidents + s.openIncidents,
      }),
      { evidenceRecords: 0, currentPassed: 0, overdueFailed: 0, dueSoon: 0, openIncidents: 0 },
    );
  }, [matching, summaries]);

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = matching.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const visibleIncidents = incidents.filter((i) => matchingIds.has(i.equipmentCode));

  function changeScope(next: typeof scope) {
    setScope(next);
    setPage(1);
  }

  return (
    <div id="things-shield-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">People · Machines · Evidence</span>
        <h2 className="text-xl font-bold">ThingsShield: Safety, Compliance &amp; Risk</h2>
        <p className="text-sm text-sky-100">Inspections, site requirements, safety records and corrective actions.</p>
      </div>

      <FleetFilters
        scope={scope}
        onChange={changeScope}
        things={matching}
        selectedId="all"
        onSelectId={(id) => { if (id !== 'all') navigate(`/things-shield/${id}`); }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Evidence records" value={String(totals.evidenceRecords)} />
        <KpiTile label="Current & passed" value={String(totals.currentPassed)} tone="good" />
        <KpiTile label="Overdue / failed" value={String(totals.overdueFailed)} tone="bad" />
        <KpiTile label="Open incidents" value={String(totals.openIncidents)} tone="warn" />
      </div>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">Sample records demonstrate review workflows; they are not real inspection certificates or regulatory findings.</p>

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
              <ShieldCard key={t.id} thing={t} summary={summaries.get(t.id)!} onOpen={() => navigate(`/things-shield/${t.id}`)} />
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

      <IncidentManagementSection things={matching} visibleIncidents={visibleIncidents} setIncidents={setIncidents} />
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'good' | 'bad' | 'warn' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className={`text-xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const ShieldCard: React.FC<{ thing: FleetThing; summary: ShieldSummary; onOpen: () => void }> = ({ thing, summary, onOpen }) => {
  const alert = summary.overdueFailed > 0 || summary.openIncidents > 0;
  const style = alert
    ? 'border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-950/20'
    : 'border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20';

  return (
    <div className={`border rounded-xl p-4 shadow-xs space-y-2 ${style}`}>
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={thing.name}>{thing.name}</h4>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
      <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{summary.evidenceRecords} evidence records</p>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">{summary.overdueFailed} overdue/failed · {summary.openIncidents} open incidents</p>
      <button onClick={onOpen} className="w-full mt-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
        Open ThingsShield details
      </button>
    </div>
  );
};
