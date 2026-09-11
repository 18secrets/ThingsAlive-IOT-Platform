import React from 'react';
import {
  Home,
  AlertTriangle,
  Bell,
  UserCheck,
  Globe,
  Users,
  ShieldCheck,
  ClipboardList,
  Settings,
  Network,
  Sparkles,
  LayoutDashboard,
  Cog,
  LineChart,
  ClipboardCheck,
  Fuel,
  Gauge,
  MapPinned,
  Radio,
  FileBarChart,
} from 'lucide-react';
import { NavigationTab } from '../types';

interface SidebarProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
}

interface NavItem {
  id: NavigationTab;
  label: string;
  icon: React.FC<{ className?: string }>;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: Home },
      // { id: 'ai-onboarding', label: 'AI Onboarding', icon: Sparkles },
      // { id: 'alert-rules', label: 'Alert Rules', icon: AlertTriangle },
      // { id: 'alert-agent', label: 'Alert Agent', icon: Bell },
      // { id: 'admin', label: 'Admin', icon: UserCheck },
    ],
  },
  {
    title: 'Predictive Maintenance',
    items: [
      { id: 'pm-overview', label: 'Overview', icon: LayoutDashboard },
      { id: 'pm-machine-details', label: 'Machine Details', icon: Cog },
      { id: 'pm-trends', label: 'Predictive Trends', icon: LineChart },
      { id: 'pm-action-center', label: 'Action Center', icon: ClipboardCheck },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      { id: 'mon-fuel-theft', label: 'Fuel Theft Detection', icon: Fuel },
      { id: 'mon-utilization', label: 'Utilization Reporting', icon: Gauge },
      { id: 'mon-geofencing', label: 'Geofencing', icon: MapPinned },
      { id: 'mon-device-health', label: 'Device Health', icon: Radio },
    ],
  },
  {
    title: 'Reports',
    items: [
      { id: 'reports', label: 'Reports', icon: FileBarChart },
    ],
  },
  {
    title: 'Organization',
    items: [
      { id: 'vendors', label: 'Vendors', icon: Globe },
      { id: 'users', label: 'Users', icon: Users },
      { id: 'administrator', label: 'Administrator', icon: ShieldCheck },
      { id: 'diagnostics', label: 'Diagnostics', icon: ClipboardList },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  return (
    <aside
      id="main-navigation-sidebar"
      className="w-60 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between shrink-0 select-none z-20 transition-colors overflow-hidden"
      data-purpose="main-navigation-sidebar"
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* ThingsAlive Logo Header matching screenshot */}
        <div className="h-16 flex items-center px-5 gap-2.5 border-b border-slate-100 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <div className="relative flex items-center justify-center w-8 h-8 text-[#00A4BD]">
            <Network className="w-7 h-7 stroke-[2.2]" />
          </div>
          <div className="flex items-center">
            <span className="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100">
              Things<span className="font-normal text-slate-700 dark:text-slate-200">Alive</span>
            </span>
          </div>
        </div>

        {/* Navigation Links, grouped into sections */}
        <nav className="p-3 space-y-4">
          {NAV_SECTIONS.map((section, sIdx) => (
            <div key={section.title ?? `section-${sIdx}`}>
              {section.title && (
                <div className="px-3.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {section.title}
                </div>
              )}
              <div className="space-y-1">
                {section.items.map((item) => {
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
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* Version Footer matching screenshot */}
      <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
        <span>Version: 1.0.5</span>
      </div>
    </aside>
  );
};
