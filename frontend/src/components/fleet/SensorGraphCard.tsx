import React from 'react';
import { SensorSeries } from '../../data/fleetMockData';

function Sparkline({ values, min, max }: { values: number[]; min: number; max: number }) {
  const low = Math.min(min, ...values);
  const high = Math.max(max, ...values);
  const points = values.map((v, i) => `${8 + (i * 284) / Math.max(1, values.length - 1)},${90 - ((v - low) / (high - low || 1)) * 70}`).join(' ');
  const lastX = 8 + 284;
  const lastY = 90 - ((values.at(-1)! - low) / (high - low || 1)) * 70;
  return (
    <svg viewBox="0 0 300 100" className="w-full h-20" role="img" aria-label="Recent sensor readings">
      <polyline points={points} fill="none" stroke="#0ea5e9" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="3.5" fill="#0369a1" />
    </svg>
  );
}

export const SensorGraphCard: React.FC<{ sensor: SensorSeries; breachLine?: number }> = ({ sensor }) => {
  const first = sensor.history[0];
  const delta = sensor.current - first;
  const breach = sensor.key === 'coolant_temperature' && sensor.current > sensor.max;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{sensor.label}</h4>
      <div className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">{sensor.current.toFixed(2)} <span className="text-[13px] font-normal text-slate-400">{sensor.unit}</span></div>
      <Sparkline values={sensor.history} min={sensor.min} max={sensor.max} />
      <p className={`text-[11px] font-medium ${breach ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
        {breach ? `Alert: outside the demonstration limit (0–${sensor.max} ${sensor.unit})` : 'Review: no validated operating limit'}
      </p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500">
        {Math.abs(delta).toFixed(2)} {sensor.unit} {delta >= 0 ? 'higher' : 'lower'} than the first sample · Range {Math.min(...sensor.history).toFixed(2)}–{Math.max(...sensor.history).toFixed(2)} {sensor.unit} · {sensor.history.length} recorded samples.
      </p>
    </div>
  );
};
