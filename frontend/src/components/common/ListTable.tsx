import React from 'react';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import type { SortState } from '../../lib/useSort';

export interface ListColumn {
  label: string;
  /** Right-align numbers so a column of them reads down. */
  align?: 'left' | 'right';
  /** Makes the header a sort control for that key; the page sorts its full set. */
  sortKey?: string;
}

/** A header that sorts by its key; shared with the admin tables that draw their own <th>. */
export const SortLabel: React.FC<{ label: string; sortKey: string; sort?: SortState<string>; onSort: (key: string) => void }> = ({
  label, sortKey, sort, onSort,
}) => (
  <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 cursor-pointer hover:text-sky-600 dark:hover:text-sky-400">
    {label}
    {sort?.key === sortKey
      ? (sort.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
      : <ChevronDown className="w-3 h-3 opacity-25" />}
  </button>
);

/**
 * The list half of a cards/list page (see ViewModeToggle): the same rows the cards show,
 * one per line, in the table look the paged admin lists already use. Every row opens
 * what its card opens, so switching view never changes what a click does.
 */
export function ListTable<T>({ columns, rows, rowKey, cells, onOpen, sort, onSort }: {
  columns: ListColumn[];
  rows: T[];
  rowKey: (row: T) => string;
  cells: (row: T) => React.ReactNode[];
  onOpen?: (row: T) => void;
  sort?: SortState<string>;
  onSort?: (key: string) => void;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
            <tr>
              {columns.map((c) => (
                <th key={c.label} className={`py-3 px-4 whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}
                  aria-sort={c.sortKey && sort?.key === c.sortKey ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sortKey && onSort ? <SortLabel label={c.label} sortKey={c.sortKey} sort={sort} onSort={onSort} /> : c.label}
                </th>
              ))}
              {onOpen && <th className="py-3 px-2 w-8" aria-hidden />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onOpen ? () => onOpen(row) : undefined}
                className={`text-slate-700 dark:text-slate-200 ${onOpen ? 'cursor-pointer hover:bg-sky-50/60 dark:hover:bg-sky-950/30' : ''}`}
              >
                {cells(row).map((cell, i) => (
                  <td key={columns[i]?.label ?? i} className={`py-2.5 px-4 ${columns[i]?.align === 'right' ? 'text-right tabular-nums' : ''}`}>{cell}</td>
                ))}
                {onOpen && <td className="py-2.5 px-2 text-slate-300"><ChevronRight className="w-4 h-4" /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
