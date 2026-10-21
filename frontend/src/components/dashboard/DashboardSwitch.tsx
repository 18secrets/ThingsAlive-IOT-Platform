import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Side-by-side trial of the two client dashboards: the original command center (mock
 * fleet data) and the live one built on the backend. One of them is to be removed once
 * they have been compared; this switch goes with it.
 */
export const DashboardSwitch: React.FC<{ current: 'classic' | 'live' }> = ({ current }) => {
  const navigate = useNavigate();
  const { t } = useTranslation('dashboard');
  const item = (id: 'classic' | 'live', label: string, to: string) => (
    <button
      onClick={() => navigate(to)}
      className={`px-3 py-1.5 text-xs font-semibold cursor-pointer ${current === id ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-[11px] text-slate-400">{t('switch.label')}</span>
      <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900">
        {item('classic', t('switch.classic'), '/dashboard')}
        {item('live', t('switch.live'), '/dashboard-live')}
      </div>
    </div>
  );
};
