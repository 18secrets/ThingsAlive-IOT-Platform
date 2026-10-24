import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, List } from 'lucide-react';

export type ViewMode = 'cards' | 'list';

/**
 * Cards or a list, remembered per page (tester request, 24 Oct 2026): cards read well
 * for a handful of machines and badly for a hundred. Per viewer and per page, in
 * localStorage — a preference, not shared state — and every access is guarded, since
 * storage can be missing or refused (private windows), in which case cards it is.
 */
export function useViewMode(page: string): [ViewMode, (mode: ViewMode) => void] {
  const key = `ta.viewMode.${page}`;
  const [mode, setMode] = useState<ViewMode>(() => {
    try { return localStorage.getItem(key) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
  });
  const set = (next: ViewMode) => {
    setMode(next);
    try { localStorage.setItem(key, next); } catch { /* a preference, nothing lost */ }
  };
  return [mode, set];
}

export const ViewModeToggle: React.FC<{ mode: ViewMode; onChange: (mode: ViewMode) => void }> = ({ mode, onChange }) => {
  const { t } = useTranslation('shared');
  const button = (value: ViewMode, Icon: React.FC<{ className?: string }>, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={mode === value}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-md cursor-pointer transition-colors ${
        mode === value
          ? 'bg-sky-600 text-white'
          : 'text-slate-500 dark:text-slate-400 hover:text-sky-600 hover:bg-slate-100 dark:hover:bg-slate-800'
      }`}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shrink-0">
      {button('cards', LayoutGrid, t('viewMode.cards'))}
      {button('list', List, t('viewMode.list'))}
    </div>
  );
};
