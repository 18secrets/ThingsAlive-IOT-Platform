/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface HealthRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  label?: string;
}

function ringColorClasses(value: number): { track: string; text: string } {
  if (value >= 70) return { track: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  if (value >= 45) return { track: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400' };
  return { track: 'stroke-rose-500', text: 'text-rose-600 dark:text-rose-400' };
}

/** Health-score gauge used on the Machine Details header. */
export const HealthRing: React.FC<HealthRingProps> = ({ value, size = 104, strokeWidth = 10, label = 'Health' }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const dash = (clamped / 100) * circumference;
  const colors = ringColorClasses(clamped);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-slate-100 dark:stroke-slate-800" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className={colors.track}
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-xl font-bold ${colors.text}`}>{Math.round(clamped)}</span>
        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">{label}</span>
      </div>
    </div>
  );
};
