import React from 'react';
import { ChevronRight } from 'lucide-react';
import { ListColumn } from './ListTable';

/**
 * The card half of a cards/list page whose list came first: the same columns and the
 * same cells ListTable shows, laid out as cards. The first column is the card's title,
 * an actions column (if any) sits at the foot, every other column is a labelled line.
 * Built from one definition so the two views cannot show different things.
 */
export function RecordCards<T>({ columns, rows, rowKey, cells, onOpen, actionsIndex }: {
  columns: ListColumn[];
  rows: T[];
  rowKey: (row: T) => string;
  cells: (row: T) => React.ReactNode[];
  onOpen?: (row: T) => void;
  /** Which column holds the row's buttons; shown at the foot of the card, unlabelled. */
  actionsIndex?: number;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {rows.map((row) => {
        const values = cells(row);
        return (
          <div
            key={rowKey(row)}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex flex-col gap-3 hover:border-sky-300 dark:hover:border-sky-700 transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold text-slate-900 dark:text-white text-sm leading-snug min-w-0">{values[0]}</div>
              {onOpen && (
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  className="p-1 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                  aria-label={columns[0]?.label}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              {columns.map((c, i) => (i === 0 || i === actionsIndex ? null : (
                <React.Fragment key={c.label}>
                  <dt className="text-slate-400 dark:text-slate-500 whitespace-nowrap">{c.label}</dt>
                  <dd className="text-slate-700 dark:text-slate-200 min-w-0 break-words">{values[i]}</dd>
                </React.Fragment>
              )))}
            </dl>
            {actionsIndex !== undefined && (
              <div className="pt-3 mt-auto border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-1.5">
                {values[actionsIndex]}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
