import React, { useEffect, useState } from 'react';
import { AlertCircle, Archive, Info, RotateCw } from 'lucide-react';
import { ApiError, TelemetryArchiveRow, TelemetryPartitionDrop, apiListTelemetryArchives } from '../../lib/api';
import { Chip } from '../common/Chip';

const monthLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
const bytes = (n: string) => {
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
};

/**
 * What the archive pass has written and dropped (QARCH1), for Things Alive staff. Read
 * only on purpose: a pass exports and then drops raw telemetry, so starting one belongs
 * to operations (TELEMETRY_ARCHIVE_ENABLED, ARCHIVE_S3_*), not to a button here.
 */
export const TelemetryArchiveView: React.FC<{ clientName: (tenantId: string) => string }> = ({ clientName }) => {
  const [archives, setArchives] = useState<TelemetryArchiveRow[] | null>(null);
  const [drops, setDrops] = useState<TelemetryPartitionDrop[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    apiListTelemetryArchives()
      .then((r) => { setArchives(r.archives); setDrops(r.drops); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the telemetry archive.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Info className="w-4 h-4 shrink-0 text-slate-400" />
          <span>
            Raw readings older than 90 days are exported to Parquet per account and month, verified by reading the object back,
            then their partition is dropped. This page only shows what has happened; archive passes are run by operations.
          </span>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-50 cursor-pointer shrink-0" title="Refresh">
          <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
          <Archive className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Exports</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-2.5 px-4">Month</th>
                <th className="py-2.5 px-4">Account</th>
                <th className="py-2.5 px-4">Part</th>
                <th className="py-2.5 px-4 text-right">Rows</th>
                <th className="py-2.5 px-4 text-right">Size</th>
                <th className="py-2.5 px-4">Exported</th>
                <th className="py-2.5 px-4">Verified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-200">
              {archives === null ? (
                <tr><td colSpan={7} className="py-6 text-center text-slate-400">{error ? '—' : 'Loading…'}</td></tr>
              ) : archives.length === 0 ? (
                <tr><td colSpan={7} className="py-6 text-center text-slate-400">No month has been archived yet.</td></tr>
              ) : archives.map((a) => (
                <tr key={a.id}>
                  <td className="py-2.5 px-4">{monthLabel(a.month)}</td>
                  <td className="py-2.5 px-4">{clientName(a.tenantId)}</td>
                  <td className="py-2.5 px-4">{a.part}</td>
                  <td className="py-2.5 px-4 text-right font-mono">{Number(a.rowCount).toLocaleString()}</td>
                  <td className="py-2.5 px-4 text-right font-mono">{bytes(a.byteSize)}</td>
                  <td className="py-2.5 px-4 text-slate-500">{new Date(a.exportedAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">
                    {a.verifiedAt ? <Chip tone="emerald">verified</Chip>
                      : a.verifyError ? <span title={a.verifyError}><Chip tone="rose">failed</Chip></span>
                        : <Chip tone="amber">pending</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Dropped partitions</h3>
          <p className="text-[11px] text-slate-400">A partition is dropped only after every account's rows for that month have a verified archive.</p>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
          {drops.length === 0 ? (
            <p className="py-6 text-center text-slate-400">No partition has been dropped yet.</p>
          ) : drops.map((d) => (
            <div key={d.partition_name} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="font-mono text-slate-700 dark:text-slate-200">{d.partition_name}</span>
              <span className="text-slate-500">{monthLabel(d.month)} · {Number(d.rows_dropped).toLocaleString()} rows · {new Date(d.dropped_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
