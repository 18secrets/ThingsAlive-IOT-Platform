import React, { useEffect, useState } from 'react';
import { severityTone } from '../components/common/statusTone';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, Bell, CheckCircle2, ChevronDown, ChevronUp, Gauge, Plus, RefreshCw, Wrench,
} from 'lucide-react';
import { useGoBack } from '../lib/useGoBack';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { MachineLinks } from '../components/common/MachineLinks';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { RiskTrend } from '../components/care/RiskTrend';
import { SignalDrilldown } from '../components/care/SignalDrilldown';
import {
  ApiError, EquipmentProfile, Prediction, PredictionBaseline, PredictionSeverity, WorkOrder,
  apiGetLatestPredictions, apiGetPredictionBaselines, apiGetPredictionHistory, apiListEquipment, apiListWorkOrders,
  apiRefreshPredictionBaselines, apiScorePredictionsNow,
} from '../lib/api';
import { ChainDiagnosisPanel } from '../components/care/ChainDiagnosisPanel';
import { RecommendationPanel } from '../components/care/RecommendationPanel';

const SEVERITY_TONE = (s: string) => severityTone(s, { noneIsHealthy: true });
const SIGNAL_STATE_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  normal: 'emerald', warning: 'amber', critical: 'rose', unscored: 'slate',
};
/** Worst first, so the signal that made the card amber is the one you see first. */
const STATE_ORDER: Record<string, number> = { critical: 0, warning: 1, unscored: 2, normal: 3 };

/** "All 2 signals checked" rather than "full": what the confidence actually counts. */
function checkedLabel(t: (k: string, o?: Record<string, unknown>) => string, confidence: string, scored: number, total: number) {
  if (confidence === 'none' || scored === 0) return t('detail.checkedNone');
  if (scored === total) return t('detail.checkedAll', { count: total });
  return t('detail.checkedSome', { scored, total });
}

/** The provenance behind each signal's mean/stddev (already shown per-prediction
 *  above) — collapsed by default, a support/diagnostic aid rather than a screen an
 *  operator visits for its own sake. */
