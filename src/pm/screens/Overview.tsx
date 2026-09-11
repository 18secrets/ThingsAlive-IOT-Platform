/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — Overview (landing dashboard).
 */

import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Gauge, Layers, Wrench } from 'lucide-react';
import { fetchFleetSummary, fetchMachinesAtRisk } from '../api';
import { FleetSummary, Machine } from '../types';
import { PmCard, PmKpiCard, PmSectionTitle } from '../components/Card';
import { DonutChart } from '../components/DonutChart';
import { LineChart } from '../components/LineChart';
import { AbnormalParamChips, SeverityBadge, SignalCountBadge } from '../components/Badges';

interface OverviewProps {
  onViewMachine: (machineId: string) => void;
}

export const PmOverview: React.FC<OverviewProps> = ({ onViewMachine }) => {
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [machines, setMachines] = useState<Machine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFleetSummary().then((s) => !cancelled && setSummary(s));
    fetchMachinesAtRisk().then((m) => !cancelled && setMachines(m));
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = !summary || !machines;

  return (
    <div id="pm-overview-view" className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <PmKpiCard
          label="Total Machines"
          value={summary?.totalMachines ?? '—'}
          icon={Layers}
          iconBg="bg-sky-50 dark:bg-sky-950/60"
          iconColor="text-sky-600 dark:text-sky-400"
        />
        <PmKpiCard
          label="Healthy"
          value={summary?.healthy ?? '—'}
          icon={CheckCircle2}
          iconBg="bg-emerald-50 dark:bg-emerald-950/60"
          iconColor="text-emerald-600 dark:text-emerald-400"
        />
        <PmKpiCard
          label="Attention Required"
          value={summary?.attention ?? '—'}
          icon={AlertTriangle}
          iconBg="bg-amber-50 dark:bg-amber-950/60"
          iconColor="text-amber-600 dark:text-amber-400"
        />
        <PmKpiCard
          label="Critical Risk"
          value={summary?.critical ?? '—'}
          icon={AlertTriangle}
          iconBg="bg-rose-50 dark:bg-rose-950/60"
          iconColor="text-rose-600 dark:text-rose-400"
        />
        <PmKpiCard
          label="Avg Fleet Health"
          value={summary ? `${summary.avgFleetHealth}%` : '—'}
          icon={Gauge}
          iconBg="bg-sky-50 dark:bg-sky-950/60"
          iconColor="text-sky-600 dark:text-sky-400"
        />
        <PmKpiCard
          label="Maintenance Due"
          value={summary?.maintenanceDue ?? '—'}
          icon={Wrench}
          iconBg="bg-orange-50 dark:bg-orange-950/60"
          iconColor="text-orange-600 dark:text-orange-400"
        />
      </div>

      {/* Distribution + Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PmCard>
          <PmSectionTitle title="Fleet Risk Distribution" subtitle="Share of monitored machines by risk bucket" />
          {summary && (
            <DonutChart
              segments={[
                { label: 'Healthy', value: summary.riskDistribution.healthy, colorClass: 'stroke-emerald-500' },
                { label: 'Attention', value: summary.riskDistribution.attention, colorClass: 'stroke-amber-500' },
                { label: 'Critical', value: summary.riskDistribution.critical, colorClass: 'stroke-rose-500' },
              ]}
              centerLabel={summary.totalMachines}
              centerSub="machines monitored"
            />
          )}
        </PmCard>

        <PmCard>
          <PmSectionTitle title="90-Day Fleet Risk Trend" subtitle="Average composite risk score across the fleet" />
          {summary && (
            <LineChart
              points={summary.riskTrend90d.map((p) => ({ daysAgo: p.daysAgo, value: p.avgRisk }))}
              yDomain={[0, 100]}
              referenceLines={[
                { value: 80, label: 'Critical', colorClass: 'stroke-rose-400' },
                { value: 60, label: 'High', colorClass: 'stroke-orange-400' },
                { value: 35, label: 'Medium', colorClass: 'stroke-amber-400' },
              ]}
            />
          )}
        </PmCard>
      </div>

      {/* Machines at Risk table */}
      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Machines at Risk" subtitle="Ranked by composite risk score — highest first" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Machine</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4">Risk Score</th>
                <th className="py-3 px-4">Abnormal Signals</th>
                <th className="py-3 px-4 text-center">Days Trending</th>
                <th className="py-3 px-4">Predicted Maintenance Window</th>
                <th className="py-3 px-4 text-center">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    Loading fleet risk data…
                  </td>
                </tr>
              ) : (
                machines!.slice(0, 12).map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-5">
                      <button onClick={() => onViewMachine(m.id)} className="font-semibold text-slate-900 dark:text-white hover:text-sky-600 dark:hover:text-sky-400 transition-colors cursor-pointer text-left">
                        {m.name}
                      </button>
                      <div className="text-[11px] text-slate-400 font-mono">{m.id} · {m.type}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{m.site}</td>
                    <td className="py-3 px-4">
                      <SeverityBadge severity={m.severity} score={m.riskScore} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1.5 items-start">
                        <SignalCountBadge machine={m} />
                        <AbnormalParamChips chips={m.abnormalParameters} />
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center font-mono text-slate-600 dark:text-slate-400">
                      {m.trendingDays > 0 ? `${m.trendingDays}d` : '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{m.predictedServiceWindow}</td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => onViewMachine(m.id)}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                        title="View Machine Details"
                      >
                        <Activity className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </PmCard>
    </div>
  );
};
