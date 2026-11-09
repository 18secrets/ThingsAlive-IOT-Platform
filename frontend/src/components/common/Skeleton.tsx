import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A placeholder in the shape of what is coming, instead of the word "Loading…"
 * (test report MAJ-6). The text jumped the layout when the data arrived and read as
 * an error on a slow site connection; bars the size of the content do neither.
 *
 * Same pulse and tones as the site twin's own placeholder (SiteTwinCard), so the
 * console has one look for "on its way". Screen readers still hear the translated
 * "Loading" through role="status": the bars are decoration, the words are not lost.
 */
export const Skeleton: React.FC<{ lines?: number; className?: string }> = ({ lines = 3, className = '' }) => {
  const { t } = useTranslation();
  // Last bar shorter, as the end of a paragraph or list is.
  const widths = Array.from({ length: lines }, (_, i) => (i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full'));
  return (
    <div role="status" aria-live="polite" className={`space-y-2 py-1 ${className}`}>
      {widths.map((w, i) => (
        <div key={i} className={`h-3 ${w} rounded bg-slate-100 dark:bg-slate-800 animate-pulse`} />
      ))}
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
};
