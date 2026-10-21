import React, { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';

const DAYS = ['17 Sep', '18 Sep', '19 Sep', '20 Sep', '21 Sep', '22 Sep', '23 Sep'];

// Labels are dashboard-namespace keys, resolved at render so a language change re-labels the chart.
const TAB_CONFIG = {
  hours: { primaryLabel: 'trend.uptime', secondaryLabel: 'trend.downtime', primaryColor: '#0ea5e9', secondaryColor: '#fbbf24' },
  fuel: { primaryLabel: 'trend.fuelUsed', secondaryLabel: 'trend.idle', primaryColor: '#0ea5e9', secondaryColor: '#fbbf24' },
} as const;

// Deterministic placeholder trend — no telemetry simulation in this app, so
// this is a stable per-day shape rather than a real weekly series. The two
// series are complementary shares of the same 100% (uptime+downtime,
// fuel-used+idle) so a stacked bar always reaches the same total height.
function seriesFor(kind: 'hours' | 'fuel', count: number) {
  return DAYS.map((day, i) => {
    const base = kind === 'hours' ? 70 : 55;
    const primary = Math.round(Math.max(10, Math.min(95, base + Math.sin(i + count) * 18)) * 10) / 10;
    return { day, primary, secondary: Math.round((100 - primary) * 10) / 10 };
  });
}

export const PerformanceTrend: React.FC<{ thingsCount: number }> = ({ thingsCount }) => {
  const { t } = useTranslation('dashboard');
  const [tab, setTab] = useState<'hours' | 'fuel'>('hours');
  const data = useMemo(() => seriesFor(tab, thingsCount), [tab, thingsCount]);
  const config = TAB_CONFIG[tab];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('trend.title')}</h3>
        <div className="flex gap-1">
          <button onClick={() => setTab('hours')} className={`px-2.5 py-1 text-xs font-medium rounded-md ${tab === 'hours' ? 'bg-sky-600 text-white' : 'text-slate-500 dark:text-slate-400'}`}>{t('trend.tabHours')}</button>
          <button onClick={() => setTab('fuel')} className={`px-2.5 py-1 text-xs font-medium rounded-md ${tab === 'fuel' ? 'bg-sky-600 text-white' : 'text-slate-500 dark:text-slate-400'}`}>{t('trend.tabFuel')}</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-800" />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value, name) => [`${value}%`, name]} />
          <Legend verticalAlign="bottom" align="center" height={32} wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
          <Bar dataKey="primary" name={t(config.primaryLabel)} stackId="share" fill={config.primaryColor} radius={[4, 4, 0, 0]} />
          <Bar dataKey="secondary" name={t(config.secondaryLabel)} stackId="share" fill={config.secondaryColor} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
