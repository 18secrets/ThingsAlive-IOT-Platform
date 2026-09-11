/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — Machine Details.
 */

import React, { useEffect, useState } from 'react';
import { Calendar, Clock, Hash, MapPin, TrendingUp, Wrench } from 'lucide-react';
import { fetchMachineById, fetchMachinesAtRisk } from '../api';
import { Machine, ParameterReading } from '../types';
import { PmBackLink, PmCard, PmSectionTitle } from '../components/Card';
import { HealthRing } from '../components/HealthRing';
import { Sparkline } from '../components/Sparkline';
import { TrendChart } from '../components/TrendChart';
import { AbnormalParamChips, SeverityBadge, SignalCountBadge, StatusBadge } from '../components/Badges';
import { statusClasses } from '../riskLogic';

interface MachineDetailsProps {
  /** When omitted, defaults to the fleet's highest-risk machine. */
  machineId?: string;
  onBack: () => void;
  onViewTrends: (machineId: string, parameterKey: string) => void;
}

const sparkStrokeByStatus: Record<string, string> = {
  critical: 'stroke-rose-500',
  warning: 'stroke-amber-500',
  normal: 'stroke-emerald-500',
};
const sparkFillByStatus: Record<string, string> = {
  critical: 'fill-rose-500/10',
  warning: 'fill-amber-500/10',
  normal: 'fill-emerald-500/10',
};

const ParameterCard: React.FC<{ param: ParameterReading; onViewTrend: () => void }> = ({ param, onViewTrend }) => {
  const c = statusClasses(param.status);
  return (
    <div className={`bg-white dark:bg-slate-900 border rounded-xl p-4 shadow-xs space-y-3 ${c.border}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">{param.label}</div>
          <div className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">
            {param.current}
            <span className="text-xs font-medium text-slate-400 ml-1">{param.unit}</span>
          </div>
        </div>
        <StatusBadge status={param.status} />
      </div>

      <Sparkline history={param.history} strokeClassName={sparkStrokeByStatus[param.status]} fillClassName={sparkFillByStatus[param.status]} width={140} height={34} className="w-full" />

      <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
        <span>
          Baseline: <span className="font-mono text-slate-700 dark:text-slate-300">{param.baseline}{param.unit}</span>
        </span>
        <span className={`font-mono font-semibold ${c.text}`}>
          {param.deviationPct > 0 ? '+' : ''}
          {param.deviationPct}%
        </span>
      </div>

      <button
        onClick={onViewTrend}
        className="w-full text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer text-center pt-1"
      >
        View in Predictive Trends →
      </button>
    </div>
  );
};

export const PmMachineDetails: React.FC<MachineDetailsProps> = ({ machineId, onBack, onViewTrends }) => {
  const [machine, setMachine] = useState<Machine | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setMachine(undefined);
    (async () => {
      const id = machineId || (await fetchMachinesAtRisk())[0]?.id;
      const m = id ? await fetchMachineById(id) : undefined;
      if (!cancelled) setMachine(m ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  if (machine === undefined) {
    return <div className="py-16 text-center text-sm text-slate-400">Loading machine details…</div>;
  }
  if (machine === null) {
    return (
      <div className="space-y-4">
        <PmBackLink label="Back to Overview" onClick={onBack} />
        <PmCard>
          <p className="text-sm text-slate-500 dark:text-slate-400">Machine not found.</p>
        </PmCard>
      </div>
    );
  }

  // Same source (machine.parameters) drives the chips everywhere, the "Why is this
  // machine high-risk?" panel below, and the abnormalSignalsCount badge — they can't drift apart.
  const abnormalParams = machine.parameters.filter((p) => p.status !== 'normal');
  const mostDeviated = [...machine.parameters].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore)).slice(0, abnormalParams.length > 0 ? 2 : 1);

  return (
    <div id="pm-machine-details-view" className="space-y-6">
      <PmBackLink label="Back to Overview" onClick={onBack} />

      {/* Header */}
      <PmCard>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-5">
            <HealthRing value={machine.healthScore} />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">{machine.name}</h2>
                <SeverityBadge severity={machine.severity} score={machine.riskScore} />
                <SignalCountBadge machine={machine} />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap font-sans">
                <span className="inline-flex items-center gap-1"><Hash className="w-3 h-3" />{machine.serial}</span>
                <span>{machine.type} · {machine.model}</span>
                <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{machine.site} · {machine.region}</span>
              </div>
              <div className="mt-2">
                <AbnormalParamChips chips={machine.abnormalParameters} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 lg:min-w-[360px]">
            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1"><Clock className="w-3 h-3" />Runtime</div>
              <div className="text-sm font-bold text-slate-900 dark:text-white mt-1">{machine.engineRuntimeHrs.toLocaleString()} hrs</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1"><Wrench className="w-3 h-3" />Last Service</div>
              <div className="text-sm font-bold text-slate-900 dark:text-white mt-1">{machine.lastServiceDate}</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1"><Calendar className="w-3 h-3" />Next Service</div>
              <div className="text-sm font-bold text-slate-900 dark:text-white mt-1">{machine.predictedServiceWindow}</div>
            </div>
          </div>
        </div>
      </PmCard>

      {/* Parameter grid */}
      <PmCard>
        <PmSectionTitle title="Monitored Parameters" subtitle={`${machine.totalSignalsMonitored} signals tracked against this machine's own 90-day baseline`} />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {machine.parameters.map((p) => (
            <ParameterCard key={p.key} param={p} onViewTrend={() => onViewTrends(machine.id, p.key)} />
          ))}
        </div>
      </PmCard>

      {/* Largest trend charts for most-deviated parameters */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {mostDeviated.map((p) => {
          const c = statusClasses(p.status);
          return (
            <PmCard key={p.key}>
              <PmSectionTitle
                title={p.label}
                subtitle={`Actual vs. 90-day baseline band${p.deviationStartedDaysAgo !== undefined ? ' · anomaly marked' : ''}`}
                action={<StatusBadge status={p.status} />}
              />
              <TrendChart
                history={p.history}
                unit={p.unit}
                lineClassName={c.stroke}
                anomalyStartDaysAgo={p.deviationStartedDaysAgo}
              />
            </PmCard>
          );
        })}
      </div>

      {/* Why is this machine high-risk? */}
      <PmCard>
        <PmSectionTitle
          title="Why is this machine high-risk?"
          subtitle={
            abnormalParams.length > 0
              ? `${abnormalParams.length} of ${machine.totalSignalsMonitored} signals are trending abnormally right now`
              : 'No signals are currently trending abnormally'
          }
          action={
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-slate-400" />
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">{machine.recommendedAction}</span>
            </div>
          }
        />
        {abnormalParams.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            All monitored signals are within their normal 90-day baseline range. Continue standard monitoring.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {abnormalParams.map((p) => {
              const c = statusClasses(p.status);
              return (
                <div key={p.key} className="py-3.5 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${c.dot}`} />
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{p.label}</div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-xl">{p.reason}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-mono font-bold ${c.text}`}>z = {p.zScore.toFixed(2)}</div>
                    <StatusBadge status={p.status} className="mt-1" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PmCard>
    </div>
  );
};
