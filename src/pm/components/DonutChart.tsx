/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export interface DonutSegment {
  label: string;
  value: number;
  colorClass: string; // stroke-* tailwind class
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: React.ReactNode;
  centerSub?: React.ReactNode;
}

/** Fleet risk distribution donut (healthy / attention / critical). */
export const DonutChart: React.FC<DonutChartProps> = ({ segments, size = 140, strokeWidth = 18, centerLabel, centerSub }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;

  let cumulative = 0;
  const arcs = segments.map((seg) => {
    const fraction = seg.value / total;
    const dash = fraction * circumference;
    const gap = circumference - dash;
    const offset = -cumulative * circumference;
    cumulative += fraction;
    return { ...seg, dash, gap, offset };
  });

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-slate-100 dark:stroke-slate-800" />
          {arcs.map((arc, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              className={arc.colorClass}
              strokeDasharray={`${arc.dash} ${arc.gap}`}
              strokeDashoffset={arc.offset}
            />
          ))}
        </g>
        {centerLabel !== undefined && (
          <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" className="fill-slate-900 dark:fill-white font-bold" fontSize={size * 0.16}>
            {typeof centerLabel === 'string' || typeof centerLabel === 'number' ? centerLabel : ''}
          </text>
        )}
      </svg>
      <div className="space-y-2">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={`w-2.5 h-2.5 rounded-full ${seg.colorClass.replace('stroke-', 'bg-')}`} />
            <span className="text-slate-600 dark:text-slate-300 font-medium">{seg.label}</span>
            <span className="text-slate-400 dark:text-slate-500 font-mono text-[11px]">{seg.value}</span>
          </div>
        ))}
        {centerSub && <div className="text-[11px] text-slate-400 dark:text-slate-500 pt-1">{centerSub}</div>}
      </div>
    </div>
  );
};
