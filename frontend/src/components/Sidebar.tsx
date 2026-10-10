import React from 'react';
import {
  Home,
  UserCheck,
  Users,
  Settings,
  Sparkles,
  UserCog,
  KeyRound,
  Activity,
  AlertTriangle,
  GitBranch,
  ClipboardList,
  Receipt,
  HeartPulse,
  ShieldCheck,
  Siren,
  Factory,
  Briefcase,
  Cpu,
  Wrench
} from 'lucide-react';
import { NavigationTab, UserRole } from '../types';
import logoFull from '../../assets/logo-icon.png';
import logoStacked from '../../assets/logo.png';

interface SidebarProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  role: UserRole;
  clientName?: string;
  /** Client role only — resolved from the signed-in user's RoleDefinition at login. */
  allowedTabs?: NavigationTab[];
  /** Client role only — a Super Admin sees every client page, regardless of allowedTabs. */
  isSuperAdmin?: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

// Master Admin's own allowlist. 'users' (Platform Users / Client Users) is
// hidden for now, by request. 'clients'/'staff'/'devices'/'equipment' used to
// be sub-tabs inside Administration — promoted to their own sidebar entries
// 2026-10-10 because the Administration sub-tab bar had grown too crowded.
const MASTER_ADMIN_VISIBLE = new Set<NavigationTab>([
  'dashboard', 'admin', 'clients', 'staff', 'devices', 'equipment', 'settings',
]);

// Never shown under the client role, Super Admin or not — Platform Users is
// a ThingsAlive-staff screen, not a client page at all, and the promoted
// Clients/Staff/Devices/Equipment pages are Master Admin's own screens (a
// client's own Devices/Equipment stay inside their Administration sub-tabs,
// reached via 'admin', not these).
const CLIENT_NEVER_VISIBLE = new Set<NavigationTab>(['users', 'clients', 'staff', 'devices', 'equipment']);

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab, onSelectTab, role, clientName, allowedTabs, isSuperAdmin, isCollapsed, onToggleCollapsed,
}) => {
  const allNavItems: { id: NavigationTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'things-care', label: 'ThingsCare', icon: HeartPulse },
    { id: 'things-shield', label: 'ThingsShield', icon: ShieldCheck },
    { id: 'incident-management', label: 'Incident Management', icon: Siren },
    { id: 'production-monitoring', label: 'Production Monitoring', icon: Factory },
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
    { id: 'clients', label: 'Clients', icon: Briefcase },
    { id: 'staff', label: 'Staff', icon: ShieldCheck },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'equipment', label: 'Equipment', icon: Wrench },
    { id: 'client-users', label: 'Client Users', icon: UserCog },
    { id: 'roles', label: 'Roles & Permissions', icon: KeyRound },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const allowed = allowedTabs || [];
  const navItems = allNavItems.filter((item) => {
    if (role === 'master-admin') return MASTER_ADMIN_VISIBLE.has(item.id);
    if (CLIENT_NEVER_VISIBLE.has(item.id)) return false;
    // A Super Admin gets every client page unconditionally, regardless of
    // what allowedTabs (from the real backend) happens to list.
    if (isSuperAdmin) return true;
    return allowed.includes(item.id);
  });

  return (
    <aside
      id="main-navigation-sidebar"
      className={`${isCollapsed ? 'w-[76px]' : 'w-60'} bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shrink-0 select-none z-20 transition-[width] duration-200`}
      data-purpose="main-navigation-sidebar"
    >
      <div className="min-w-0 shrink-0 border-b border-slate-100 dark:border-slate-800">
        {/* Logo — click to collapse/expand the sidebar */}
        <div
          role="button"
          tabIndex={0}
          onClick={onToggleCollapsed}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapsed(); }}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`w-full flex flex-col cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors ${
            isCollapsed ? 'items-center py-3' : ''
          }`}
        >
          {isCollapsed ? (
            <img
              src={logoStacked}
              alt="ThingsAlive"
              className="w-[55px] h-[55px] object-contain rounded"
            />
          ) : (
            <img src={logoFull} alt="ThingsAlive" className="h-[55px] w-auto object-contain" />
          )}
        </div>

        {clientName && !isCollapsed && (
          <div className="px-5 -mt-1.5 text-end">
            <span className="text-[15px] font-semibold text-sky-600 dark:text-sky-400 truncate block" title={clientName}>
              {clientName}
            </span>
          </div>
        )}
      </div>

      {/* Navigation Links — scrolls on its own so a long list (client role)
          never pushes the version footer below the viewport; Shell.tsx's
          root `overflow-hidden` would otherwise just clip it instead of
          scrolling. */}
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              id={`nav-${item.id}`}
              onClick={() => onSelectTab(item.id)}
              title={item.label}
              className={`w-full flex items-center text-base rounded-lg font-medium transition-all text-left cursor-pointer ${
                isCollapsed ? 'justify-center px-0 py-3' : 'gap-3.5 px-3.5 py-2.5'
              } ${
                isActive
                  ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Icon
                className={`w-5 h-5 shrink-0 ${
                  isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'
                }`}
              />
              {!isCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Version Footer */}
      {!isCollapsed && (
        <div className="shrink-0 px-5 py-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
          <span>Version: 1.0.5</span>
        </div>
      )}
    </aside>
  );
};
