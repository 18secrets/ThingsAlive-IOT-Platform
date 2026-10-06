import React from 'react';

// A percentage, drawn once instead of read as a sentence — ThingsCare health,
// Production Monitoring OEE. Null renders a dashed "—" ring: no data, not zero.
export const RingGauge: React.FC<{
  value: number | null;
  size?: number;
  strokeWidth?: number;
  colorClass?: string;
}> = ({ value, size = 56, strokeWidth = 5, colorClass = 'text-sky-600 dark:text-sky-400' }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - pct / 100);
  const center = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={center} cy={center} r={radius} strokeWidth={strokeWidth} fill="none" className="text-slate-200 dark:text-slate-700" stroke="currentColor" />
        {value != null && (
          <circle
            cx={center} cy={center} r={radius} strokeWidth={strokeWidth} fill="none"
            className={colorClass} stroke="currentColor" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
          />
        )}
      </svg>
      <span className="absolute text-sm font-bold text-slate-800 dark:text-slate-100">
        {value != null ? `${Math.round(value)}%` : '—'}
      </span>
    </div>
  );
};
