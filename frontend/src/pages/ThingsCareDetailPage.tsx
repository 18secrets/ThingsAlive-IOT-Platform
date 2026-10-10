import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle, Bell, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Gauge, Plus, RefreshCw, Wrench,
} from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { Sparkline } from '../components/dashboard/Sparkline';
import {
  ApiError, EquipmentProfile, Prediction, PredictionBaseline, PredictionSeverity, WorkOrder,
  apiGetLatestPredictions, apiGetPredictionBaselines, apiGetPredictionHistory, apiListEquipment, apiListWorkOrders,
  apiRefreshPredictionBaselines, apiScorePredictionsNow,
} from '../lib/api';

const SEVERITY_TONE: Record<PredictionSeverity, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  none: 'emerald', low: 'emerald', medium: 'amber', high: 'rose', critical: 'rose',
};
const SIGNAL_STATE_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  normal: 'emerald', warning: 'amber', critical: 'rose', unscored: 'slate',
};

/** The provenance behind each signal's mean/stddev (already shown per-prediction
 *  above) — collapsed by default, a support/diagnostic aid rather than a screen an
 *  operator visits for its own sake. */
function BaselinesPanel({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const [open, setOpen] = useState(false);
  const [baselines, setBaselines] = useState<PredictionBaseline[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true);
    apiGetPredictionBaselines(sourceSystem, externalId)
      .then((rows) => { setBaselines(rows); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load baselines.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || baselines || loading) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function recompute() {
    setRefreshing(true);
    try {
      const rows = await apiRefreshPredictionBaselines(sourceSystem, externalId);
      setBaselines(rows);
      setError(undefined);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not recompute baselines.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between gap-2.5 cursor-pointer"
      >
        <div className="text-left">
          <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">Baselines</div>
          <div className="text-xs text-slate-400">What each signal's mean/stddev is measured against</div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 text-xs space-y-2">
          <div className="flex items-center justify-end">
            <button
              onClick={recompute}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Recompute
            </button>
          </div>

          {loading && <p className="text-slate-400">Loading…</p>}
          {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}

          {baselines && baselines.length === 0 && (
            <p className="text-slate-400">No baseline computed yet for this machine.</p>
          )}

          {baselines && baselines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-slate-400 font-semibold">
                  <tr>
                    <th className="py-1.5 pr-3">Signal</th>
                    <th className="py-1.5 pr-3">Mean</th>
                    <th className="py-1.5 pr-3">Stddev</th>
                    <th className="py-1.5 pr-3">Samples</th>
                    <th className="py-1.5 pr-3">Coverage</th>
                    <th className="py-1.5 pr-3">Source</th>
                    <th className="py-1.5">Computed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                  {baselines.map((b) => (
                    <tr key={b.signal}>
                      <td className="py-1.5 pr-3 font-sans text-slate-700 dark:text-slate-200">{b.signal}</td>
                      <td className="py-1.5 pr-3">{b.mean.toFixed(2)}</td>
                      <td className="py-1.5 pr-3">{b.stddev.toFixed(2)}</td>
                      <td className="py-1.5 pr-3">{b.sampleCount}</td>
                      <td className="py-1.5 pr-3">{(b.coverageRatio * 100).toFixed(0)}%</td>
                      <td className="py-1.5 pr-3 font-sans">{b.source}</td>
                      <td className="py-1.5 font-sans text-slate-400">{new Date(b.computedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const ThingsCareDetailPage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<EquipmentProfile | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [history, setHistory] = useState<Map<string, Prediction[]>>(new Map());
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);

  usePageHeader({
    title: profile?.name ?? externalId ?? 'Machine not found',
    subtitle: 'ThingsCare Detail',
    onBack: () => navigate('/things-care'),
  });

  const load = async () => {
    if (!sourceSystem || !externalId) return;
    const preds = await apiGetLatestPredictions(sourceSystem, externalId);
    setPredictions(preds);
    const histEntries = await Promise.all(preds.map(async (p): Promise<[string, Prediction[]]> =>
      [p.clientScenarioSlug, await apiGetPredictionHistory(sourceSystem, externalId, p.clientScenarioSlug, 20).catch(() => [])]));
    setHistory(new Map(histEntries));
  };

  useEffect(() => {
    if (!sourceSystem || !externalId) return;
    let live = true;
    setLoading(true);
    apiListEquipment().then((list) => {
      if (live) setProfile(list.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId) ?? null);
    }).catch(() => {});
    apiListWorkOrders({ equipment: externalId }).then((o) => { if (live) setOrders(o); }).catch(() => {});
    load()
      .then(() => { if (live) setError(undefined); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load predictions.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  async function scoreNow() {
    if (!sourceSystem || !externalId) return;
    setScoring(true);
    try {
      const result = await apiScorePredictionsNow(sourceSystem, externalId);
      window.alert(`Scored ${result.written.length} scenario(s). ${result.skipped.length} skipped. ${result.raised.length} job(s) raised.`);
      await load();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not score this machine now.');
    } finally {
      setScoring(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Deterministic scoring</span>
        <h2 className="text-xl font-bold">ThingsCare: Scenario Risk</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-base">{profile?.name ?? externalId}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">{sourceSystem}/{externalId}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={scoreNow} disabled={scoring} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
              <RefreshCw className={`w-4 h-4 ${scoring ? 'animate-spin' : ''}`} /> Score now
            </button>
            <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
              <Plus className="w-4 h-4" /> Create work order
            </button>
            {sourceSystem && externalId && (
              <button
                onClick={() => navigate(`/admin/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/page`)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer"
              >
                <ExternalLink className="w-4 h-4" /> View equipment page
              </button>
            )}
          </div>
        </div>
      </div>

      {sourceSystem && externalId && <BaselinesPanel sourceSystem={sourceSystem} externalId={externalId} />}

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-3">Active scenarios</h3>
        {predictions.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            No active scenario has produced a prediction for this machine yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {predictions.map((p) => {
              const trend = (history.get(p.clientScenarioSlug) ?? []).slice().reverse().map((h) => h.riskScore);
              return (
                <div key={p.clientScenarioSlug} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <RingGauge value={p.riskScore} size={56} colorClass={p.severity === 'high' || p.severity === 'critical' ? 'text-rose-500 dark:text-rose-400' : p.severity === 'medium' ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400'} />
                    <div className="min-w-0 flex-1">
                      <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{p.clientScenarioSlug}</h4>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <Chip tone={SEVERITY_TONE[p.severity]}>{p.severity}</Chip>
                        <Chip title="How much of the picture was available">{p.confidence}</Chip>
                        <Chip icon={Bell} tone={p.abnormalCount > 0 ? 'amber' : 'slate'}>{p.abnormalCount} abnormal</Chip>
                      </div>
                    </div>
                    {trend.length >= 2 && <Sparkline values={trend} colorClass="text-sky-600 dark:text-sky-400" />}
                  </div>
                  <p className="text-[11px] text-slate-400">{p.windowDays}d window · {p.modelRef} · {new Date(p.computedAt).toLocaleString()}</p>
                  {p.signals.length > 0 && (
                    <div className="space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
                      {p.signals.map((s) => (
                        <div key={s.signal} className="flex items-center justify-between text-xs">
                          <span className="text-slate-600 dark:text-slate-300">{s.signal}</span>
                          <div className="flex items-center gap-2">
                            {s.value != null && <span className="font-mono text-slate-400">{s.value.toFixed(2)}</span>}
                            <Chip tone={SIGNAL_STATE_TONE[s.state]}>{s.state}</Chip>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-3">Maintenance history</h3>
        {orders.length === 0 ? (
          <p className="text-sm text-slate-400">No work orders for this machine yet.</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-start gap-2">
                <Wrench className="w-4.5 h-4.5 text-slate-400 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{o.title} · {o.status}</p>
                  {o.resolution && <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{o.resolution}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {predictions.length === 0 && (
        <Chip icon={CheckCircle2} tone="slate" size="md">
          Needs an active client scenario with enough baseline history before a prediction can be produced.
        </Chip>
      )}
    </div>
  );
};
