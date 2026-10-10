import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Bell, Gauge, Info } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';
import {
  ApiError, EquipmentProfile, FleetLinkRow, Plant, Prediction, PredictionSeverity,
  apiGetDeviceHealthFleet, apiGetLatestPredictions, apiListEquipment, apiListPlants,
} from '../lib/api';

const PAGE_SIZE = 12;
const SEVERITY_RANK: Record<PredictionSeverity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SEVERITY_STYLE: Record<PredictionSeverity, { ring: string; bg: string; gauge: string }> = {
  none: { ring: 'border-emerald-200 dark:border-emerald-900', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', gauge: 'text-emerald-500 dark:text-emerald-400' },
  low: { ring: 'border-emerald-200 dark:border-emerald-900', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', gauge: 'text-emerald-500 dark:text-emerald-400' },
  medium: { ring: 'border-amber-200 dark:border-amber-900', bg: 'bg-amber-50/60 dark:bg-amber-950/20', gauge: 'text-amber-500 dark:text-amber-400' },
  high: { ring: 'border-rose-200 dark:border-rose-900', bg: 'bg-rose-50/60 dark:bg-rose-950/20', gauge: 'text-rose-500 dark:text-rose-400' },
  critical: { ring: 'border-rose-300 dark:border-rose-800', bg: 'bg-rose-100/60 dark:bg-rose-950/40', gauge: 'text-rose-600 dark:text-rose-400' },
};
const NO_PREDICTION_STYLE = { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-900/40', gauge: 'text-slate-400' };

/** Worst-of across a machine's active scenarios, the same pattern the composed page
 *  uses for its own "worst readiness" summaries. */
function worstOf(predictions: Prediction[]): Prediction | null {
  if (!predictions.length) return null;
  return predictions.reduce((worst, p) => (SEVERITY_RANK[p.severity] > SEVERITY_RANK[worst.severity] ? p : worst));
}

export const ThingsCarePage: React.FC = () => {
  usePageHeader({ title: 'ThingsCare', subtitle: 'Deterministic Scenario Risk' });
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [predictionsByEquipment, setPredictionsByEquipment] = useState<Map<string, Prediction[]>>(new Map());
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetDeviceHealthFleet().then((rows) => { if (live) setLinkHealth(rows); }).catch(() => {});
    apiListEquipment()
      .then(async (list) => {
        if (!live) return;
        setEquipment(list);
        setError(undefined);
        // One call per machine — the backend has no fleet-wide predictions route
        // (asset-scoped by design), so this is the only way to build an overview.
        const entries = await Promise.all(list.map(async (e): Promise<[string, Prediction[]]> => {
          try {
            return [`${e.sourceSystem}|${e.externalId}`, await apiGetLatestPredictions(e.sourceSystem, e.externalId)];
          } catch {
            return [`${e.sourceSystem}|${e.externalId}`, []];
          }
        }));
        if (live) setPredictionsByEquipment(new Map(entries));
      })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load equipment.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const connectionOf = (externalId: string): 'online' | 'offline' | null => {
    const row = linkHealth.find((r) => r.externalId === externalId);
    if (!row) return null;
    return row.state === 'dark' ? 'offline' : 'online';
  };

  const equipmentClasses = useMemo(
    () => [...new Set(equipment.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))].sort(),
    [equipment],
  );
  const equipmentOptions = useMemo(
    () => equipment.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId, label: `${e.name ?? e.externalId} (${e.externalId})` })),
    [equipment],
  );

  const rows = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return equipment
      .map((e) => ({ equipment: e, worst: worstOf(predictionsByEquipment.get(`${e.sourceSystem}|${e.externalId}`) ?? []) }))
      .filter(({ equipment: e }) => {
        const key = `${e.sourceSystem}|${e.externalId}`;
        const matchesSelected = selectedKey === 'all' || key === selectedKey;
        const matchesPlant = scope.plantId === 'all' || e.plantId === scope.plantId;
        const matchesClass = scope.classSlug === 'all' || e.equipmentClassSlug === scope.classSlug;
        const matchesConnection = scope.connection === 'all' || connectionOf(e.externalId) === scope.connection;
        const matchesQuery = !term || (e.name ?? e.externalId).toLowerCase().includes(term) || e.externalId.toLowerCase().includes(term);
        return matchesSelected && matchesPlant && matchesClass && matchesConnection && matchesQuery;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment, predictionsByEquipment, linkHealth, scope, selectedKey]);

  const withPrediction = rows.filter((r) => r.worst !== null);
  const meanRisk = withPrediction.length ? withPrediction.reduce((a, r) => a + r.worst!.riskScore, 0) / withPrediction.length : null;
  const highOrCritical = rows.filter((r) => r.worst && (r.worst.severity === 'high' || r.worst.severity === 'critical')).length;

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = rows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  return (
    <div id="things-care-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Deterministic scoring</span>
          <span title="Risk score is rule-based (Tier 1): 70% worst signal + 30% mean, each vs. baseline. Not a fabricated probability, and there is no remaining-useful-life estimate.">
            <Info className="w-4 h-4 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">ThingsCare: Scenario Risk</h2>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      <EquipmentFilters
        scope={scope}
        onChange={(next) => { setScope(next); setPage(1); }}
        plants={plants}
        classes={equipmentClasses}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={(key) => { setSelectedKey(key); setPage(1); }}
      />

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiTile label="Machines in scope" value={String(rows.length)} />
            <KpiTile label="Mean risk score" value={meanRisk != null ? meanRisk.toFixed(0) : '—'} tone="emerald" />
            <KpiTile label="High / critical" value={String(highOrCritical)} tone="rose" />
            <KpiTile label="No active scenario" value={String(rows.length - withPrediction.length)} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-900 dark:text-white text-base">Machines</h3>
              <span className="text-sm text-slate-400 dark:text-slate-500">{rows.length} machines</span>
            </div>

            {pageItems.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
                No machines match this filter.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pageItems.map(({ equipment: e, worst }) => (
                  <ThingsCareCard
                    key={`${e.sourceSystem}/${e.externalId}`}
                    name={e.name ?? e.externalId}
                    externalId={e.externalId}
                    prediction={worst}
                    onOpen={() => navigate(`/things-care/${encodeURIComponent(e.sourceSystem)}/${encodeURIComponent(e.externalId)}`)}
                  />
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
        </>
      )}
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'emerald' | 'rose' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const ThingsCareCard: React.FC<{ name: string; externalId: string; prediction: Prediction | null; onOpen: () => void }> = ({ name, externalId, prediction, onOpen }) => {
  const style = prediction ? SEVERITY_STYLE[prediction.severity] : NO_PREDICTION_STYLE;
  return (
    <button onClick={onOpen} className={`text-left w-full border ${style.ring} ${style.bg} rounded-xl p-4 shadow-xs space-y-3 hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-center gap-3">
        <span title="Risk score: 0–100, rule-based">
          <RingGauge value={prediction ? prediction.riskScore : null} size={60} colorClass={style.gauge} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
            {prediction ? prediction.severity : 'no scenario'}
          </span>
          <h4 className="font-semibold text-slate-900 dark:text-white text-md truncate mt-0.5" title={name}>{name}</h4>
          <p className="text-sm text-slate-400 dark:text-slate-500 truncate">{externalId}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Chip icon={Gauge} tone={prediction && prediction.riskScore >= 60 ? 'rose' : 'slate'} title="Rule-based composite risk score">
            {prediction ? `${prediction.riskScore} risk` : '—'}
          </Chip>
          <Chip title="How much of the picture was available">{prediction ? prediction.confidence : 'n/a'}</Chip>
          <Chip icon={Bell} tone={prediction && prediction.abnormalCount > 0 ? 'amber' : 'slate'} title="Signals outside baseline">
            {prediction ? prediction.abnormalCount : 0}
          </Chip>
        </div>
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          Details <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </button>
  );
};
