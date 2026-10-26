import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Bug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, MeDiagnostics, apiGetMe } from '../../lib/api';

function formatScope(value: string[] | 'unrestricted', t: (key: string) => string): string {
  if (value === 'unrestricted') return t('diagnostics.unrestricted');
  return value.length ? value.join(', ') : t('diagnostics.none');
}

/** A raw dump of the token's resolved scope — for support to ask someone to
 *  read off when something looks wrong, not a screen anyone visits for its
 *  own sake. */
export const SessionDiagnostics: React.FC = () => {
  const { t } = useTranslation('accounts');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MeDiagnostics | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    apiGetMe()
      .then((d) => { setData(d); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('diagnostics.loadFailed')))
      .finally(() => setLoading(false));
  }, [open, data, loading, t]);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-4 flex items-center justify-between gap-2.5 cursor-pointer"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 flex items-center justify-center shrink-0">
            <Bug className="w-4.5 h-4.5" />
          </div>
          <div className="text-left">
            <div className="font-semibold text-base text-slate-800 dark:text-slate-100">{t('diagnostics.title')}</div>
            <div className="text-sm text-slate-400">{t('diagnostics.subtitle')}</div>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 text-sm">
          {loading && <p className="text-slate-400">{t('diagnostics.loading')}</p>}
          {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
          {data && (
            <div className="space-y-2.5 font-mono text-xs">
              <Row label={t('diagnostics.tenant')} value={data.tenantId} />
              {/* The name first, the id after it (tester bug TC_135): a person reads
                  the name, support still asks for the id. */}
              <Row label={t('diagnostics.user')} value={data.fullName ?? data.email ?? data.userId} />
              {data.email && <Row label={t('diagnostics.email')} value={data.email} />}
              <Row label={t('diagnostics.userId')} value={data.userId} />
              <Row label={t('diagnostics.roles')} value={data.roles.join(', ') || '—'} />
              <Row label={t('diagnostics.platformRole')} value={data.isPlatformRole ? t('diagnostics.yes') : t('diagnostics.no')} />
              <Row label={t('diagnostics.plants')} value={formatScope(data.scope.plants, t)} />
              <Row label={t('diagnostics.equipment')} value={formatScope(data.scope.equipment, t)} />
              <Row label={t('diagnostics.devices')} value={formatScope(data.scope.devices, t)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
    <span className="text-slate-400">{label}</span>
    <span className="text-slate-700 dark:text-slate-200 text-right break-all ml-4">{value}</span>
  </div>
);
