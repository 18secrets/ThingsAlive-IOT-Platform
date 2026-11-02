import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Archive, Info, RotateCw } from 'lucide-react';
import { ApiError, TelemetryArchiveRow, TelemetryPartitionDrop, apiListTelemetryArchives } from '../../lib/api';
import { Chip } from '../common/Chip';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListColumn, ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

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
  const { t } = useTranslation('admin');
  const { t: ts } = useTranslation('shared');
  const [viewMode, setViewMode] = useViewMode('admin-telemetry-archive');
  const [archives, setArchives] = useState<TelemetryArchiveRow[] | null>(null);
  const [drops, setDrops] = useState<TelemetryPartitionDrop[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    apiListTelemetryArchives()
      .then((r) => { setArchives(r.archives); setDrops(r.drops); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('archive.loadFailed')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);
  const { pageItems: pagedArchives, ...archivePager } = usePagination(archives ?? []);
  const { pageItems: pagedDrops, ...dropPager } = usePagination(drops);

  // One definition per list for both views (cards or list on every list page).
  const archiveColumns: ListColumn[] = [
    { label: t('archive.month') },
    { label: t('archive.account') },
    { label: t('archive.part') },
    { label: t('archive.rows'), align: 'right' },
    { label: t('archive.size'), align: 'right' },
    { label: t('archive.exported') },
    { label: t('archive.verified') },
  ];
  const archiveCells = (a: TelemetryArchiveRow) => [
    <>{monthLabel(a.month)}</>,
    <>{clientName(a.tenantId)}</>,
    <>{a.part}</>,
    <span className="font-mono">{Number(a.rowCount).toLocaleString()}</span>,
    <span className="font-mono">{bytes(a.byteSize)}</span>,
    <span className="text-slate-500">{new Date(a.exportedAt).toLocaleString()}</span>,
    <>{a.verifiedAt ? <Chip tone="emerald">{t('archive.status.verified')}</Chip>
                      : a.verifyError ? <span title={a.verifyError}><Chip tone="rose">{t('archive.status.failed')}</Chip></span>
                        : <Chip tone="amber">{t('archive.status.pending')}</Chip>}</>,
  ];
  const dropColumns: ListColumn[] = [
    { label: ts('listCol.partition') }, { label: t('archive.month') },
    { label: t('archive.rows'), align: 'right' as const }, { label: ts('listCol.droppedAt') },
  ];
  const dropCells = (d: TelemetryPartitionDrop) => [
    <span className="font-mono">{d.partition_name}</span>,
    monthLabel(d.month),
    Number(d.rows_dropped).toLocaleString(),
    new Date(d.dropped_at).toLocaleString(),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Info className="w-4 h-4 shrink-0 text-slate-400" />
          <span>
            {t('archive.intro')}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button onClick={load} disabled={loading} className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-50 cursor-pointer shrink-0" title={t('archive.refresh')}>
          <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
          <Archive className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('archive.exports')}</h3>
        </div>
        {archives === null ? (
          <div className="py-6 text-center text-slate-400 text-xs">{error ? '—' : t('archive.loading')}</div>
        ) : archives.length === 0 ? (
          <div className="py-6 text-center text-slate-400 text-xs">{t('archive.noArchives')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={archiveColumns} rows={pagedArchives} rowKey={(a) => a.id} cells={archiveCells} />
        ) : (
          <div className="p-4"><RecordCards columns={archiveColumns} rows={pagedArchives} rowKey={(a) => a.id} cells={archiveCells} /></div>
        )}
        {!!archives?.length && <TablePagination {...archivePager} />}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('archive.droppedPartitions')}</h3>
          <p className="text-[11px] text-slate-400">{t('archive.droppedHint')}</p>
        </div>
        {drops.length === 0 ? (
          <p className="py-6 text-center text-slate-400 text-xs">{t('archive.noDrops')}</p>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={dropColumns} rows={pagedDrops} rowKey={(d) => d.partition_name} cells={dropCells} />
        ) : (
          <div className="p-4"><RecordCards columns={dropColumns} rows={pagedDrops} rowKey={(d) => d.partition_name} cells={dropCells} /></div>
        )}
        {drops.length > 0 && <TablePagination pinToBottom {...dropPager} />}
      </div>
    </div>
  );
};
