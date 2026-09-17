import React, { useState } from 'react';
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

function tabFromPath(pathname: string): NavigationTab {
  const first = pathname.split('/')[1];
  const known: NavigationTab[] = [
    'dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'client-users', 'roles', 'users', 'settings',
  ];
  return (known as string[]).includes(first) ? (first as NavigationTab) : 'dashboard';
}

/** Static per-route title/subtitle — a page overrides this via usePageHeader
 *  when it has more than one internal view (AI Onboarding, Alert Agent). */
function defaultHeaderFor(tab: NavigationTab, isMasterAdmin: boolean): PageHeaderConfig {
  switch (tab) {
    case 'admin': return { title: 'Administration', subtitle: 'Master Configuration' };
    case 'ai-onboarding': return { title: 'AI Onboarding', subtitle: 'Guided Setup Sessions' };
    case 'alert-agent': return { title: 'Alert Agent', subtitle: 'Automated Dispatch' };
    case 'users': return { title: 'User Management', subtitle: 'Access & Permissions' };
    case 'client-users': return { title: 'Client Users', subtitle: 'People & Access' };
    case 'roles': return { title: 'Roles & Permissions', subtitle: 'Page Access Control' };
    case 'settings': return { title: 'Settings', subtitle: 'System Parameters' };
    case 'dashboard':
    default:
      return { title: 'Dashboard', subtitle: isMasterAdmin ? 'Platform Overview' : 'Fleet Telematics' };
  }
}

export const Shell: React.FC<ShellProps> = ({ onSidebarNavigate }) => {
  const { authUser, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isDarkMode, setIsDarkMode] = useState(false);
  const override = usePageHeaderValue();

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  if (!authUser) return null; // RequireAuth guarantees this never renders signed out.

  const currentTab = tabFromPath(location.pathname);
  const header = override ?? defaultHeaderFor(currentTab, authUser.role === 'master-admin');

  const goToTab = (tab: NavigationTab) => {
    onSidebarNavigate?.();
    if (tab === 'admin') {
      navigate(`/admin/${authUser.role === 'client' ? 'plant' : 'industry'}`);
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

        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#F4F7FB] dark:bg-slate-950">
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
