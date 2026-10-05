import React, { useState } from 'react';

const DAYS = ['17 Sep', '18 Sep', '19 Sep', '20 Sep', '21 Sep', '22 Sep', '23 Sep'];
const CHART_HEIGHT = 112;

// Deterministic placeholder trend — no telemetry simulation in this app, so
// this is a stable per-day shape rather than a real weekly series.
function seriesFor(kind: 'hours' | 'fuel', count: number) {
  return DAYS.map((_, i) => {
    const base = kind === 'hours' ? 70 : 55;
    return Math.max(10, Math.min(95, base + Math.sin(i + count) * 18));
  });
}

export const PerformanceTrend: React.FC<{ thingsCount: number }> = ({ thingsCount }) => {
  const [tab, setTab] = useState<'hours' | 'fuel'>('hours');
  const series = seriesFor(tab, thingsCount);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Performance trends</h3>
        <div className="flex gap-1">
          <button onClick={() => setTab('hours')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md ${tab === 'hours' ? 'bg-sky-600 text-white' : 'text-slate-500 dark:text-slate-400'}`}>Uptime &amp; downtime</button>
          <button onClick={() => setTab('fuel')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md ${tab === 'fuel' ? 'bg-sky-600 text-white' : 'text-slate-500 dark:text-slate-400'}`}>Fuel &amp; idling</button>
        </div>
      </div>
      <div className="flex items-end gap-3" style={{ height: CHART_HEIGHT + 22 }}>
        {series.map((v, i) => {
          const barHeight = Math.round((v / 100) * CHART_HEIGHT);
          return (
            <div key={DAYS[i]} className="flex-1 flex flex-col items-center justify-end gap-1.5" style={{ height: CHART_HEIGHT + 22 }}>
              <div className="w-full rounded-t bg-sky-200 dark:bg-sky-900 relative" style={{ height: barHeight }}>
                <div className="absolute inset-x-0 bottom-0 rounded-t bg-sky-500" style={{ height: Math.round(barHeight * 0.55) }} />
              </div>
              <span className="text-[10px] text-slate-400">{DAYS[i]}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
        Trends cover sample-source Things for 17–23 September. Imported history is shown on each Thing&apos;s detail page.
      </p>
    </div>
  );
};
