import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Bug } from 'lucide-react';
import { ApiError, MeDiagnostics, apiGetMe } from '../../lib/api';

function formatScope(value: string[] | 'unrestricted'): string {
  if (value === 'unrestricted') return 'Unrestricted';
  return value.length ? value.join(', ') : 'None';
}

/** A raw dump of the token's resolved scope — for support to ask someone to
 *  read off when something looks wrong, not a screen anyone visits for its
 *  own sake. */
export const SessionDiagnostics: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MeDiagnostics | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    apiGetMe()
      .then((d) => { setData(d); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load session diagnostics.'))
      .finally(() => setLoading(false));
  }, [open, data, loading]);

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
            <div className="font-semibold text-base text-slate-800 dark:text-slate-100">Session Diagnostics</div>
            <div className="text-sm text-slate-400">What this sign-in resolves to — for support</div>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 text-sm">
          {loading && <p className="text-slate-400">Loading…</p>}
          {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
          {data && (
            <div className="space-y-2.5 font-mono text-xs">
              <Row label="Tenant" value={data.tenantId} />
              <Row label="User" value={data.userId} />
              <Row label="Roles" value={data.roles.join(', ') || '—'} />
              <Row label="Platform role" value={data.isPlatformRole ? 'Yes' : 'No'} />
              <Row label="Plants" value={formatScope(data.scope.plants)} />
              <Row label="Equipment" value={formatScope(data.scope.equipment)} />
              <Row label="Devices" value={formatScope(data.scope.devices)} />
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
