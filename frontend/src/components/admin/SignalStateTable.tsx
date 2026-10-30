import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, AlertCircle } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { SignalStateVocabEntry, SignalStateCode } from '../../lib/api';
import { AddSignalStateModal } from './AddSignalStateModal';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

interface SignalStateTableProps {
  states: SignalStateVocabEntry[];
  error?: string;
  onReplaceStates: (role: string, states: SignalStateCode[]) => Promise<SignalStateVocabEntry[]>;
}

interface RoleGroup {
  role: string;
  states: SignalStateVocabEntry[];
}

export const SignalStateTable: React.FC<SignalStateTableProps> = ({
  states, error, onReplaceStates,
}) => {
  const { t } = useTranslation('catalog');
  const [viewMode, setViewMode] = useViewMode('admin-signal-states');
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleGroup | null>(null);
  // Stable between renders: the modal resets its form whenever this changes, so a
  // fresh array on every render wiped whatever was being typed.
  const editingStates = useMemo(
    () => editingRole?.states.map((s) => ({ state: s.state, code: s.code })) ?? [],
    [editingRole],
  );

  const groups = useMemo<RoleGroup[]>(() => {
    const byRole = new Map<string, SignalStateVocabEntry[]>();
    for (const s of states) {
      byRole.set(s.measurementRole, [...(byRole.get(s.measurementRole) ?? []), s]);
    }
    return [...byRole.entries()]
      .map(([role, rows]) => ({ role, states: rows.sort((a, b) => a.code - b.code) }))
      .sort((a, b) => a.role.localeCompare(b.role));
  }, [states]);

  const filteredGroups = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return groups.filter((g) =>
      g.role.toLowerCase().includes(term) ||
      g.states.some((s) => s.state.toLowerCase().includes(term)));
  }, [groups, searchTerm]);

  const { pageItems: pagedRows, ...pager } = usePagination(filteredGroups);


  // One definition for both views (tester request: cards or list on every list page).
  const viewColumns = [
    { label: t('states.measurementRole') },
    { label: t('states.states') },
    { label: t('common.action') },
  ];
  const viewCells = (g: (typeof pagedRows)[number]) => {
    return [
      <span className="font-mono text-sm text-slate-900 dark:text-white align-top">{g.role}</span>,
      <><div className="flex flex-wrap gap-1.5 max-w-xl">
                      {g.states.map((s) => (
                        <span
                          key={s.state}
                          className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                        >
                          {s.state} = {s.code}
                        </span>
                      ))}
                    </div></>,
      <span className="align-top"><div className="flex items-center justify-center">
                      <button
                        onClick={() => { setEditingRole(g); setIsModalOpen(true); }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                        title={t('states.edit')}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div></span>,
    ];
  };

  return (
    <div id="signal-state-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('states.searchPlaceholder')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          id="add-signal-state-btn"
          onClick={() => { setEditingRole(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('states.add')}</span>
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
        {filteredGroups.length === 0 ? (
          <div className="py-10 flex flex-col items-center gap-2 text-slate-400 text-sm">{t('states.none')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={viewColumns} rows={pagedRows} rowKey={(g) => String(g.role)} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedRows} rowKey={(g) => String(g.role)} cells={viewCells} actionsIndex={2} /></div>
        )}

        <div className="px-6 py-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 font-sans">
          {t('states.footer')}
        </div>
        <TablePagination pinToBottom {...pager} />
      </div>

      <AddSignalStateModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingRole(null); }}
        onSave={onReplaceStates}
        existingRole={editingRole?.role ?? null}
        existingStates={editingStates}
      />
    </div>
  );
};
