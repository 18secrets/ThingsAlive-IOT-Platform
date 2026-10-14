import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronRight, Info, Sparkles } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import { Chip } from '../components/common/Chip';
import {
  ApiError, ClientScenario, EquipmentProfile, Plant, Prediction, PredictionSeverity,
  apiEditMyCatalogScenario, apiGetLatestPredictions, apiListEquipment, apiListMyCatalogScenarios, apiListPlants,
} from '../lib/api';

const SEVERITY_ORDER: PredictionSeverity[] = ['none', 'low', 'medium', 'high', 'critical'];
const SEVERITY_TONE: Record<PredictionSeverity, 'emerald' | 'sky' | 'amber' | 'rose' | 'slate'> = {
  none: 'emerald', low: 'sky', medium: 'amber', high: 'rose', critical: 'rose',
};

/**
 * Live Predictions on the backend: the account's prediction scenarios, and each
 * machine's latest scored predictions. Two things the mock showed are gone because
 * nothing produces them — authoring a new scenario (clients tune the library's, they
 * don't write their own) and the 8-hour fuel forecast; each machine's card shows its
 * real prediction severity instead.
 */
export const LivePredictionsPage: React.FC = () => {
  usePageHeader({ title: 'Live Predictions', subtitle: 'Automated Dispatch' });
  const navigate = useNavigate();
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [scenarios, setScenarios] = useState<ClientScenario[] | null>(null);
  const [predictions, setPredictions] = useState<Map<string, Prediction[] | 'unavailable'>>(new Map());
  const [error, setError] = useState<string | undefined>(undefined);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');

  useEffect(() => {
    let live = true;
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiListMyCatalogScenarios().then((s) => { if (live) setScenarios(s); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load prediction scenarios.'); });
    apiListEquipment().then((list) => {
      if (!live) return;
      setEquipment(list);
      // One call per machine — there is no fleet-wide predictions route. Each lands as it
      // arrives, so a slow or refused machine never holds the rest back.
      for (const m of list) {
        apiGetLatestPredictions(m.sourceSystem, m.externalId)
          .then((p) => { if (live) setPredictions((prev) => new Map(prev).set(`${m.sourceSystem}|${m.externalId}`, p)); })
          .catch(() => { if (live) setPredictions((prev) => new Map(prev).set(`${m.sourceSystem}|${m.externalId}`, 'unavailable')); });
      }
    }).catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load machines.'); });
    return () => { live = false; };
  }, []);

  const classes = useMemo(() => [...new Set(equipment.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))].sort(), [equipment]);
  const equipmentOptions = useMemo(
    () => equipment.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId, label: `${e.name ?? e.externalId} (${e.externalId})` })),
    [equipment],
  );
  const visible = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return equipment.filter((e) => (selectedKey === 'all' || `${e.sourceSystem}|${e.externalId}` === selectedKey)
      && (scope.plantId === 'all' || e.plantId === scope.plantId)
      && (scope.classSlug === 'all' || e.equipmentClassSlug === scope.classSlug)
      && (!term || (e.name ?? '').toLowerCase().includes(term) || e.externalId.toLowerCase().includes(term)));
  }, [equipment, scope, selectedKey]);
  // Scenarios follow the filters: those for the classes of the machines on screen. With
  // no machines registered yet there is nothing to narrow by, so all of them show.
  const visibleClasses = new Set(visible.map((e) => e.equipmentClassSlug));
  const visibleScenarios = (scenarios ?? []).filter((s) => equipment.length === 0 || visibleClasses.has(s.clientEquipmentClassSlug));

  async function toggle(s: ClientScenario) {
    setBusySlug(s.slug);
    try {
      await apiEditMyCatalogScenario(s.slug, { enabled: !s.enabled });
      setScenarios(await apiListMyCatalogScenarios());
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not change this scenario.');
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <div id="live-predictions-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Predictions</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <EquipmentFilters
        scope={scope}
        onChange={setScope}
        plants={plants}
        classes={classes}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
      />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Prediction scenarios</h3>
          <button onClick={() => navigate('/scenarios')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
            Manage in Scenarios <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <Info className="w-3.5 h-3.5" />New scenarios come from the Things Alive library with your equipment classes; here you switch them on or off.
        </p>
        {scenarios === null ? (
          <p className="text-sm text-slate-400">{error ? '—' : 'Loading…'}</p>
        ) : visibleScenarios.length === 0 ? (
          <p className="text-sm text-slate-400">No prediction scenarios for this selection.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleScenarios.map((s) => (
              <div key={s.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{s.name}</h4>
                  <button
                    disabled={busySlug === s.slug}
                    onClick={() => toggle(s)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${s.enabled ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                    title={s.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={SEVERITY_TONE[s.severity]}>{s.severity}</Chip>
                  <Chip tone="slate">Tier {s.tier}</Chip>
                  <Chip tone="slate">{s.clientEquipmentClassSlug}</Chip>
                </div>
                <p className="text-[11px] text-slate-400">Needs {s.requiredSignals.join(', ') || 'no signals'} · {s.minimumHistoryDays}d history</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base">Prediction KPIs</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Each machine's latest scored predictions — the worst one leads.</p>
        {visible.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">No machines match this filter.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((m) => {
              const key = `${m.sourceSystem}|${m.externalId}`;
              const p = predictions.get(key);
              const worst = Array.isArray(p) && p.length
                ? p.reduce((a, b) => (SEVERITY_ORDER.indexOf(b.severity) > SEVERITY_ORDER.indexOf(a.severity) || (b.severity === a.severity && b.riskScore > a.riskScore) ? b : a))
                : null;
              return (
                <div key={key} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate">{m.name ?? m.externalId}</h4>
                    {worst && <Chip tone={SEVERITY_TONE[worst.severity]}>{worst.severity}</Chip>}
                  </div>
                  {p === undefined ? (
                    <p className="text-xs text-slate-400">Loading…</p>
                  ) : p === 'unavailable' ? (
                    <p className="text-xs text-slate-400">Predictions not available for your role.</p>
                  ) : !worst ? (
                    <p className="text-xs text-slate-400">No active scenario has scored this machine yet.</p>
                  ) : (
                    <>
                      <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">
                        {worst.riskScore}<span className="text-sm font-normal text-slate-400"> / 100 risk</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {worst.clientScenarioSlug} · confidence {worst.confidence} · {(p as Prediction[]).length} scenario(s) scored
                      </p>
                      <p className="text-[11px] text-slate-400">Scored {new Date(worst.computedAt).toLocaleString()} over {worst.windowDays} day(s)</p>
                    </>
                  )}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => navigate(`/things-care/${encodeURIComponent(m.sourceSystem)}/${encodeURIComponent(m.externalId)}`)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"
                    >
                      Details <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                      <Sparkles className="w-3.5 h-3.5" /> Create work order
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
