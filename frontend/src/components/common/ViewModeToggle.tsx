import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, List } from 'lucide-react';

export type ViewMode = 'cards' | 'list';

/**
 * Cards or a list. Every page opens as a list, and a switch to cards lasts only while
 * the person stays on that page (tester request, 2 Nov 2026 — the 24 Oct version
 * remembered each page's choice per viewer, so a page could open as cards). `page`
 * names the page for callers; nothing is stored under it any more.
 */
export function useViewMode(_page: string): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>('list');
  return [mode, setMode];
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
      className={`p-1 rounded-md cursor-pointer transition-colors ${
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
