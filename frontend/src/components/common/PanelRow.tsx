import React from 'react';
import { appLocale } from '../../lib/dateLocale';

/**
 * One item in a dashboard-style panel, on two lines: what it is, then what it is about.
 * One line holding everything ("EX-03 Breaching · engine_coolant_temperature …") read as
 * cramped and cut the item's own words off (team feedback, 3 Nov 2026). Used by the
 * Dashboard's panels and Machine summary's, so the two read the same.
 */
export const PanelRow: React.FC<{
  title: React.ReactNode;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  meta?: React.ReactNode;
  onClick?: () => void;
  /** A title that is a sentence (an alert's summary) wraps in full: its end is the reading that breached. */
  wrapTitle?: boolean;
}> = ({ title, detail, right, meta, onClick, wrapTitle }) => {
  const body = (
    <>
      <span className="min-w-0 space-y-0.5">
        <span className={`block text-sm font-medium text-slate-800 dark:text-slate-100 ${wrapTitle ? 'break-words' : 'truncate'}`}>{title}</span>
        {detail && <span className="block text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{detail}</span>}
      </span>
      {(right || meta) && (
        <span className="shrink-0 flex flex-col items-end gap-1">
          {right}
          {meta && <span className="text-[0.6875rem] text-slate-400 whitespace-nowrap">{meta}</span>}
        </span>
      )}
    </>
  );
  const layout = 'w-full text-left flex items-start justify-between gap-3 py-2.5';
  return onClick ? (
    <button type="button" onClick={onClick} className={`${layout} px-2 -mx-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer`}>
      {body}
    </button>
  ) : (
    <div className={layout}>{body}</div>
  );
};

/** The rows of a panel, with a hairline between them. */
export const PanelRows: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="divide-y divide-slate-100 dark:divide-slate-800">{children}</div>
);

/** "3 Nov, 14:05": when, short enough for the corner of a row. */
export const shortWhen = (iso: string) =>
  new Date(iso).toLocaleString(appLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
