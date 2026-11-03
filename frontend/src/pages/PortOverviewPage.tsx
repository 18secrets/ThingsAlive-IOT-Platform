import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Anchor, Eye, EyeOff, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { ApiError, PortTwin, apiGetPortTwin } from '../lib/api';
import { SiteTwinCard } from '../components/site-twin/SiteTwinCard';

// three.js only when the overview is open.
const PortOverviewScene = lazy(() => import('../components/visual/PortOverviewScene'));
const REFRESH_MS = 20_000;

/**
 * Every site of the account in one twin, along one waterfront: each site as its own
 * page draws it, with a port-wide strip of what is on site, live and alerting. Opening a
 * site from here goes to its page. On the demo account the workforce figure and the
 * movement are simulated, and the page says so.
 */
export const PortOverviewPage: React.FC = () => {
  const { t } = useTranslation('equipment');
  const navigate = useNavigate();
  const frame = useRef<HTMLDivElement>(null);
  const [port, setPort] = useState<PortTwin | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [labels, setLabels] = useState(false);
  const [reset, setReset] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // One site at a time by default — the busiest — so a port of many sites is shown
  // site by site; "All sites" draws them together.
  const [siteId, setSiteId] = useState<string | null>(null);
  const ALL = 'all';

  usePageHeader({
    title: t('portTwin.title', { defaultValue: 'Port overview' }),
    subtitle: t('portTwin.subtitle', { defaultValue: 'Every site, one digital twin' }),
    onBack: () => navigate('/admin/plant'),
  });

  const load = useCallback(() => apiGetPortTwin()
    .then((p) => { setPort(p); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('portTwin.loadFailed', { defaultValue: 'The port overview could not be loaded.' }))),
  [t]);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-rose-600 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
      </div>
    );
  }
  if (!port) return <div className="h-[640px] rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />;

  const current = siteId ?? [...port.sites].sort((a, b) => b.summary.total - a.summary.total)[0]?.site.plantId ?? ALL;
  const btn = 'p-2 rounded-lg bg-white/95 dark:bg-slate-800/95 shadow border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50';
  const stat = (label: string, value: React.ReactNode, tone = 'text-slate-900 dark:text-slate-100') => (
    <div className="px-4 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 min-w-[120px]">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );

  return (
    <div ref={frame} className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden ${fullscreen ? 'flex flex-col h-screen' : ''}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <span className="w-9 h-9 rounded-lg bg-sky-600 text-white flex items-center justify-center"><Anchor className="w-5 h-5" /></span>
        <div>
          <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('portTwin.title', { defaultValue: 'Port overview' })}</div>
          <div className="text-xs text-slate-500">{t('portTwin.hint', { defaultValue: 'Click a site to open it.' })}</div>
        </div>
        {port.simulated && (
          <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 text-xs font-semibold">
            {t('siteTwin.simulated', { defaultValue: 'Demo · simulated movement' })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {stat(t('portTwin.sites', { defaultValue: 'Sites' }), port.summary.sites)}
          {stat(t('portTwin.machines', { defaultValue: 'Machines' }), port.summary.machines)}
          {stat(t('portTwin.live', { defaultValue: 'Live' }), port.summary.live, 'text-emerald-600')}
          {stat(t('portTwin.alerts', { defaultValue: 'Alerts' }), port.summary.alert, port.summary.alert ? 'text-rose-600' : undefined)}
          {port.summary.workforce !== null && stat(
            t('portTwin.workforce', { defaultValue: 'Workforce (simulated)' }), port.summary.workforce.toLocaleString(),
          )}
        </div>
      </div>

      {/* The site picker: one site at a time, or the whole port. */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-slate-100 dark:border-slate-800">
        <label className="flex items-center gap-2 text-xs text-slate-500">
          {t('portTwin.site', { defaultValue: 'Site' })}
          <select
            value={current} onChange={(e) => setSiteId(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-800 dark:text-slate-100 min-w-[280px]"
          >
            {port.sites.map((s) => (
              <option key={s.site.plantId} value={s.site.plantId}>
                {s.site.code} · {s.site.name} — {s.summary.total} {t('portTwin.machinesShort', { defaultValue: 'machines' })}
                {s.workforce !== null ? `, ${s.workforce.toLocaleString()} ${t('portTwin.workersShort', { defaultValue: 'workers' })}` : ''}
              </option>
            ))}
            <option value={ALL}>{t('portTwin.allSites', { defaultValue: 'All sites — the whole port' })}</option>
          </select>
        </label>
        {current !== ALL && (
          <button onClick={() => navigate(`/admin/sites/${current}/page`)} className="text-xs font-semibold text-sky-700 dark:text-sky-300 hover:underline">
            {t('portTwin.openSite', { defaultValue: 'Open site page →' })}
          </button>
        )}
      </div>

      {current !== ALL ? (
        <div className="p-3">
          {/* The site's own twin, with its place and equipment pickers. */}
          <SiteTwinCard key={current} plantId={current} />
        </div>
      ) : (
      <div className={`relative ${fullscreen ? 'flex-1 min-h-0' : 'h-[720px]'}`}>
        {port.sites.length ? (
          <Suspense fallback={<div className="absolute inset-0 bg-slate-100 dark:bg-slate-800 animate-pulse" />}>
            <PortOverviewScene port={port} showLabels={labels} reset={reset} onOpenSite={(id) => navigate(`/admin/sites/${id}/page`)} />
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            {t('portTwin.empty', { defaultValue: 'No site has been laid out yet. Open a site and use "Auto-arrange from equipment".' })}
          </div>
        )}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5">
          <button className={btn} title={t('siteTwin.resetView', { defaultValue: 'Reset view' })} onClick={() => setReset((n) => n + 1)}><RotateCcw className="w-4 h-4" /></button>
          <button className={btn} title={t('siteTwin.labels', { defaultValue: 'Show or hide labels' })} onClick={() => setLabels((v) => !v)}>{labels ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}</button>
          <button
            className={btn} title={t('siteTwin.fullscreen', { defaultValue: 'Full screen' })}
            onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void frame.current?.requestFullscreen())}
          >
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
        {port.notLaidOut.length > 0 && (
          <div className="absolute bottom-3 left-3 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs text-slate-600 dark:text-slate-300 max-w-md">
            {t('portTwin.notLaidOut', { defaultValue: 'Not drawn yet (no layout):' })}{' '}
            {port.notLaidOut.map((s) => `${s.code} (${s.machines})`).join(', ')}
          </div>
        )}
      </div>
      )}
    </div>
  );
};
