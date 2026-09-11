/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AbnormalParamChip, Machine, ParamStatus, Severity } from '../types';
import { HIGH_PRIORITY_SIGNAL_THRESHOLD, severityClasses, severityLabel, statusClasses } from '../riskLogic';

export const SeverityBadge: React.FC<{ severity: Severity; score?: number; className?: string }> = ({ severity, score, className = '' }) => {
  const c = severityClasses(severity);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold whitespace-nowrap ${c.badge} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {severityLabel(severity)}
      {score !== undefined && <span className="opacity-70 font-mono">· {score}</span>}
    </span>
  );
};

export const StatusBadge: React.FC<{ status: ParamStatus; className?: string }> = ({ status, className = '' }) => {
  const c = statusClasses(status);
  const label = status === 'critical' ? 'Critical' : status === 'warning' ? 'Attention' : 'Normal';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${c.badge} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {label}
    </span>
  );
};

/**
 * "X/Y signals" badge — X is always abnormalParameters.length, so this can never
 * drift from the chips rendered by <AbnormalParamChips>. Highlights red when the
 * 3-signals-at-once auto-flag rule (see riskLogic.ts) is met.
 */
export const SignalCountBadge: React.FC<{ machine: Pick<Machine, 'abnormalSignalsCount' | 'totalSignalsMonitored' | 'highPriorityFlag'>; className?: string }> = ({
  machine,
  className = '',
}) => (
  <span
    title={machine.highPriorityFlag ? `${HIGH_PRIORITY_SIGNAL_THRESHOLD}+ signals trending at once — auto-flagged high priority` : undefined}
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-mono font-semibold whitespace-nowrap ${
      machine.highPriorityFlag
        ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
        : machine.abnormalSignalsCount > 0
          ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
          : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
    } ${className}`}
  >
    {machine.abnormalSignalsCount}/{machine.totalSignalsMonitored} signals
  </span>
);

const chipToneClasses: Record<AbnormalParamChip['tone'], string> = {
  critical: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  warning: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  normal: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

/**
 * Renders every entry in `chips` — no truncation — so the number of chips shown
 * always equals the machine's abnormalSignalsCount / the "X/Y signals" badge.
 */
export const AbnormalParamChips: React.FC<{ chips: AbnormalParamChip[]; className?: string }> = ({ chips, className = '' }) => {
  if (chips.length === 0) {
    return <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">No abnormal signals</span>;
  }
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {chips.map((chip, i) => (
        <span
          key={`${chip.label}-${i}`}
          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-medium whitespace-nowrap ${chipToneClasses[chip.tone]}`}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
};
