import React, { Suspense, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { NavigationTab, UserRole, firstAdminSubTab } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { PageHeaderConfig, usePageHeaderValue } from '../lib/PageHeaderContext';
import { Sidebar } from '../components/Sidebar';
import { Header } from '../components/Header';
import { AskAIWidget } from '../components/AskAIWidget';
import { DESKTOP_QUERY, WIDE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { canOpenPath, canOpenTab, firstAllowedAdminSubTab, firstAllowedPath } from '../lib/pageAccess';

interface ShellProps {
  /** Clears any cross-page drill-down state (Master Admin's "Manage Access"
   *  pick) whenever navigation happens via the sidebar itself, matching how
   *  the pre-router App.tsx reset it on every tab switch. */
  onSidebarNavigate?: () => void;
}

const ADMIN_PROMOTED_SUBTABS: NavigationTab[] = ['clients', 'staff', 'devices', 'equipment'];

function tabFromPath(pathname: string, state: unknown, role?: UserRole): NavigationTab {
  const first = pathname.split('/')[1];
  // Reached from Alerts/Predictions/Scenarios/a Thing detail page's "Create
  // alert with AI" button — see AlertAgentPage.tsx's nav state. It has no
  // sidebar entry of its own, so highlight whichever tab this flow started
  // from. (The alert/scenario/prediction rule form itself is a modal now,
  // not a route, so it never changes the URL and needs no entry here.)
  const backTo = (state as { backTo?: string } | null)?.backTo;
  if (first === 'alert-agent' && backTo) return tabFromPath(backTo, null, role);
  // Master Admin's Clients/Staff/Devices/Equipment are still served by
  // AdminPage at /admin/<subtab> (task: move them to the sidebar, 2026-10-10)
  // — only their nav highlighting is promoted above 'Administration'. A
  // client's own /admin/devices or /admin/equipment sub-tab must keep
  // highlighting 'admin', since those stay inside their Administration page.
  if (first === 'admin' && role === 'master-admin') {
    const second = pathname.split('/')[2] as NavigationTab | undefined;
    if (second && ADMIN_PROMOTED_SUBTABS.includes(second)) return second;
  }
  const known: NavigationTab[] = [
    'dashboard', 'things-care', 'things-shield', 'incident-management', 'production-monitoring', 'ai-onboarding', 'alert-agent', 'alerts', 'predictions', 'scenarios', 'work-orders', 'cost-administration',
    'admin', 'client-users', 'roles', 'users', 'settings',
  ];
  return (known as string[]).includes(first) ? (first as NavigationTab) : 'dashboard';
}

/** Static per-route title/subtitle — a page overrides this via usePageHeader
 *  when it has more than one internal view (AI Onboarding, Alert Agent). */
const TAB_PAGE_KEY: Partial<Record<NavigationTab, string>> = {
  admin: 'admin', clients: 'clients', staff: 'staff', devices: 'devices', equipment: 'equipment',
  'things-care': 'thingsCare', 'things-shield': 'thingsShield', 'incident-management': 'incidentManagement',
  'production-monitoring': 'productionMonitoring', 'ai-onboarding': 'aiOnboarding', 'alert-agent': 'alertAgent',
  alerts: 'alerts', predictions: 'predictions', scenarios: 'scenarios', 'work-orders': 'workOrders',
  'cost-administration': 'costAdministration', users: 'users', 'client-users': 'clientUsers', roles: 'roles',
  settings: 'settings',
};

function defaultHeaderFor(tab: NavigationTab, isMasterAdmin: boolean, t: TFunction): PageHeaderConfig {
  const key = TAB_PAGE_KEY[tab] ?? (isMasterAdmin ? 'dashboardPlatform' : 'dashboard');
  return { title: t(`pages.${key}.title`), subtitle: t(`pages.${key}.subtitle`) };
}

const THEME_KEY = 'ta_theme';
const SIDEBAR_COLLAPSED_KEY = 'ta_sidebar_collapsed';

// Falls back to the OS preference on a first visit, then whatever the
// person last chose via the header toggle.
function initialDarkMode(): boolean {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall through to OS preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

// Expanded by default — collapsing is a deliberate choice the sidebar's own
// logo click remembers across sessions, same as the theme toggle.
function initialSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Shown in place of a page this person's role does not open. */
const NoAccess: React.FC<{ goTo: string | null }> = ({ goTo }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div id="no-page-access" className="max-w-lg mx-auto mt-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-center">
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('access.noPageTitle')}</h2>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('access.noPageBody')}</p>
      {goTo && (
        <button
          type="button"
          onClick={() => navigate(goTo, { replace: true })}
          className="mt-5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium cursor-pointer"
        >
          {t('access.goBack')}
        </button>
      )}
    </div>
  );
};

