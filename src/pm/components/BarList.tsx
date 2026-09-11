/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export interface BarListItem {
  label: string;
  value: number;
  sub?: string;
  colorClass?: string; // bg-* tailwind class
}

/** Horizontal comparative bar list — lightweight chart for simpler monitoring screens. */
export const BarList: React.FC<{ items: BarListItem[]; valueFormatter?: (v: number) => string; defaultColorClass?: string }> = ({
  items,
  valueFormatter = (v) => `${v}`,
  defaultColorClass = 'bg-sky-500',
}) => {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-medium text-slate-700 dark:text-slate-300 truncate">{item.label}</span>
            <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0 ml-2">
              {valueFormatter(item.value)}
              {item.sub && <span className="text-slate-400 dark:text-slate-500"> · {item.sub}</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full ${item.colorClass ?? defaultColorClass}`}
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};
