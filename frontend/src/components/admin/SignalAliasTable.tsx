import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, Trash2, AlertCircle } from 'lucide-react';
import { Input } from 'rsuite';
import { SignalAlias, SignalAliasInput } from '../../lib/api';
import { AddSignalAliasModal } from './AddSignalAliasModal';

interface SignalAliasTableProps {
  aliases: SignalAlias[];
  error?: string;
  onUpsertAlias: (input: SignalAliasInput) => Promise<SignalAlias>;
  onDeleteAlias: (sourceSystem: string, alias: string) => Promise<void>;
}

export const SignalAliasTable: React.FC<SignalAliasTableProps> = ({
  aliases, error, onUpsertAlias, onDeleteAlias,
}) => {
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
    if (!window.confirm(`Delete the alias "${a.alias}" (${a.sourceSystem})? This cannot be undone.`)) return;
    setBusyKey(key);
    try {
      await onDeleteAlias(a.sourceSystem, a.alias);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not delete this alias.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div id="signal-alias-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder="Search Alias, Canonical Name, or Source..."
              size="sm"
              className="w-full pl-9!"
            />
          </div>
        </div>

        <button
          id="add-signal-alias-btn"
          onClick={() => { setEditingAlias(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Signal Alias</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">Source System</th>
                <th className="py-3 px-4">Upstream Spelling</th>
                <th className="py-3 px-4">Canonical Name</th>
                <th className="py-3 px-4">Unit</th>
                <th className="py-3 px-4">Note</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredAliases.map((a) => {
                const key = `${a.sourceSystem}|${a.alias}`;
                return (
                  <tr key={key} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {a.sourceSystem}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-sm text-slate-900 dark:text-white">
                      {a.alias}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                        {a.canonical}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 dark:text-slate-400">{a.unit ?? '—'}</td>
                    <td className="py-3.5 px-4 text-slate-500 dark:text-slate-400 max-w-xs truncate" title={a.note ?? undefined}>
                      {a.note ?? '—'}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => { setEditingAlias(a); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Edit Alias"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={busyKey === key}
                          onClick={() => remove(a)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-rose-600 hover:border-rose-300 disabled:opacity-50 transition-colors cursor-pointer"
                          title="Delete Alias"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredAliases.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400 text-sm">
                    No signal aliases found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{filteredAliases.length}</span> Signal Aliases</div>
          <div className="text-[11px] text-slate-400 font-sans">
            A scenario expecting the canonical name fires for every source spelling mapped to it
          </div>
        </div>
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
