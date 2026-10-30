import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pagination, SelectPicker } from 'rsuite';
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

/**
 * The one box a paged list and its footer share, cards or rows alike. With a pinned footer
 * the box reaches the foot of the screen, so a short list leaves white inside the box and
 * not a gap between the list and a footer of its own (TC_132 asked for the footer at the
 * foot; the tester review after it asked for one look across the pages).
 */
export const LIST_PANEL = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden';

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
  return (
    <div
      ref={pin.ref}
      // A bare footer adds the space to the gap its parent's spacing already gives it. Inside
      // a box there is no such gap; the space stays inside the box, above the footer's line.
      style={pinToBottom && pin.gap ? { marginTop: bare ? `calc(0.75rem + ${pin.gap}px)` : `${pin.gap}px` } : undefined}
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
            // Card pages page by a multiple of their grid's columns (9, 12), which is not
            // one of the stock sizes; offered too, or the picker reads "Select".
            data={[...new Set([...PAGE_SIZES, pageSize])].sort((a, b) => a - b).map((n) => ({ label: String(n), value: n }))}
            value={pageSize}
            onChange={(value) => setPageSize(Number(value ?? 10))}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-20"
          />
        </div>}
        {/* rsuite's own pager, so every list in the console pages the same way. */}
        <Pagination
          prev
          next
          ellipsis
          boundaryLinks
          maxButtons={5}
          size="xs"
          total={total}
          limit={pageSize}
          activePage={page}
          onChangePage={setPage}
        />
      </div>
    </div>
  );
};
