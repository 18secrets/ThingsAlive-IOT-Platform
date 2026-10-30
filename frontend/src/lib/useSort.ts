import { useState } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> { key: K; dir: SortDir }
export type SortValue = string | number | null | undefined;

/**
 * Sort state for a list page. It sorts the whole filtered set before it is paged — a
 * table header that sorted only the page on screen would have left EX-04, the highest
 * risk, on page 7 of 7 (test report MAJ-9).
 */
export function useSort<K extends string>(initial: SortState<K>) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  /** Same key flips direction; a new key starts in that key's natural direction. */
  const toggle = (key: K, firstDir: SortDir = 'asc') =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir }));
  return { sort, setSort, toggle };
}

/** Missing values go last whichever way the column runs: an unscored machine is not "lowest risk". */
export function sortRows<T, K extends string>(
  rows: readonly T[], sort: SortState<K>, by: Record<K, (row: T) => SortValue>,
): T[] {
  const pick = by[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    const ma = va === null || va === undefined || va === '';
    const mb = vb === null || vb === undefined || vb === '';
    if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
    const c = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return c * sign;
  });
}
