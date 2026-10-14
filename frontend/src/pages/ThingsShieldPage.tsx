import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronLeft, ChevronRight, ShieldCheck, ShieldAlert, Info, Siren } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import { Chip } from '../components/common/Chip';
import { STATUS_LABEL } from '../components/shield/EvidenceRecord';
import {
  ApiError, Plant, SHIELD_CATEGORIES, ShieldCategory, ShieldMachine, ShieldStatus, ShieldSummary,
  apiGetShieldSummary, apiListPlants,
} from '../lib/api';

const PAGE_SIZE = 12;

const CATEGORY_LABEL: Record<ShieldCategory, string> = { compliance: 'Compliance', safety: 'Safety', security: 'Security' };

const STATUS_TONE: Record<ShieldStatus, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  current: 'emerald', due_soon: 'amber', overdue: 'rose', action_required: 'rose', not_recorded: 'slate',
};

const needsAttention = (m: ShieldMachine) =>
  SHIELD_CATEGORIES.some((c) => ['action_required', 'overdue'].includes(m.categories[c].status));

export const ThingsShieldPage: React.FC = () => {
  usePageHeader({ title: 'ThingsShield', subtitle: 'Safety, Compliance & Risk' });
  const navigate = useNavigate();
  const [summary, setSummary] = useState<ShieldSummary | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let live = true;
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetShieldSummary()
      .then((s) => { if (live) { setSummary(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load ThingsShield.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const machines = summary?.machines ?? [];
  const classes = useMemo(
    () => [...new Set(machines.map((m) => m.machine.classSlug).filter((s): s is string => !!s))].sort(),
    [machines],
  );
  const equipmentOptions = useMemo(
    () => machines.map((m) => ({ sourceSystem: m.machine.sourceSystem, externalId: m.machine.externalId, label: `${m.machine.name ?? m.machine.externalId} (${m.machine.externalId})` })),
    [machines],
  );

  const matching = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return machines.filter((m) => {
      const key = `${m.machine.sourceSystem}|${m.machine.externalId}`;
      return (selectedKey === 'all' || key === selectedKey)
        && (scope.plantId === 'all' || m.machine.plantId === scope.plantId)
        && (scope.classSlug === 'all' || m.machine.classSlug === scope.classSlug)
        && (!term || (m.machine.name ?? '').toLowerCase().includes(term) || m.machine.externalId.toLowerCase().includes(term));
    });
  }, [machines, scope, selectedKey]);

  // Recounted over the filtered machines so the tiles always describe the cards below
  // them; the backend's own `counts` cover the whole account.
  const totals = useMemo(() => {
    const t: Record<ShieldStatus, number> = { action_required: 0, overdue: 0, due_soon: 0, current: 0, not_recorded: 0 };
    for (const m of matching) for (const c of SHIELD_CATEGORIES) t[m.categories[c].status] += 1;
    return t;
  }, [matching]);

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = matching.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const open = (m: ShieldMachine) => navigate(`/things-shield/${encodeURIComponent(m.machine.sourceSystem)}/${encodeURIComponent(m.machine.externalId)}`);

  return (
    <div id="things-shield-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">People · Machines · Evidence</span>
          <span title="Each machine has a compliance, a safety and a security status, read from its latest check record. A check nobody has recorded counts as not recorded.">
            <Info className="w-4 h-4 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">ThingsShield: Safety, Compliance &amp; Risk</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <EquipmentFilters
        scope={scope}
        onChange={(next) => { setScope(next); setPage(1); }}
        plants={plants}
        classes={classes}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={(key) => { setSelectedKey(key); setPage(1); }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <KpiTile label="Action required" value={totals.action_required} tone="bad" />
        <KpiTile label="Overdue" value={totals.overdue} tone="bad" />
        <KpiTile label="Due soon" value={totals.due_soon} tone="warn" />
        <KpiTile label="Current" value={totals.current} tone="good" />
        <KpiTile label="Not recorded" value={totals.not_recorded} />
      </div>
      <p className="text-[11px] text-slate-400">Counted per machine and category: each machine has three checks.</p>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Machines</h3>
          <span className="text-sm text-slate-400 dark:text-slate-500">{matching.length} machines</span>
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : pageItems.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            No machines match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pageItems.map((m) => (
              <ShieldCard key={`${m.machine.sourceSystem}/${m.machine.externalId}`} machine={m} onOpen={() => open(m)} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400 mt-4">
          <span>Page {pageSafe} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <button disabled={pageSafe <= 1} onClick={() => setPage((p) => p - 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer">
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <button disabled={pageSafe >= pageCount} onClick={() => setPage((p) => p + 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Incidents have their own backend and page; the mock section that used to sit
          here showed invented incidents beside real evidence. */}
      <button
        onClick={() => navigate('/incident-management')}
        className="w-full flex items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 cursor-pointer text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <Siren className="w-4 h-4 text-amber-500" /> Incidents are tracked in Incident Management
        </span>
        <ChevronRight className="w-4 h-4 text-slate-400" />
      </button>
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: number; tone?: 'good' | 'bad' | 'warn' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const ShieldCard: React.FC<{ machine: ShieldMachine; onOpen: () => void }> = ({ machine, onOpen }) => {
  const alert = needsAttention(machine);
  const style = alert
    ? 'border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-950/20'
    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900';
  return (
    <button onClick={onOpen} className={`text-left w-full border rounded-xl p-4 shadow-xs space-y-2.5 hover:shadow-md transition-shadow cursor-pointer group ${style}`}>
      <div className="flex items-center gap-2">
        <span title={alert ? 'Needs attention — a failed or overdue check' : 'No failed or overdue checks'}>
          {alert ? <ShieldAlert className="w-6 h-6 text-rose-600 dark:text-rose-400 shrink-0" /> : <ShieldCheck className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate" title={machine.machine.name ?? machine.machine.externalId}>
            {machine.machine.name ?? machine.machine.externalId}
          </h4>
          <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{machine.machine.externalId}{machine.machine.classSlug ? ` · ${machine.machine.classSlug}` : ''}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-200/70 dark:border-slate-800">
        <div className="flex items-center gap-1.5 flex-wrap">
          {SHIELD_CATEGORIES.map((c) => (
            <Chip key={c} tone={STATUS_TONE[machine.categories[c].status]} title={`${CATEGORY_LABEL[c]}: ${STATUS_LABEL[machine.categories[c].status]}`}>
              {CATEGORY_LABEL[c]}
            </Chip>
          ))}
        </div>
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          Details <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </button>
  );
};
