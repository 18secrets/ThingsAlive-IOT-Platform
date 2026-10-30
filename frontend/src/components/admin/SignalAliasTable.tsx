import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, Trash2, AlertCircle } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { SignalAlias, SignalAliasInput } from '../../lib/api';
import { AddSignalAliasModal } from './AddSignalAliasModal';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

interface SignalAliasTableProps {
  aliases: SignalAlias[];
  error?: string;
  onUpsertAlias: (input: SignalAliasInput) => Promise<SignalAlias>;
  onDeleteAlias: (sourceSystem: string, alias: string) => Promise<void>;
}

export const SignalAliasTable: React.FC<SignalAliasTableProps> = ({
  aliases, error, onUpsertAlias, onDeleteAlias,
}) => {
  const { t } = useTranslation('catalog');
  const [viewMode, setViewMode] = useViewMode('admin-signal-aliases');
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<SignalAlias | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const filteredAliases = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return aliases.filter((a) =>
      a.alias.toLowerCase().includes(term) ||
      a.canonical.toLowerCase().includes(term) ||
      a.sourceSystem.toLowerCase().includes(term));
  }, [aliases, searchTerm]);

  async function remove(a: SignalAlias) {
    const key = `${a.sourceSystem}|${a.alias}`;
    if (!window.confirm(t('aliases.confirmDelete', { alias: a.alias, source: a.sourceSystem }))) return;
    setBusyKey(key);
    try {
      await onDeleteAlias(a.sourceSystem, a.alias);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('aliases.deleteFailed'));
    } finally {
      setBusyKey(null);
    }
  }

  const { pageItems: pagedRows, ...pager } = usePagination(filteredAliases);


  // One definition for both views (tester request: cards or list on every list page).
  const viewColumns = [
    { label: t('aliases.sourceSystem') },
    { label: t('aliases.upstreamSpelling') },
    { label: t('aliases.canonicalName') },
    { label: t('sensorModal.unit') },
    { label: t('aliases.note') },
    { label: t('common.action') },
  ];
  const viewCells = (a: (typeof pagedRows)[number]) => {

                const key = `${a.sourceSystem}|${a.alias}`;
    return [
      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{a.sourceSystem}</span>,
      <span className="font-mono text-sm text-slate-900 dark:text-white">{a.alias}</span>,
      <><span className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                        {a.canonical}
                      </span></>,
      <span className="text-slate-500 dark:text-slate-400">{a.unit ?? '—'}</span>,
      <span className="text-slate-500 dark:text-slate-400 max-w-xs truncate">{a.note ?? '—'}</span>,
      <><div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => { setEditingAlias(a); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title={t('aliases.edit')}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={busyKey === key}
                          onClick={() => remove(a)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-rose-600 hover:border-rose-300 disabled:opacity-50 transition-colors cursor-pointer"
                          title={t('aliases.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div></>,
    ];
  };

  return (
    <div id="signal-alias-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('aliases.searchPlaceholder')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          id="add-signal-alias-btn"
          onClick={() => { setEditingAlias(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('aliases.add')}</span>
        </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        {filteredAliases.length === 0 ? (
          <div className="py-10 flex flex-col items-center gap-2 text-slate-400 text-sm">{t('aliases.none')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={viewColumns} rows={pagedRows} rowKey={(a) => `${a.sourceSystem}|${a.alias}`} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedRows} rowKey={(a) => `${a.sourceSystem}|${a.alias}`} cells={viewCells} actionsIndex={5} /></div>
        )}

        <div className="px-6 py-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 font-sans">
          {t('aliases.footer')}
        </div>
        <TablePagination pinToBottom {...pager} />
      </div>

      <AddSignalAliasModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingAlias(null); }}
        onSave={onUpsertAlias}
        existingAlias={editingAlias}
      />
    </div>
  );
};
