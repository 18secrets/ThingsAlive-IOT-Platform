import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertEvent, apiListAlerts } from '../lib/api';
import { useTranslation } from 'react-i18next';
import { LanguageSelector } from './common/LanguageSelector';
import {
  Bell,
  Sun,
  Moon,
  LogOut,
  ArrowLeft,
  Menu,
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
  onLogout?: () => void;
  /** Below lg the sidebar is a drawer; this opens it. Absent on desktop. */
  onOpenNav?: () => void;
}

const VIEWER_ZONE = (() => {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const short = new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value ?? name;
  return { name, short };
})();

export const Header: React.FC<HeaderProps> = ({
  title,
  breadcrumb,
  onBack,
  isDarkMode,
  onToggleDarkMode,
  onLogout,
  onOpenNav,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [showNotifications, setShowNotifications] = useState(false);
  // The account's own open alerts, newest first. This was three fixed placeholders
  // ("Dust Collector", "Device #131", "Excavator 14") that matched no fleet (test report
  // MIN-10). A role that cannot read alerts gets null and the panel says so.
  const [notificationList, setNotificationList] = useState<AlertEvent[] | null | undefined>(undefined);
  const location = useLocation();
  // The panel stayed open on the next page until the bell was pressed again (MIN-11).
  useEffect(() => { setShowNotifications(false); }, [location.pathname]);
  useEffect(() => {
    if (!showNotifications) return;
    let live = true;
    apiListAlerts({ state: ['open'] })
      .then((list) => { if (live) setNotificationList([...list].sort((a, b) => b.firedAt.localeCompare(a.firedAt)).slice(0, 8)); })
      .catch(() => { if (live) setNotificationList(null); });
    return () => { live = false; };
  }, [showNotifications]);

  return (
    <header 
      id="top-navigation-header"
      className="h-16 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 sm:px-6 flex items-center justify-between gap-2 z-10 shrink-0 transition-colors"
      data-purpose="top-navigation-header"
    >
      {/* Title & Navigation Hierarchy */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {onOpenNav && (
          <button
            id="open-nav-btn"
            onClick={onOpenNav}
            className="p-1.5 -ml-1 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer shrink-0"
            title={t('sidebar.openMenu')}
            aria-label={t('sidebar.openMenu')}
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        {onBack && (
          <button
            id="header-back-btn"
            onClick={onBack}
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
            title={t('header.goBack')}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}

        <div className="flex items-center gap-2 min-w-0">
          {breadcrumb && (
            <>
              <span className="hidden sm:inline text-xs text-slate-500 dark:text-slate-400 shrink-0">{breadcrumb}</span>
              <span className="hidden sm:inline text-slate-400">/</span>
            </>
          )}
          <h1 className="text-base sm:text-xl font-semibold text-slate-800 dark:text-slate-100 tracking-tight truncate">
            {title}
          </h1>
        </div>
      </div>

      {/* Header Action Icons matching screenshot */}
      <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
        {/* Every time on screen is formatted in the viewer's own zone, and nothing said
            which (test report MIN-12) — the fleet is in India, a viewer may not be. */}
        <span className="hidden md:inline text-[11px] text-slate-400 whitespace-nowrap" title={t('header.timeZoneTitle', { zone: VIEWER_ZONE.name })}>
          {t('header.timeZone', { zone: VIEWER_ZONE.short })}
        </span>
        {/* Notification Bell */}
        <div className="relative">
          <button 
            id="notifications-toggle"
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
            title={t('header.notifications')}
          >
            <Bell className="w-4 h-4" />
          </button>

          {showNotifications && (
            <div className="fixed sm:absolute right-3 sm:right-0 top-16 sm:top-auto sm:mt-2 w-[calc(100vw-1.5rem)] sm:w-80 bg-white dark:bg-slate-900 shadow-xl border border-slate-200 dark:border-slate-800 rounded-lg py-2 z-50 animate-in fade-in">
              <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <span className="font-semibold text-xs text-slate-800 dark:text-slate-100">{t('header.telemetryNotifications')}</span>
                {Array.isArray(notificationList) && notificationList.length > 0 && (
                  <span className="text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300 px-2 py-0.5 rounded-full font-bold">{t('header.newCount', { count: notificationList.length })}</span>
                )}
              </div>
              <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {notificationList === undefined ? (
                  <p className="p-3 text-slate-400">{t('header.loadingNotifications')}</p>
                ) : notificationList === null || notificationList.length === 0 ? (
                  <p className="p-3 text-slate-400">{t('header.noNotifications')}</p>
                ) : notificationList.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(`/dashboard/${encodeURIComponent(item.sourceSystem)}/${encodeURIComponent(item.externalId)}`)}
                    className="w-full text-left p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer bg-sky-50/50 dark:bg-sky-950/20"
                  >
                    <div className="font-medium text-slate-800 dark:text-slate-200">{item.summary}</div>
                    <div className="text-[10px] text-slate-400 mt-1">{item.externalId} · {item.ruleName} · {new Date(item.firedAt).toLocaleString()}</div>
                  </button>
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
            title={t('header.lightMode')}
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
            title={t('header.darkMode')}
          >
            <Moon className="w-3.5 h-3.5" />
          </button>
        </div>

        <LanguageSelector />

        {/* User Profile / Exit matching screenshot */}
        <div className="flex items-center gap-2">
          {/* No profile page exists; Settings is where a signed-in person changes their
              own password, which is what the avatar is expected to lead to. */}
          <button
            id="profile-btn"
            onClick={() => navigate('/settings')}
            className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center justify-center hover:border-sky-400 transition-colors cursor-pointer"
            title={t('header.profile')}
          >
            <User className="w-3.5 h-3.5" />
          </button>
          <button
            id="logout-btn"
            onClick={onLogout}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
            title={t('header.signOut')}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};

