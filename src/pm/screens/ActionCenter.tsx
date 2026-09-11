/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — Action Center (maintenance queue).
 */

import React, { useEffect, useState } from 'react';
import { Calendar, CheckCircle2, ClipboardPlus, Clock } from 'lucide-react';
import { fetchActionQueue } from '../api';
import { Machine } from '../types';
import { PmCard } from '../components/Card';
import { AbnormalParamChips, SignalCountBadge } from '../components/Badges';
import { severityClasses } from '../riskLogic';

interface ActionCenterProps {
  onViewMachine: (machineId: string) => void;
}

interface Lane {
  key: 'critical' | 'high' | 'medium' | 'upcoming';
  title: string;
  subtitle: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const LANES: Lane[] = [
  { key: 'critical', title: 'Critical', subtitle: 'Act now', severity: 'critical' },
  { key: 'high', title: 'High', subtitle: 'Act this week', severity: 'high' },
  { key: 'medium', title: 'Medium', subtitle: 'Plan ahead', severity: 'medium' },
  { key: 'upcoming', title: 'Upcoming Service', subtitle: 'Routine / on schedule', severity: 'low' },
];

const MachineActionCard: React.FC<{ machine: Machine; onViewMachine: (id: string) => void }> = ({ machine, onViewMachine }) => {
  const [scheduled, setScheduled] = useState(false);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div>
        <div className="font-semibold text-sm text-slate-900 dark:text-white">{machine.name}</div>
        <div className="text-[11px] text-slate-400 font-mono">{machine.id} · {machine.site}</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SignalCountBadge machine={machine} />
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
          <Clock className="w-3 h-3" />
          {machine.trendingDays > 0 ? `${machine.trendingDays}d trending` : 'stable'}
        </span>
      </div>

      <AbnormalParamChips chips={machine.abnormalParameters} />

      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <Calendar className="w-3 h-3 shrink-0" />
        <span>Predicted window: <span className="font-medium text-slate-700 dark:text-slate-300">{machine.predictedServiceWindow}</span></span>
      </div>

      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed border-t border-slate-100 dark:border-slate-800 pt-2.5">
        {machine.recommendedAction}
      </p>

      {/* Stacked (not side-by-side) so the button label never gets cramped or
          clipped as the lane column narrows across breakpoints. */}
      <div className="flex flex-col gap-2 pt-1">
        <button
          onClick={() => onViewMachine(machine.id)}
          className="w-full px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          View Machine
        </button>
        <button
          onClick={() => setScheduled(true)}
          disabled={scheduled}
          className={`w-full px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
            scheduled
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 cursor-default'
              : 'bg-[#0B7285] hover:bg-[#095C6B] text-white'
          }`}
        >
          {scheduled ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <ClipboardPlus className="w-3.5 h-3.5 shrink-0" />}
          {scheduled ? 'Scheduled' : 'Create Maintenance'}
        </button>
      </div>
    </div>
  );
};

export const PmActionCenter: React.FC<ActionCenterProps> = ({ onViewMachine }) => {
  const [queue, setQueue] = useState<{ critical: Machine[]; high: Machine[]; medium: Machine[]; upcoming: Machine[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchActionQueue().then((q) => !cancelled && setQueue(q));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div id="pm-action-center-view" className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {LANES.map((lane) => {
          const machines = queue?.[lane.key] ?? [];
          const c = severityClasses(lane.severity);
          return (
            <div key={lane.key} className="space-y-3">
              <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${c.badge}`}>
                <div>
                  <div className="text-sm font-bold flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                    {lane.title}
                  </div>
                  <div className="text-[10px] opacity-80">{lane.subtitle}</div>
                </div>
                <span className="text-lg font-bold font-mono">{queue ? machines.length : '—'}</span>
              </div>

              <div className="space-y-3 min-h-[80px]">
                {!queue ? (
                  <PmCard><p className="text-xs text-slate-400">Loading…</p></PmCard>
                ) : machines.length === 0 ? (
                  <div className="text-xs text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-5 text-center">
                    No machines in this lane
                  </div>
                ) : (
                  machines.map((m) => <MachineActionCard key={m.id} machine={m} onViewMachine={onViewMachine} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
