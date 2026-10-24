import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/**
 * Space above the footer that takes up whatever the page leaves empty below it, so the
 * footer sits at the foot of the screen on a short list and right after the list on a
 * long one (TC_132: on a page of two cards it floated halfway up). Measured against the
 * scrolling <main>, re-measured whenever it or its content resizes. Only for a footer
 * that is the last thing on its page; anything after it would be pushed down too.
 */
function usePinToBottom(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [gap, setGap] = useState(0);
  const applied = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest('main');
    if (!enabled || !el || !scroller) return;
    const measure = () => {
      // What the page would leave empty without the space already added. Measured from
      // the content, not scrollHeight: that never reads less than the visible height.
      const content = scroller.firstElementChild as HTMLElement | null;
      if (!content) return;
      const pad = getComputedStyle(scroller);
      const inner = scroller.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
      const free = Math.max(0, Math.floor(inner - (content.offsetHeight - applied.current)));
      applied.current = free;
      setGap(free);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [enabled]);
  return { ref, gap };
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
  /** Keep the footer at the foot of the screen when the list is short (see usePinToBottom). */
  pinToBottom?: boolean;
}> = ({ page, setPage, pageSize, setPageSize, total, totalPages, bare, compact, pinToBottom = false }) => {
  const { t } = useTranslation('shared');
  const pin = usePinToBottom(pinToBottom);
  const navClass = 'p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer';
  return (
    <div
      ref={pin.ref}
      // On top of the gap the parent's spacing already gives it, never instead of it.
      style={pinToBottom && pin.gap ? { marginTop: `calc(0.75rem + ${pin.gap}px)` } : undefined}
      className={`flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 font-sans ${
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
