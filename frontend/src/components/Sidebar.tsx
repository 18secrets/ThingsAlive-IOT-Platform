import React from 'react';
import {
  Home,
  UserCheck,
  Users,
  Settings,
  Network,
  Sparkles,
  UserCog,
  KeyRound,
  Activity,
  AlertTriangle,
  GitBranch,
  ClipboardList,
  Receipt
} from 'lucide-react';
import { NavigationTab, UserRole } from '../types';

interface SidebarProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  role: UserRole;
  clientName?: string;
  /** Client role only — resolved from the signed-in user's RoleDefinition at login. */
  allowedTabs?: NavigationTab[];
  /** Client role only — a Super Admin sees every client page, regardless of allowedTabs. */
  isSuperAdmin?: boolean;
}

// Master Admin's own allowlist. 'users' (Platform Users / Client Users) is
// hidden for now, by request.
const MASTER_ADMIN_VISIBLE = new Set<NavigationTab>(['dashboard', 'admin', 'settings']);

// Never shown under the client role, Super Admin or not — Platform Users is
// a ThingsAlive-staff screen, not a client page at all.
const CLIENT_NEVER_VISIBLE = new Set<NavigationTab>(['users']);

// UI-only pages with no backend permission model yet — `allowedTabs` comes
// from the real GET /me/permissions response (see AuthProvider.tsx), which
// has no notion of these tabs, so no role record will ever grant them. Shown
// to every client user unconditionally until a real endpoint exists to grant
// them properly; move into the normal `allowedTabs` check once it does.
const CLIENT_ALWAYS_VISIBLE = new Set<NavigationTab>(['alerts', 'scenarios', 'work-orders', 'cost-administration']);

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, role, clientName, allowedTabs, isSuperAdmin }) => {
  const allNavItems: { id: NavigationTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'ai-onboarding', label: 'AI Onboarding', icon: Sparkles },
    // 'alert-agent' is deliberately not in this list — it stays reachable by
    // direct link (Alerts' "Create alert" / "Edit, assign" buttons navigate
    // to it) but no longer has its own sidebar entry.
    { id: 'alerts', label: 'Alerts', icon: AlertTriangle },
    { id: 'predictions', label: 'Live Predictions', icon: Activity },
    { id: 'scenarios', label: 'Scenarios', icon: GitBranch },
    { id: 'work-orders', label: 'Work Orders', icon: ClipboardList },
    { id: 'cost-administration', label: 'Cost Administration', icon: Receipt },
    { id: 'admin', label: 'Administration', icon: UserCheck },
    { id: 'client-users', label: 'Client Users', icon: UserCog },
    { id: 'roles', label: 'Roles & Permissions', icon: KeyRound },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const allowed = allowedTabs || [];
  const navItems = allNavItems.filter((item) => {
    if (role === 'master-admin') return MASTER_ADMIN_VISIBLE.has(item.id);
    if (CLIENT_NEVER_VISIBLE.has(item.id)) return false;
    // A Super Admin gets every client page unconditionally. allowedTabs comes
    // from the real backend (AuthProvider.tsx) and has no notion of the
    // UI-only tabs in CLIENT_ALWAYS_VISIBLE, so "Super Admin sees everything"
    // can't be left to depend on whatever that happens to return.
    if (isSuperAdmin) return true;
    return CLIENT_ALWAYS_VISIBLE.has(item.id) || allowed.includes(item.id);
  });

  return (
    <aside 
      id="main-navigation-sidebar"
      className="w-60 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between shrink-0 select-none z-20 transition-colors"
      data-purpose="main-navigation-sidebar"
    >
      <div>
        {/* ThingsAlive Logo Header matching screenshot */}
        <div className={`flex items-center px-5 gap-2.5 border-b border-slate-100 dark:border-slate-800 ${clientName ? 'py-3' : 'h-16'}`}>
          <div className="relative flex items-center justify-center w-8 h-8 text-[#00A4BD] shrink-0">
            <Network className="w-7 h-7 stroke-[2.2]" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100 leading-tight">
              Things<span className="font-normal text-slate-700 dark:text-slate-200">Alive</span>
            </span>
            {clientName && (
              <span className="text-[15px] font-semibold text-sky-600 dark:text-sky-400 truncate" title={clientName}>
                {clientName}
              </span>
            )}
          </div>
        </div>

        {/* Navigation Links matching screenshot */}
        <nav className="p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                id={`nav-${item.id}`}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2 text-sm rounded-lg font-medium transition-all text-left cursor-pointer ${
                  isActive
                    ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon 
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'
                  }`} 
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Version Footer matching screenshot */}
      <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
        <span>Version: 1.0.5</span>
      </div>
    </aside>
  );
};

