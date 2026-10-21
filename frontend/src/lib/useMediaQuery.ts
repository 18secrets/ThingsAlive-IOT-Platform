import { useEffect, useState } from 'react';

/** Whether a CSS media query matches right now, re-rendering when it changes —
 *  for layout that has to change structure (a drawer instead of a sidebar), which a
 *  Tailwind class alone cannot do. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The shell's two layout steps, on the same widths as Tailwind's lg and xl. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
export const WIDE_QUERY = '(min-width: 1280px)';
