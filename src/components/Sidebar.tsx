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
  Sparkles
} from 'lucide-react';
import { NavigationTab } from '../types';

interface SidebarProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab }) => {
  const navItems: { id: NavigationTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: Home },
    { id: 'ai-onboarding', label: 'AI Onboarding', icon: Sparkles },
    { id: 'alert-rules', label: 'Alert Rules', icon: AlertTriangle },
    { id: 'alert-agent', label: 'Alert Agent', icon: Bell },
    { id: 'admin', label: 'Admin', icon: UserCheck },
    { id: 'vendors', label: 'Vendors', icon: Globe },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'administrator', label: 'Administrator', icon: ShieldCheck },
    { id: 'diagnostics', label: 'Diagnostics', icon: ClipboardList },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside 
      id="main-navigation-sidebar"
      className="w-60 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between shrink-0 select-none z-20 transition-colors"
      data-purpose="main-navigation-sidebar"
    >
      <div>
        {/* ThingsAlive Logo Header matching screenshot */}
        <div className="h-16 flex items-center px-5 gap-2.5 border-b border-slate-100 dark:border-slate-800">
          <div className="relative flex items-center justify-center w-8 h-8 text-[#00A4BD]">
            <Network className="w-7 h-7 stroke-[2.2]" />
          </div>
          <div className="flex items-center">
            <span className="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100">
              Things<span className="font-normal text-slate-700 dark:text-slate-200">Alive</span>
            </span>
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