export const Shell: React.FC<ShellProps> = ({ onSidebarNavigate }) => {
  const { authUser, signOut } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [isDarkMode, setIsDarkMode] = useState(initialDarkMode);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(initialSidebarCollapsed);
  const override = usePageHeaderValue();
  const mainRef = useRef<HTMLElement>(null);
  // Below lg (phones, tablets) the sidebar would take 240px of a 375px screen, so it
  // becomes a drawer. From lg to xl (small laptops) it starts as icons; the person's
  // own expand/collapse there is kept for the session but not saved, so it never
  // overrides their choice on a wide screen.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isWide = useMediaQuery(WIDE_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  const [smallLaptopExpanded, setSmallLaptopExpanded] = useState(false);
  const collapsed = isWide ? isSidebarCollapsed : !smallLaptopExpanded;
  const toggleCollapsed = () => (isWide ? setIsSidebarCollapsed((v) => !v) : setSmallLaptopExpanded((v) => !v));

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    try {
      localStorage.setItem(THEME_KEY, isDarkMode ? 'dark' : 'light');
    } catch {
      // Nothing to do if storage is unavailable — the toggle still works for this session.
    }
  }, [isDarkMode]);

  React.useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isSidebarCollapsed));
    } catch {
      // Nothing to do if storage is unavailable — the toggle still works for this session.
    }
  }, [isSidebarCollapsed]);

  // <Outlet/> only swaps the page content, not the scrollable <main> itself,
  // so without this a new page inherits whatever scroll position the last
  // one was left at instead of opening at the top. Keyed on location.key
  // (unique per navigate() call) rather than pathname, so it also resets for
  // same-path navigations with new state — e.g. Alert Agent's view switcher.
  React.useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    setNavOpen(false);
  }, [location.key]);

  // The drawer is a phone/tablet thing; widening the window past lg closes it.
  React.useEffect(() => { if (isDesktop) setNavOpen(false); }, [isDesktop]);

  if (!authUser) return null; // RequireAuth guarantees this never renders signed out.

  const currentTab = tabFromPath(location.pathname, location.state, authUser.role);
  // A page the role does not grant is refused here, not only left out of the menu:
  // its address, a bookmark or a link from another page reached it all the same
  // (tester report, 27 Oct 2026). The landing page quietly moves to the first page
  // the person has; anything else says so.
  const allowedHere = canOpenPath(authUser, location.pathname);
  const landing = firstAllowedPath(authUser);
  const isLanding = location.pathname === '/' || location.pathname === '/dashboard';
  const header = override ?? defaultHeaderFor(currentTab, authUser.role === 'master-admin', t);

  const goToTab = (tab: NavigationTab) => {
    onSidebarNavigate?.();
    if (tab === 'admin') {
      // Always the first tab of the bar this person may open, never the last one visited.
      navigate(`/admin/${firstAllowedAdminSubTab(authUser) ?? firstAdminSubTab(authUser.role === 'client')}`);
    } else if (ADMIN_PROMOTED_SUBTABS.includes(tab)) {
      navigate(`/admin/${tab}`);
    } else {
      navigate(`/${tab}`);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F4F7FB] dark:bg-slate-950 font-sans text-slate-800 dark:text-slate-100 transition-colors selection:bg-[#0B7285] selection:text-white">
      {isDesktop ? (
        <Sidebar
          currentTab={currentTab}
          role={authUser.role}
          clientName={authUser.clientName}
          allowedTabs={authUser.allowedTabs}
          isSuperAdmin={authUser.isSuperAdmin}
          canOpen={(tab) => canOpenTab(authUser, tab)}
          onSelectTab={goToTab}
          isCollapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      ) : navOpen && (
        <div id="nav-drawer" className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={t('sidebar.closeMenu')}
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-xs cursor-default"
          />
          <div className="relative h-full shadow-2xl animate-in slide-in-from-left duration-150">
            <Sidebar
              currentTab={currentTab}
              role={authUser.role}
              clientName={authUser.clientName}
              allowedTabs={authUser.allowedTabs}
              isSuperAdmin={authUser.isSuperAdmin}
              canOpen={(tab) => canOpenTab(authUser, tab)}
              onSelectTab={(tab) => { setNavOpen(false); goToTab(tab); }}
              isCollapsed={false}
              onToggleCollapsed={() => setNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#F4F7FB] dark:bg-slate-950">
        <Header
          title={header.title}
          subtitle={header.subtitle}
          breadcrumb={header.breadcrumb}
          onBack={header.onBack}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((v) => !v)}
          onLogout={signOut}
          onOpenNav={isDesktop ? undefined : () => setNavOpen(true)}
        />

        {/* pb-28/32 instead of the plain p-3 bottom — the floating AI
            widget (AskAIWidget.tsx, `fixed bottom-5 right-6`) sits on top of
            whatever is at the bottom-right of the viewport regardless of
            scroll, which is exactly where a page's pagination Next/Prev
            controls land. The extra clearance keeps page content from ever
            scrolling in underneath it. Skipped on pages where the widget
            itself is hidden (aiIndicator lit — AI Onboarding's chat, Alert
            Agent) since there's nothing there to clear. */}
        <main ref={mainRef} className={`flex-1 overflow-y-auto p-3 bg-[#F4F7FB] dark:bg-slate-950 ${header.aiIndicator ? '' : 'pb-15 md:pb-20'}`}>
          <div className="max-w-7xl 2xl:max-w-[1440px] 3xl:max-w-[1920px] mx-auto space-y-3">
            {/* A page's own translation file loads the first time it opens; only the
                page waits for it, not the sidebar and header around it. */}
            <Suspense fallback={null}>
              {allowedHere ? <Outlet /> : landing && isLanding
                ? <Navigate to={landing} replace />
                : <NoAccess goTo={landing} />}
            </Suspense>
          </div>
        </main>
      </div>

      {/* Hidden on whatever page currently has the AI indicator lit — same
          pages that used to hide it (AI Onboarding's chat, Alert Agent's
          assistant/workflow), since aiIndicator is true on exactly those. */}
      {!header.aiIndicator && <AskAIWidget />}
    </div>
  );
};
