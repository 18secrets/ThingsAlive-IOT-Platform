/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export interface StackedBarSegment {
  label: string;
  value: number;
  colorClass: string; // bg-* tailwind class
}

/** Horizontal stacked bar — used per-row in Utilization Reporting (productive/idle/off). */
export const StackedBar: React.FC<{ segments: StackedBarSegment[]; total: number; height?: number; className?: string }> = ({
  segments,
  total,
  height = 10,
  className = '',
}) => {
  const safeTotal = total || segments.reduce((s, seg) => s + seg.value, 0) || 1;
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 ${className}`} style={{ height }}>
      {segments.map((seg, i) => (
        <div
          key={i}
          className={seg.colorClass}
          style={{ width: `${Math.max(0, (seg.value / safeTotal) * 100)}%` }}
          title={`${seg.label}: ${seg.value}h`}
        />
      ))}
    </div>
  );
};

export const StackedBarLegend: React.FC<{ segments: StackedBarSegment[] }> = ({ segments }) => (
  <div className="flex items-center gap-3 flex-wrap">
    {segments.map((seg, i) => (
      <div key={i} className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <span className={`w-2.5 h-2.5 rounded-full ${seg.colorClass}`} />
        {seg.label}
      </div>
    ))}
  </div>
);
