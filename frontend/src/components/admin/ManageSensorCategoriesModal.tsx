import React, { useState } from 'react';
import { X, AlertCircle, Archive, RotateCcw, Trash2, Edit2, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, SensorCategory } from '../../lib/api';
import { compareByCategoryOrder } from '../../lib/sensorCategoryOrder';

interface ManageSensorCategoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: SensorCategory[];
  showRetired: boolean;
  onToggleShowRetired: (next: boolean) => void;
  onRetire: (id: string) => Promise<SensorCategory>;
  onUnretire: (id: string) => Promise<SensorCategory>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<SensorCategory>;
}

export const ManageSensorCategoriesModal: React.FC<ManageSensorCategoriesModalProps> = ({
  isOpen, onClose, categories, showRetired, onToggleShowRetired, onRetire, onUnretire, onDelete, onRename,
}) => {
  const { t } = useTranslation('catalog');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!isOpen) return null;

  const sorted = [...categories].sort((a, b) => compareByCategoryOrder(a.name, b.name));

  const withBusy = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[80vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('sensorCategories.title')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4 shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => onToggleShowRetired(e.target.checked)}
              className="accent-sky-600"
            />
            {t('common.showRetired')}
          </label>

          {error && (
            <div className="mt-3 flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-2">
          {sorted.map((c) => {
            const retired = !!c.retiredAt;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  {renaming?.id === c.id ? (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = renaming.name.trim();
                        if (!name || name === c.name) { setRenaming(null); return; }
                        withBusy(c.id, async () => { await onRename(c.id, name); setRenaming(null); });
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
                        className="flex-1 min-w-0 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                      />
                      <button type="submit" disabled={busyId === c.id} title={t('sensorCategories.saveName')} className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-emerald-600 cursor-pointer disabled:opacity-50">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </form>
                  ) : (
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{c.name}</div>
                  )}
                  {retired && (
                    <div className="text-[11px] text-slate-400">
                      {t('sensorCategories.retiredOn', { date: new Date(c.retiredAt!).toLocaleDateString() })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {renaming?.id !== c.id && (
                    <button
                      onClick={() => { setError(undefined); setRenaming({ id: c.id, name: c.name }); }}
                      disabled={busyId === c.id}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer disabled:opacity-50"
                      title={t('sensorCategories.renameHint')}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => withBusy(c.id, () => (retired ? onUnretire(c.id) : onRetire(c.id)))}
                    disabled={busyId === c.id}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-amber-600 hover:border-amber-300 transition-colors cursor-pointer disabled:opacity-50"
                    title={retired ? t('sensors.unretireHint') : t('sensorCategories.retireHint')}
                  >
                    {retired ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => withBusy(c.id, () => onDelete(c.id))}
                    disabled={busyId === c.id}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-50"
                    title={t('sensorCategories.deleteHint')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}

          {sorted.length === 0 && (
            <div className="py-8 text-center text-slate-400 text-sm">{t('sensorCategories.none')}</div>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-700 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
