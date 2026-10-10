import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { Input } from 'rsuite';
import { ApiError, SignalStateVocabEntry, SignalStateCode } from '../../lib/api';

interface AddSignalStateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (role: string, states: SignalStateCode[]) => Promise<SignalStateVocabEntry[]>;
  /** Null when creating a brand-new role's vocabulary. */
  existingRole: string | null;
  existingStates: SignalStateCode[];
}

interface StateRow {
  state: string;
  code: string;
}

const emptyRow = (): StateRow => ({ state: '', code: '' });

export const AddSignalStateModal: React.FC<AddSignalStateModalProps> = ({
  isOpen, onClose, onSave, existingRole, existingStates,
}) => {
  const [role, setRole] = useState('');
  const [rows, setRows] = useState<StateRow[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = existingRole !== null;

  useEffect(() => {
    if (!isOpen) return;
    setRole(existingRole ?? '');
    setRows(existingStates.length
      ? existingStates.map((s) => ({ state: s.state, code: String(s.code) }))
      : [emptyRow()]);
    setError(undefined);
  }, [isOpen, existingRole, existingStates]);

  if (!isOpen) return null;

  const updateRow = (i: number, field: keyof StateRow, value: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const filled = rows.filter((r) => r.state.trim() !== '' || r.code.trim() !== '');
  const allValid = !!role.trim() && filled.length > 0 && filled.every(
    (r) => /^[a-z][a-z0-9_]*$/.test(r.state.trim()) && /^\d+$/.test(r.code.trim()),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allValid) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(
        role.trim(),
        filled.map((r) => ({ state: r.state.trim(), code: Number(r.code) })),
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this vocabulary.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addSignalStateModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Vocabulary' : 'New Vocabulary'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? 'Replaces every state and code for this role as a whole.'
                  : 'States a categorical signal can carry, and the code each one means.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Measurement Role <span className="text-rose-500">*</span>
            </label>
            <Input
              size="sm"
              required
              autoFocus
              disabled={isEditing}
              value={role}
              onChange={(value) => setRole(value)}
              placeholder="e.g. utilization_status"
            />
          </div>

          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_auto] gap-2 items-center">
                <Input
                  size="sm"
                  value={r.state}
                  onChange={(value) => updateRow(i, 'state', value)}
                  placeholder="state, e.g. working"
                />
                <Input
                  size="sm"
                  value={r.code}
                  onChange={(value) => updateRow(i, 'code', value)}
                  placeholder="code, e.g. 2"
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 1}
                  className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  title="Remove state"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addRow}
            className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold flex items-center gap-1 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add state</span>
          </button>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              A state is lower_snake_case; a code is a whole number ≥ 0
            </span>
            <button
              type="submit"
              disabled={busy || !allValid}
              className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{busy ? 'Saving…' : 'Save Vocabulary'}</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