function BaselinesPanel({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t } = useTranslation('care');
  const [open, setOpen] = useState(false);
  const [baselines, setBaselines] = useState<PredictionBaseline[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true);
    apiGetPredictionBaselines(sourceSystem, externalId)
      .then((rows) => { setBaselines(rows); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('errors.loadBaselines')))
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
      window.alert(err instanceof ApiError ? err.message : t('errors.recomputeBaselines'));
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
          <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">{t('baselines.title')}</div>
          <div className="text-xs text-slate-400">{t('baselines.subtitle')}</div>
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
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> {t('baselines.recompute')}
            </button>
          </div>

          {loading && <p className="text-slate-400">{t('common.loading')}</p>}
          {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}

          {baselines && baselines.length === 0 && (
            <p className="text-slate-400">{t('baselines.empty')}</p>
          )}

          {baselines && baselines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-slate-400 font-semibold">
                  <tr>
                    <th className="py-1.5 pr-3">{t('baselines.col.signal')}</th>
                    <th className="py-1.5 pr-3">{t('baselines.col.mean')}</th>
                    <th className="py-1.5 pr-3">{t('baselines.col.stddev')}</th>
                    <th className="py-1.5 pr-3">{t('baselines.col.samples')}</th>
                    <th className="py-1.5 pr-3">{t('baselines.col.coverage')}</th>
                    <th className="py-1.5 pr-3">{t('baselines.col.source')}</th>
                    <th className="py-1.5">{t('baselines.col.computed')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                  {baselines.map((b) => (
                    <tr key={b.signal}>
                      <td className="py-1.5 pr-3 font-sans text-slate-700 dark:text-slate-200">{b.signal}</td>
                      <td className="py-1.5 pr-3">{typeof b.mean === 'number' ? b.mean.toFixed(2) : (b.mean ?? '—')}</td>
                      <td className="py-1.5 pr-3">{typeof b.stddev === 'number' ? b.stddev.toFixed(2) : (b.stddev ?? '—')}</td>
                      <td className="py-1.5 pr-3">{b.sampleCount ?? '—'}</td>
                      <td className="py-1.5 pr-3">{typeof b.coverageRatio === 'number' ? `${(b.coverageRatio * 100).toFixed(0)}%` : '—'}</td>
                      <td className="py-1.5 pr-3 font-sans">{b.source ?? '—'}</td>
                      <td className="py-1.5 font-sans text-slate-400">{b.computedAt && !isNaN(new Date(b.computedAt).getTime()) ? new Date(b.computedAt).toLocaleString() : '—'}</td>
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
  const goBack = useGoBack('/things-care');
  const { t } = useTranslation('care');
  const [profile, setProfile] = useState<EquipmentProfile | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [history, setHistory] = useState<Map<string, Prediction[]>>(new Map());
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);
  // What a manual score did, on the page: "Saved successfully" with nothing scored read as
  // success (test report OB-3), so this says what ran, what was skipped and why.
  const [scoreNotice, setScoreNotice] = useState<{ tone: 'ok' | 'warn'; lines: string[] } | null>(null);
  const [openSignal, setOpenSignal] = useState<{ slug: string; signal: string } | null>(null);

  usePageHeader({
    breadcrumb: t('translation:sidebar.thingsCare'),
    title: profile?.name ?? externalId ?? t('page.machineNotFound'),
    subtitle: t('page.detailSubtitle'),
    onBack: goBack,
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.loadPredictions')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  async function scoreNow() {
    if (!sourceSystem || !externalId) return;
    setScoring(true);
    try {
      const result = await apiScorePredictionsNow(sourceSystem, externalId);
      if (!result.written.length && !result.skipped.length) {
        setScoreNotice({ tone: 'warn', lines: [t('detail.nothingToScore')] });
      } else {
        setScoreNotice({
          tone: result.written.length ? 'ok' : 'warn',
          lines: [
            t('detail.scored', { count: result.written.length })
              + (result.raised.length ? ` ${t('detail.raised', { count: result.raised.length })}` : ''),
            ...result.skipped.map((s) => t('detail.skippedBecause', {
              scenario: s.clientScenarioSlug, reason: t(`detail.skipReason.${s.reason}`, { defaultValue: s.reason }),
            })),
          ],
        });
      }
      await load();
    } catch (err) {
      setScoreNotice({ tone: 'warn', lines: [err instanceof ApiError ? err.message : t('errors.scoreNow')] });
    } finally {
      setScoring(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">{t('common.loading')}</p>;

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('hero.eyebrow')}</span>
        <h2 className="text-xl font-bold">{t('hero.title')}</h2>
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
              <RefreshCw className={`w-4 h-4 ${scoring ? 'animate-spin' : ''}`} /> {t('detail.scoreNow')}
            </button>
            <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
              <Plus className="w-4 h-4" /> {t('common.createWorkOrder')}
            </button>
          </div>
        </div>
        {scoreNotice && (
          <div className={`text-xs rounded-lg px-3 py-2 border space-y-0.5 ${scoreNotice.tone === 'ok'
            ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
            : 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'}`}>
            {scoreNotice.lines.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        )}
        {sourceSystem && externalId && <MachineLinks sourceSystem={sourceSystem} externalId={externalId} current="care" />}
      </div>

      {sourceSystem && externalId && (
        <ErrorBoundary fallbackTitle={t('rec.title')}>
          <RecommendationPanel sourceSystem={sourceSystem} externalId={externalId} />
        </ErrorBoundary>
      )}
      {sourceSystem && externalId && (
        <ErrorBoundary fallbackTitle={t('baselines.title')}>
          <BaselinesPanel sourceSystem={sourceSystem} externalId={externalId} />
        </ErrorBoundary>
      )}
      {sourceSystem && externalId && (
        <ErrorBoundary fallbackTitle={t('chain.title')}>
          <ChainDiagnosisPanel sourceSystem={sourceSystem} externalId={externalId} classSlug={profile?.equipmentClassSlug ?? null} />
        </ErrorBoundary>
      )}

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-3">{t('detail.activeScenarios')}</h3>
        {predictions.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            {t('detail.noPrediction')}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {predictions.map((p) => {
              const occurred = p.occurredAt ? new Date(p.occurredAt) : null;
              const readingAt = occurred && !isNaN(occurred.getTime()) ? occurred.toLocaleString() : '—';
              const severityTone = (p.severity && p.severity in SEVERITY_TONE) ? SEVERITY_TONE(p.severity) : 'slate';
              const signals = (p.signals ?? []).slice().sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));
              const healthy = signals.filter((s) => s.state === 'normal').length;
              const abnormal = signals.filter((s) => s.state === 'warning' || s.state === 'critical');
              const unchecked = signals.length - healthy - abnormal.length;
              const anyCritical = abnormal.some((s) => s.state === 'critical');
              const openHere = openSignal?.slug === p.clientScenarioSlug ? openSignal.signal : null;
              const toggle = (signal: string) => setOpenSignal(openHere === signal ? null : { slug: p.clientScenarioSlug, signal });

              return (
                <div key={p.clientScenarioSlug} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <RingGauge value={typeof p.riskScore === 'number' ? p.riskScore : null} size={56} colorClass={p.severity === 'high' || p.severity === 'critical' ? 'text-rose-500 dark:text-rose-400' : p.severity === 'medium' ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400'} />
                    <div className="min-w-0 flex-1">
                      <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{p.clientScenarioSlug}</h4>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <Chip tone={severityTone} title={t('card.riskTitle')}>{t(`severity.${p.severity}`, { defaultValue: p.severity })}</Chip>
                        <Chip icon={CheckCircle2} tone={p.confidence === 'full' ? 'emerald' : p.confidence === 'partial' ? 'amber' : 'slate'} title={t('card.confidenceTitle')}>
                          {checkedLabel(t, p.confidence, signals.length - unchecked, signals.length)}
                        </Chip>
                        <Chip tone={healthy > 0 ? 'emerald' : 'slate'}>{t('detail.healthy', { count: healthy })}</Chip>
                        {abnormal.length > 0 ? (
                          // A button, because the count is only useful if it takes you to
                          // what it is counting: it opens the worst abnormal signal.
                          <button onClick={() => setOpenSignal({ slug: p.clientScenarioSlug, signal: abnormal[0].signal })}
                            className="cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                            title={t('detail.openAbnormal')}>
                            <Chip icon={Bell} tone={anyCritical ? 'rose' : 'amber'}>{t('detail.abnormal', { count: abnormal.length })}</Chip>
                          </button>
                        ) : (
                          <Chip icon={Bell} tone="slate">{t('detail.abnormal', { count: 0 })}</Chip>
                        )}
                        {unchecked > 0 && <Chip tone="slate">{t('detail.notChecked', { count: unchecked })}</Chip>}
                      </div>
                    </div>
                    <RiskTrend history={history.get(p.clientScenarioSlug) ?? []} />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {t('detail.footer', { count: p.windowDays, model: p.modelRef, at: readingAt })}
                  </p>
                  {signals.length > 0 && sourceSystem && externalId && (
                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                      <p className="text-[11px] text-slate-400 mb-1">{t('detail.clickSignal')}</p>
                      {signals.map((s) => {
                        const open = openHere === s.signal;
                        return (
                          <div key={s.signal}>
                            <button
                              onClick={() => toggle(s.signal)}
                              aria-expanded={open}
                              className={`w-full flex items-center justify-between gap-2 text-xs rounded-md px-1.5 py-1 -mx-1.5 cursor-pointer text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 ${open ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}
                            >
                              <span className="flex items-center gap-1 min-w-0 text-slate-600 dark:text-slate-300">
                                {open ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
                                <span className="truncate">{s.signal}</span>
                              </span>
                              <span className="flex items-center gap-2 shrink-0">
                                {s.value != null && (
                                  <span className="font-mono text-slate-400">
                                    {typeof s.value === 'number' ? s.value.toFixed(2) : String(s.value)}
                                  </span>
                                )}
                                {typeof s.z === 'number' && (
                                  <span className="font-mono text-[11px] text-slate-400 w-12 text-right" title={t('detail.sigmaTitle')}>
                                    {s.z >= 0 ? '+' : '−'}{Math.abs(s.z).toFixed(1)}σ
                                  </span>
                                )}
                                <Chip tone={(s.state && s.state in SIGNAL_STATE_TONE) ? SIGNAL_STATE_TONE[s.state] : 'slate'}>
                                  {t(`signalState.${s.state}`, { defaultValue: s.state })}
                                </Chip>
                              </span>
                            </button>
                            {open && (
                              <ErrorBoundary fallbackTitle={s.signal}>
                                <SignalDrilldown sourceSystem={sourceSystem} externalId={externalId}
                                  clientScenarioSlug={p.clientScenarioSlug} signal={s.signal} />
                              </ErrorBoundary>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-3">{t('detail.maintenanceHistory')}</h3>
        {orders.length === 0 ? (
          <p className="text-sm text-slate-400">{t('detail.noWorkOrders')}</p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-start gap-2">
                <Wrench className="w-4.5 h-4.5 text-slate-400 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{o.title} · {t(`workOrderStatus.${o.status}`, { defaultValue: o.status })}</p>
                  {o.resolution && <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{o.resolution}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {predictions.length === 0 && (
        <Chip icon={CheckCircle2} tone="slate" size="md">
          {t('detail.needsScenario')}
        </Chip>
      )}
    </div>
  );
};
