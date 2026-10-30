import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('predictions');
  usePageHeader({ title: t('translation:pages.predictions.title'), subtitle: t('translation:pages.predictions.subtitle') });
  const navigate = useNavigate();
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  // "No machines match" before the list arrived read as a filter that matched nothing.
  const [equipmentLoaded, setEquipmentLoaded] = useState(false);
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.loadScenarios')); });
    apiListEquipment().then((list) => {
      if (!live) return;
      setEquipment(list);
      setEquipmentLoaded(true);
      // One call per machine — there is no fleet-wide predictions route. Each lands as it
      // arrives, so a slow or refused machine never holds the rest back.
      for (const m of list) {
        apiGetLatestPredictions(m.sourceSystem, m.externalId)
          .then((p) => { if (live) setPredictions((prev) => new Map(prev).set(`${m.sourceSystem}|${m.externalId}`, p)); })
          .catch(() => { if (live) setPredictions((prev) => new Map(prev).set(`${m.sourceSystem}|${m.externalId}`, 'unavailable')); });
      }
    }).catch((err) => { if (live) { setEquipmentLoaded(true); setError(err instanceof ApiError ? err.message : t('errors.loadMachines')); } });
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
    // Disabling stops scoring on every machine of the class; enabling only adds work.
    if (s.enabled && !window.confirm(t('scenarios.disableConfirm', { name: s.name }))) return;
    setBusySlug(s.slug);
    try {
      await apiEditMyCatalogScenario(s.slug, { enabled: !s.enabled });
      setScenarios(await apiListMyCatalogScenarios());
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('errors.toggle'));
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <div id="live-predictions-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">{t('hero.title')}</h2>
        <p className="text-sm text-sky-100">{t('hero.tagline')}</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <EquipmentFilters
        showConnection={false}
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
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('scenarios.title')}</h3>
          <button onClick={() => navigate('/scenarios')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
            {t('scenarios.manage')} <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <Info className="w-3.5 h-3.5" />{t('scenarios.info')}
        </p>
        {scenarios === null ? (
          <p className="text-sm text-slate-400">{error ? '—' : t('common.loading')}</p>
        ) : visibleScenarios.length === 0 ? (
          <p className="text-sm text-slate-400">{t('scenarios.empty')}</p>
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
                    title={s.enabled ? t('scenarios.disable') : t('scenarios.enable')}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={SEVERITY_TONE[s.severity]}>{t(`severity.${s.severity}`, { defaultValue: s.severity })}</Chip>
                  <Chip tone="slate">{t('scenarios.tier', { tier: s.tier })}</Chip>
                  <Chip tone="slate">{s.clientEquipmentClassSlug}</Chip>
                </div>
                <p className="text-[11px] text-slate-400">
                  {t('scenarios.needs', { signals: s.requiredSignals.join(', ') || t('scenarios.noSignals') })} · {t('scenarios.history', { count: s.minimumHistoryDays })}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('kpis.title')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('kpis.subtitle')}</p>
        {!equipmentLoaded ? (
          <p className="text-sm text-slate-400">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">{t('kpis.noMatch')}</div>
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
                    {worst && <Chip tone={SEVERITY_TONE[worst.severity]}>{t(`severity.${worst.severity}`, { defaultValue: worst.severity })}</Chip>}
                  </div>
                  {p === undefined ? (
                    <p className="text-xs text-slate-400">{t('common.loading')}</p>
                  ) : p === 'unavailable' ? (
                    <p className="text-xs text-slate-400">{t('kpis.unavailable')}</p>
                  ) : !worst ? (
                    <p className="text-xs text-slate-400">{t('kpis.notScored')}</p>
                  ) : (
                    <>
                      <div className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">
                        {worst.riskScore}<span className="text-sm font-normal text-slate-400"> {t('kpis.outOf100')}</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {worst.clientScenarioSlug} · {t('kpis.confidence', { value: t(`confidence.${worst.confidence}`, { defaultValue: worst.confidence }) })} · {t('kpis.scenariosScored', { count: (p as Prediction[]).length })}
                      </p>
                      <p className="text-[11px] text-slate-400">{t('kpis.scoredAt', { time: new Date(worst.computedAt).toLocaleString(), count: worst.windowDays })}</p>
                    </>
                  )}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => navigate(`/things-care/${encodeURIComponent(m.sourceSystem)}/${encodeURIComponent(m.externalId)}`)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"
                    >
                      {t('common.details')} <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                      <Sparkles className="w-3.5 h-3.5" /> {t('common.createWorkOrder')}
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
