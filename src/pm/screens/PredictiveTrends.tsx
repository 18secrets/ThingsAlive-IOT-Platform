/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — Predictive Trends (deep analysis).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { fetchAllMachines } from '../api';
import { Machine } from '../types';
import { PmCard, PmSectionTitle } from '../components/Card';
import { TrendChart } from '../components/TrendChart';
import { Sparkline } from '../components/Sparkline';
import { ScatterChart } from '../components/ScatterChart';
import { StatusBadge } from '../components/Badges';
import { statusClasses } from '../riskLogic';

interface PredictiveTrendsProps {
  initialMachineId?: string;
  initialParameterKey?: string;
  onViewMachine: (machineId: string) => void;
}

type Period = '7' | '30' | '90' | 'custom';

const selectClass =
  'py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer';

export const PmPredictiveTrends: React.FC<PredictiveTrendsProps> = ({ initialMachineId, initialParameterKey, onViewMachine }) => {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [site, setSite] = useState('All');
  const [machineId, setMachineId] = useState(initialMachineId ?? '');
  const [paramKey, setParamKey] = useState(initialParameterKey ?? '');
  const [period, setPeriod] = useState<Period>('30');
  const [customDays, setCustomDays] = useState(45);

  useEffect(() => {
    let cancelled = false;
    fetchAllMachines().then((list) => {
      if (cancelled) return;
      setMachines(list);
      if (!machineId) {
        const preferred = list.find((m) => m.abnormalSignalsCount > 0) ?? list[0];
        setMachineId(preferred.id);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sites = useMemo(() => (machines ? Array.from(new Set(machines.map((m) => m.site))) : []), [machines]);
  const siteFilteredMachines = useMemo(() => (machines ?? []).filter((m) => site === 'All' || m.site === site), [machines, site]);
  const machine = useMemo(() => (machines ?? []).find((m) => m.id === machineId), [machines, machineId]);

  useEffect(() => {
    if (!machine) return;
    if (!machine.parameters.find((p) => p.key === paramKey)) {
      const preferredParam = [...machine.parameters].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore))[0];
      setParamKey(preferredParam.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.id]);

  const param = machine?.parameters.find((p) => p.key === paramKey);

  const days = period === 'custom' ? customDays : Number(period);
  const slicedHistory = param ? param.history.slice(Math.max(0, param.history.length - days)) : [];

  const oilPressureParam = machine?.parameters.find((p) => p.key === 'oilPressure');
  const loadParam = machine?.parameters.find((p) => p.key === 'load');
  const scatterPoints = useMemo(() => {
    if (!oilPressureParam || !loadParam) return [];
    return oilPressureParam.history.map((p, i) => ({
      x: loadParam.history[i]?.value ?? 0,
      y: p.value,
      recent: p.daysAgo <= 13,
    }));
  }, [oilPressureParam, loadParam]);

  const relatedParams = useMemo(() => {
    if (!machine || !param) return [];
    const rest = machine.parameters.filter((p) => p.key !== param.key);
    const abnormalFirst = [...rest].sort((a, b) => {
      const aAbn = a.status !== 'normal' ? 1 : 0;
      const bAbn = b.status !== 'normal' ? 1 : 0;
      return bAbn - aAbn || Math.abs(b.zScore) - Math.abs(a.zScore);
    });
    return abnormalFirst.slice(0, 3);
  }, [machine, param]);

  return (
    <div id="pm-trends-view" className="space-y-6">
      {/* Filters */}
      <PmCard>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Site</label>
            <select className={selectClass} value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="All">All Sites</option>
              {sites.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Machine</label>
            <select className={selectClass} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {siteFilteredMachines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Parameter</label>
            <select className={selectClass} value={paramKey} onChange={(e) => setParamKey(e.target.value)}>
              {machine?.parameters.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Time Period</label>
            <div className="flex items-center gap-1.5">
              {(['7', '30', '90', 'custom'] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    period === p
                      ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {p === 'custom' ? 'Custom' : `${p}d`}
                </button>
              ))}
              {period === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={customDays}
                  onChange={(e) => setCustomDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                  className="w-16 py-2 px-2 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500"
                />
              )}
            </div>
          </div>
        </div>
      </PmCard>

      {!machine || !param ? (
        <PmCard>
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading trend data…</p>
        </PmCard>
      ) : (
        <>
          {/* Primary chart */}
          <PmCard>
            <PmSectionTitle
              title={`${param.label} — ${machine.name}`}
              subtitle={`Last ${days} days vs. 90-day baseline band`}
              action={
                <div className="flex items-center gap-2">
                  <StatusBadge status={param.status} />
                  <button
                    onClick={() => onViewMachine(machine.id)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 hover:border-sky-300 transition-colors cursor-pointer"
                    title="View Machine Details"
                  >
                    <Activity className="w-3.5 h-3.5" />
                  </button>
                </div>
              }
            />
            <TrendChart
              history={slicedHistory}
              unit={param.unit}
              height={260}
              lineClassName={statusClasses(param.status).stroke}
              anomalyStartDaysAgo={param.deviationStartedDaysAgo}
            />
          </PmCard>

          {/* Secondary row: correlation + related sparklines */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <PmCard>
              <PmSectionTitle title="Oil Pressure vs. Engine Load" subtitle="Most recent 14 days highlighted — helps confirm whether load is driving the drift" />
              {oilPressureParam && loadParam ? (
                <ScatterChart points={scatterPoints} xLabel="Engine Load (%)" yLabel="Oil Pressure (bar)" />
              ) : (
                <p className="text-xs text-slate-400">Not applicable for this machine type.</p>
              )}
            </PmCard>

            <PmCard>
              <PmSectionTitle title="Related Parameters" subtitle="Other signals on this machine, most deviated first" />
              <div className="space-y-4">
                {relatedParams.map((p) => {
                  const c = statusClasses(p.status);
                  return (
                    <div key={p.key} className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">{p.label}</span>
                          <StatusBadge status={p.status} />
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {p.current}{p.unit} · baseline {p.baseline}{p.unit}
                        </div>
                      </div>
                      <Sparkline history={p.history} strokeClassName={c.stroke} fillClassName={c.stroke.replace('stroke-', 'fill-') + '/10'} width={110} height={30} />
                    </div>
                  );
                })}
              </div>
            </PmCard>
          </div>
        </>
      )}
    </div>
  );
};
