import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * A list that shows at most `max` rows and scrolls inside its card for the rest. A site
 * with thirty machines made its Machines card thirty rows tall and pushed everything
 * below it down the page (4 Nov). The height is measured from the rows themselves, the
 * `max`-th one's bottom, so it stays exactly `max` rows at any text size or language
 * rather than a guessed rem height that cuts a row in half.
 */
export const ScrollRows: React.FC<{ max?: number; className?: string; children: React.ReactNode }> = ({
  max = 10, className = '', children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const count = React.Children.count(children);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.children.length <= max) { setHeight(undefined); return; }
      const last = el.children[max - 1] as HTMLElement;
      // offsetTop is from this box (it is the rows' offsetParent: relative below).
      setHeight(last.offsetTop + last.offsetHeight + 2);
    };
    measure();
    // Text size and window width change row heights; re-measure on either.
    window.addEventListener('resize', measure);
    window.addEventListener('ta-text-size', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('ta-text-size', measure);
    };
  }, [count, max]);

  return (
    <div
      ref={ref}
      style={height ? { maxHeight: height } : undefined}
      className={`relative ${height ? 'overflow-y-auto pr-1 overscroll-contain' : ''} ${className}`}
    >
      {children}
    </div>
  );
};
