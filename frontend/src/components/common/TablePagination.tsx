import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';

const PAGE_SIZES = [10, 20, 50];

/**
 * Client-side paging for a list that is already filtered. Back to page 1 whenever the
 * number of rows changes (a search or filter was applied), and never left past the
 * last page when rows are removed.
 */
export function usePagination<T>(items: T[], initialPageSize = 10) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => { setPage(1); }, [total]);
  const current = Math.min(page, totalPages);

  return {
    pageItems: items.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    setPage,
    pageSize,
    setPageSize: (size: number) => { setPageSize(size); setPage(1); },
    total,
    totalPages,
  };
}

/** Page numbers to show: the first, the last, and the current one with a neighbour each side. */
function pageList(current: number, totalPages: number): (number | 'gap')[] {
  const wanted = new Set([1, totalPages, current - 1, current, current + 1].filter((p) => p >= 1 && p <= totalPages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

/** The footer the paged tables share, in the look Equipment and Alert Agent already used. */
export const TablePagination: React.FC<{
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  total: number;
  totalPages: number;
  /** For lists outside a table card, which have no border of their own to sit on. */
  bare?: boolean;
  /** For a narrow side column: stacked, and no page-size picker. */
  compact?: boolean;
}> = ({ page, setPage, pageSize, setPageSize, total, totalPages, bare, compact }) => {
  const { t } = useTranslation('shared');
  const navClass = 'p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer';
  return (
    <div className={`flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 font-sans ${
      compact ? 'flex-col pt-2' : 'px-4 sm:px-6 py-3.5 flex-col sm:flex-row'
    } ${
      compact ? '' : bare ? 'border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900' : 'border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30'
    }`}>
      <div>
        {t('pagination.totalRows')} <span className="font-semibold text-slate-800 dark:text-slate-200">{total}</span>
      </div>
      <div className="flex items-center gap-4 flex-wrap justify-center">
        {!compact && <div className="flex items-center gap-2">
          <span>{t('pagination.rowsPerPage')}</span>
          <SelectPicker
            data={PAGE_SIZES.map((n) => ({ label: String(n), value: n }))}
            value={pageSize}
            onChange={(value) => setPageSize(Number(value ?? 10))}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-20"
          />
        </div>}
        <div className="flex items-center gap-1">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('pagination.previous')} className={navClass}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          {pageList(page, totalPages).map((p, i) => p === 'gap' ? (
            <span key={`gap-${i}`} className="w-5 text-center text-slate-400">…</span>
          ) : (
            <button
              type="button"
              key={p}
              onClick={() => setPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`min-w-7 h-7 px-1 rounded text-xs font-semibold flex items-center justify-center transition-colors cursor-pointer ${
                p === page
                  ? 'bg-[#0B7285] text-white border border-[#0B7285]'
                  : 'border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {p}
            </button>
          ))}
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label={t('pagination.next')} className={navClass}>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
