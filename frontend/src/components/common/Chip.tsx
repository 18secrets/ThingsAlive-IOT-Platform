import React from 'react';

export type ChipTone = 'slate' | 'emerald' | 'amber' | 'rose' | 'sky';

const TONE_CLASS: Record<ChipTone, string> = {
  slate: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  emerald: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900',
  amber: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900',
  rose: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900',
  sky: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-900',
};

/** One icon + one short value — the compact replacement for a sentence of caption text. */
export const Chip: React.FC<{
  icon?: React.FC<{ className?: string }>;
  tone?: ChipTone;
  title?: string;
  children: React.ReactNode;
}> = ({ icon: Icon, tone = 'slate', title, children }) => (
  <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}>
    {Icon && <Icon className="w-3 h-3 shrink-0" />}
    {children}
  </span>
);
