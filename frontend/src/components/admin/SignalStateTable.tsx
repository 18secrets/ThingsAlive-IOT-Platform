import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, AlertCircle } from 'lucide-react';
import { Input } from 'rsuite';
import { SignalStateVocabEntry, SignalStateCode } from '../../lib/api';
import { AddSignalStateModal } from './AddSignalStateModal';

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
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleGroup | null>(null);

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

  return (
    <div id="signal-state-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder="Search Measurement Role or State..."
              size="sm"
              className="w-full pl-9!"
            />
          </div>
        </div>

        <button
          id="add-signal-state-btn"
          onClick={() => { setEditingRole(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Vocabulary</span>
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
                <th className="py-3 px-4">Measurement Role</th>
                <th className="py-3 px-4">States</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredGroups.map((g) => (
                <tr key={g.role} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3.5 px-4 font-mono text-sm text-slate-900 dark:text-white align-top">
                    {g.role}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex flex-wrap gap-1.5 max-w-xl">
                      {g.states.map((s) => (
                        <span
                          key={s.state}
                          className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                        >
                          {s.state} = {s.code}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 align-top">
                    <div className="flex items-center justify-center">
                      <button
                        onClick={() => { setEditingRole(g); setIsModalOpen(true); }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                        title="Edit Vocabulary"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {filteredGroups.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-10 text-center text-slate-400 text-sm">
                    No signal state vocabularies found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{filteredGroups.length}</span> Measurement Roles</div>
          <div className="text-[11px] text-slate-400 font-sans">
            A role's whole vocabulary is replaced as a set — there is no single-state edit
          </div>
        </div>
      </div>

      <AddSignalStateModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingRole(null); }}
        onSave={onReplaceStates}
        existingRole={editingRole?.role ?? null}
        existingStates={editingRole?.states.map((s) => ({ state: s.state, code: s.code })) ?? []}
      />
    </div>
  );
};
