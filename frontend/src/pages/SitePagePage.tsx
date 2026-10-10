import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, MapPinned } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { ApiError, SitePage, apiGetSitePage } from '../lib/api';
import { Widget, GAUGE_WIDGET_TYPES } from '../components/page-widgets/PageWidgets';

export const SitePagePage: React.FC = () => {
  const { plantId } = useParams<{ plantId: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState<SitePage | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  usePageHeader({
    title: page?.site.name ?? 'Site',
    subtitle: 'Site page',
    onBack: () => navigate('/admin/plant'),
  });

  useEffect(() => {
    if (!plantId) return;
    let live = true;
    setLoading(true);
    apiGetSitePage(plantId)
      .then((result) => { if (live) { setPage(result); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load this site page.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [plantId]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
      </div>
    );
  }
  if (!page) return null;

  const gauges = page.widgets.filter((w) => GAUGE_WIDGET_TYPES.includes(w.widgetType));
  const lists = page.widgets.filter((w) => !gauges.includes(w));

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-5 text-white space-y-1">
        <div className="flex items-center gap-2">
          <MapPinned className="w-4 h-4" />
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Site page</span>
        </div>
        <h2 className="text-lg font-bold">{page.site.name}</h2>
        <p className="text-xs text-sky-100">
          {page.site.code} · {page.site.siteClass.slug} v{page.site.siteClass.version}
          {page.layout.fallback ? ' · fallback layout' : ''}
        </p>
      </div>

      {page.widgets.length === 0 && (
        <p className="text-sm text-slate-400">No widgets configured for this site's class yet.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {gauges.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {lists.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>
    </div>
  );
};
