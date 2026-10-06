import React, { useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NavigationTab } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { PageHeaderConfig, usePageHeaderValue } from '../lib/PageHeaderContext';
import { Sidebar } from '../components/Sidebar';
import { Header } from '../components/Header';
import { AskAIWidget } from '../components/AskAIWidget';

interface ShellProps {
  /** Clears any cross-page drill-down state (Master Admin's "Manage Access"
   *  pick) whenever navigation happens via the sidebar itself, matching how
   *  the pre-router App.tsx reset it on every tab switch. */
  onSidebarNavigate?: () => void;
}

function tabFromPath(pathname: string, state: unknown): NavigationTab {
  const first = pathname.split('/')[1];
  // Reached from Alerts/Predictions/Scenarios/a Thing detail page's "Create
  // alert with AI" button — see AlertAgentPage.tsx's nav state. It has no
  // sidebar entry of its own, so highlight whichever tab this flow started
  // from. (The alert/scenario/prediction rule form itself is a modal now,
  // not a route, so it never changes the URL and needs no entry here.)
  const backTo = (state as { backTo?: string } | null)?.backTo;
  if (first === 'alert-agent' && backTo) return tabFromPath(backTo, null);
  const known: NavigationTab[] = [
    'dashboard', 'things-care', 'things-shield', 'incident-management', 'production-monitoring', 'ai-onboarding', 'alert-agent', 'alerts', 'predictions', 'scenarios', 'work-orders', 'cost-administration',
    'admin', 'client-users', 'roles', 'users', 'settings',
  ];
  return (known as string[]).includes(first) ? (first as NavigationTab) : 'dashboard';
}

/** Static per-route title/subtitle — a page overrides this via usePageHeader
 *  when it has more than one internal view (AI Onboarding, Alert Agent). */
function defaultHeaderFor(tab: NavigationTab, isMasterAdmin: boolean): PageHeaderConfig {
  switch (tab) {
    case 'admin': return { title: 'Administration', subtitle: 'Master Configuration' };
    case 'things-care': return { title: 'ThingsCare', subtitle: 'Health & Prognostics' };
    case 'things-shield': return { title: 'ThingsShield', subtitle: 'Safety, Compliance & Risk' };
    case 'incident-management': return { title: 'Incident Management', subtitle: 'People, Machine Wellbeing & Security' };
    case 'production-monitoring': return { title: 'Production Monitoring', subtitle: 'Output & Performance' };
    case 'ai-onboarding': return { title: 'AI Onboarding', subtitle: 'Guided Setup Sessions' };
    case 'alert-agent': return { title: 'Alert Agent', subtitle: 'Automated Dispatch' };
    case 'alerts': return { title: 'Alerts', subtitle: 'Fleet Attention Feed' };
    case 'predictions': return { title: 'Live Predictions', subtitle: 'Automated Dispatch' };
    case 'scenarios': return { title: 'Scenarios', subtitle: 'Monitoring Workflows' };
    case 'work-orders': return { title: 'Work Orders', subtitle: 'Maintenance Tasks' };
    case 'cost-administration': return { title: 'Cost Administration', subtitle: 'Fuel & Maintenance Rates' };
    case 'users': return { title: 'User Management', subtitle: 'Access & Permissions' };
    case 'client-users': return { title: 'Client Users', subtitle: 'People & Access' };
    case 'roles': return { title: 'Roles & Permissions', subtitle: 'Page Access Control' };
    case 'settings': return { title: 'Settings', subtitle: 'System Parameters' };
    case 'dashboard':
    default:
      return { title: 'Dashboard', subtitle: isMasterAdmin ? 'Platform Overview' : 'Fleet Telematics' };
  }
}

const THEME_KEY = 'ta_theme';

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

export const Shell: React.FC<ShellProps> = ({ onSidebarNavigate }) => {
  const { authUser, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isDarkMode, setIsDarkMode] = useState(initialDarkMode);
  const override = usePageHeaderValue();
  const mainRef = useRef<HTMLElement>(null);

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    try {
      localStorage.setItem(THEME_KEY, isDarkMode ? 'dark' : 'light');
    } catch {
      // Nothing to do if storage is unavailable — the toggle still works for this session.
    }
  }, [isDarkMode]);

  // <Outlet/> only swaps the page content, not the scrollable <main> itself,
  // so without this a new page inherits whatever scroll position the last
  // one was left at instead of opening at the top. Keyed on location.key
  // (unique per navigate() call) rather than pathname, so it also resets for
  // same-path navigations with new state — e.g. Alert Agent's view switcher.
  React.useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [location.key]);

  if (!authUser) return null; // RequireAuth guarantees this never renders signed out.

  const currentTab = tabFromPath(location.pathname, location.state);
  const header = override ?? defaultHeaderFor(currentTab, authUser.role === 'master-admin');

  const goToTab = (tab: NavigationTab) => {
    onSidebarNavigate?.();
    if (tab === 'admin') {
      // 'industry' is hidden from Master Admin's tab bar for now — see
      // AdminIndexRedirect's own comment in App.tsx, which this must match.
      navigate(`/admin/${authUser.role === 'client' ? 'plant' : 'clients'}`);
    } else {
      navigate(`/${tab}`);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F4F7FB] dark:bg-slate-950 font-sans text-slate-800 dark:text-slate-100 transition-colors selection:bg-[#0B7285] selection:text-white">
      <Sidebar
        currentTab={currentTab}
        role={authUser.role}
        clientName={authUser.clientName}
        allowedTabs={authUser.allowedTabs}
        isSuperAdmin={authUser.isSuperAdmin}
        onSelectTab={goToTab}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#F4F7FB] dark:bg-slate-950">
        <Header
          title={header.title}
          subtitle={header.subtitle}
          breadcrumb={header.breadcrumb}
          onBack={header.onBack}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((v) => !v)}
          aiIndicator={header.aiIndicator}
          onLogout={signOut}
        />

        <main ref={mainRef} className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#F4F7FB] dark:bg-slate-950">
          <div className="max-w-7xl mx-auto space-y-6">
            <Outlet />
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
