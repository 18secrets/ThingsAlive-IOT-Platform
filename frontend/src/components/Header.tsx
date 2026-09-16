import React, { useState } from 'react';
import {
  Bell,
  Sun,
  Moon,
  Globe,
  ChevronDown,
  LogOut,
  ArrowLeft,
  Check,
  User,
  Sparkles
} from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  breadcrumb?: string;
  onBack?: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  aiIndicator?: boolean;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  breadcrumb,
  onBack,
  isDarkMode,
  onToggleDarkMode,
  aiIndicator,
  onLogout,
}) => {
  const [showNotifications, setShowNotifications] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [currentLang, setCurrentLang] = useState('EN');
  const [notificationList] = useState([
    { id: 1, title: 'Dust Collector Delta-P Normal', time: '10m ago', unread: true },
    { id: 2, title: 'Device #131 Heartbeat Missing', time: '4h ago', unread: true },
    { id: 3, title: 'Excavator 14 Scheduled Maintenance', time: '1d ago', unread: false }
  ]);

  return (
    <header 
      id="top-navigation-header"
      className="h-16 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 flex items-center justify-between z-10 shrink-0 transition-colors"
      data-purpose="top-navigation-header"
    >
      {/* Title & Navigation Hierarchy */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            id="header-back-btn"
            onClick={onBack}
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            title="Go Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}

        <div className="flex items-center gap-2">
          {breadcrumb && (
            <>
              <span className="text-xs text-slate-500 dark:text-slate-400">{breadcrumb}</span>
              <span className="text-slate-400">/</span>
            </>
          )}
          <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100 tracking-tight">
            {title}
          </h1>
        </div>
      </div>

      {/* Header Action Icons matching screenshot */}
      <div className="flex items-center gap-4">
        {/* Notification Bell */}
        <div className="relative">
          <button 
            id="notifications-toggle"
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
            title="Notifications"
          >
            <Bell className="w-4 h-4" />
          </button>

          {showNotifications && (
            <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-slate-900 shadow-xl border border-slate-200 dark:border-slate-800 rounded-lg py-2 z-50 animate-in fade-in">
              <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <span className="font-semibold text-xs text-slate-800 dark:text-slate-100">Telemetry Notifications</span>
                <span className="text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300 px-2 py-0.5 rounded-full font-bold">3 New</span>
              </div>
              <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {notificationList.map((item) => (
                  <div key={item.id} className={`p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer ${item.unread ? 'bg-sky-50/50 dark:bg-sky-950/20' : ''}`}>
                    <div className="font-medium text-slate-800 dark:text-slate-200">{item.title}</div>
                    <div className="text-[10px] text-slate-400 mt-1">{item.time}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Theme Toggle (matching the blue circle for Sun in screenshot) */}
        <div className="flex items-center gap-1.5">
          <button 
            id="theme-toggle-light"
            onClick={() => isDarkMode && onToggleDarkMode()}
            className={`p-1.5 rounded-full transition-all cursor-pointer ${
              !isDarkMode 
                ? 'bg-sky-600 text-white shadow-xs' 
                : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
            }`} 
            title="Light Mode"
          >
            <Sun className="w-3.5 h-3.5" />
          </button>
          <button 
            id="theme-toggle-dark"
            onClick={() => !isDarkMode && onToggleDarkMode()}
            className={`p-1.5 rounded-full transition-all cursor-pointer ${
              isDarkMode 
                ? 'bg-sky-600 text-white shadow-xs' 
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400'
            }`} 
            title="Dark Mode"
          >
            <Moon className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* AI Assistant Indicator (shown on AI-driven pages) */}
        {aiIndicator && (
          <div
            className="p-1.5 rounded-full bg-sky-600 text-white shadow-xs"
            title="AI Assistant Active"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </div>
        )}

        {/* Language Selector matching "EN ⌵" in screenshot */}
        <div className="relative">
          <button
            id="lang-selector-btn"
            onClick={() => setShowLangMenu(!showLangMenu)}
            className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
          >
            <Globe className="w-4 h-4 text-slate-500" />
            <span className="font-medium">{currentLang}</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {showLangMenu && (
            <div className="absolute right-0 mt-2 w-28 bg-white dark:bg-slate-900 shadow-lg border border-slate-200 dark:border-slate-800 rounded-md py-1 text-xs z-50">
              {['EN', 'DE', 'ES', 'FR', 'HI'].map((lang) => (
                <button
                  key={lang}
                  onClick={() => {
                    setCurrentLang(lang);
                    setShowLangMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
                >
                  <span>{lang}</span>
                  {currentLang === lang && <Check className="w-3.5 h-3.5 text-sky-600" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* User Profile / Exit matching screenshot */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
            <User className="w-3.5 h-3.5" />
          </div>
          <button
            id="logout-btn"
            onClick={onLogout}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};

