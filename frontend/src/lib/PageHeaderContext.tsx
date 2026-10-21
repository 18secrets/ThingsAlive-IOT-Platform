import React, { createContext, useContext, useEffect, useState } from 'react';

export interface PageHeaderConfig {
  title: string;
  subtitle?: string;
  breadcrumb?: string;
  aiIndicator?: boolean;
  onBack?: () => void;
}

interface PageHeaderContextValue {
  override: PageHeaderConfig | null;
  setOverride: (config: PageHeaderConfig | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export const PageHeaderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [override, setOverride] = useState<PageHeaderConfig | null>(null);
  return (
    <PageHeaderContext.Provider value={{ override, setOverride }}>
      {children}
    </PageHeaderContext.Provider>
  );
};

/** Shell reads this to know what a page has asked for, falling back to a
 *  static per-route title when nothing overrides it. */
export function usePageHeaderValue(): PageHeaderConfig | null {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error('usePageHeaderValue used outside PageHeaderProvider');
  return ctx.override;
}

/**
 * A page with more than one internal view (AI Onboarding's list/chat/detail,
 * Alert Agent's list/assistant/workflow) calls this whenever that view
 * changes, so the shared Header shows the right title and back button
 * without the page needing to render its own header or Shell needing to
 * know about every page's internal states.
 *
 * `onBack` is deliberately left out of the dependency list: it is a fresh
 * closure every render, and re-running the effect on every render (rather
 * than only when the view actually changes) would fight with the cleanup
 * below and flicker the header back to the route default and forward again.
 */
export function usePageHeader(config: PageHeaderConfig): void {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error('usePageHeader used outside PageHeaderProvider');
  const { setOverride } = ctx;
  const { title, subtitle, breadcrumb, aiIndicator, onBack } = config;
  useEffect(() => {
    setOverride({ title, subtitle, breadcrumb, aiIndicator, onBack });
    // Clears back to the route's static default the moment this page unmounts.
    return () => setOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle, breadcrumb, aiIndicator]);
}
