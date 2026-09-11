/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Monitoring — Utilization Reporting.
 */

import React, { useEffect, useState } from 'react';
import { Gauge, MoonStar, PauseCircle, PlayCircle } from 'lucide-react';
import { fetchUtilizationRows } from '../api';
import { UtilizationRow } from '../types';
import { PmCard, PmKpiCard, PmSectionTitle } from '../components/Card';
import { DonutChart } from '../components/DonutChart';
import { StackedBar, StackedBarLegend } from '../components/StackedBar';

const SEGMENTS = (row: UtilizationRow) => [
  { label: 'Productive', value: row.productiveHrs, colorClass: 'bg-emerald-500' },
  { label: 'Idle', value: row.idleHrs, colorClass: 'bg-amber-400' },
  { label: 'Off', value: row.offHrs, colorClass: 'bg-slate-300 dark:bg-slate-700' },
];

const LEGEND_SEGMENTS = [
  { label: 'Productive', value: 0, colorClass: 'bg-emerald-500' },
  { label: 'Idle', value: 0, colorClass: 'bg-amber-400' },
  { label: 'Off', value: 0, colorClass: 'bg-slate-300 dark:bg-slate-700' },
];

export const PmUtilizationReporting: React.FC = () => {
  const [rows, setRows] = useState<UtilizationRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUtilizationRows().then((r) => !cancelled && setRows(r));
    return () => {
      cancelled = true;
    };
  }, []);

  const fleetAvgUtilization = rows && rows.length > 0 ? Math.round((rows.reduce((s, r) => s + r.utilizationPct, 0) / rows.length) * 10) / 10 : 0;
  const totalProductive = rows ? Math.round(rows.reduce((s, r) => s + r.productiveHrs, 0)) : 0;
  const totalIdle = rows ? Math.round(rows.reduce((s, r) => s + r.idleHrs, 0)) : 0;
  const totalOff = rows ? Math.round(rows.reduce((s, r) => s + r.offHrs, 0)) : 0;

  return (
    <div id="mon-utilization-view" className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PmKpiCard label="Fleet Avg Utilization" value={`${fleetAvgUtilization}%`} icon={Gauge} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
        <PmKpiCard label="Total Productive Hrs" value={totalProductive} icon={PlayCircle} iconBg="bg-emerald-50 dark:bg-emerald-950/60" iconColor="text-emerald-600 dark:text-emerald-400" />
        <PmKpiCard label="Total Idle Hrs" value={totalIdle} icon={PauseCircle} iconBg="bg-amber-50 dark:bg-amber-950/60" iconColor="text-amber-600 dark:text-amber-400" />
        <PmKpiCard label="Total Off Hrs" value={totalOff} icon={MoonStar} iconBg="bg-slate-100 dark:bg-slate-800" iconColor="text-slate-600 dark:text-slate-300" />
      </div>

      <PmCard>
        <PmSectionTitle title="Fleet Hours Breakdown" subtitle="Aggregate productive / idle / off hours across all monitored machines" />
        <DonutChart
          segments={[
            { label: 'Productive', value: totalProductive, colorClass: 'stroke-emerald-500' },
            { label: 'Idle', value: totalIdle, colorClass: 'stroke-amber-400' },
            { label: 'Off', value: totalOff, colorClass: 'stroke-slate-300 dark:stroke-slate-700' },
          ]}
          centerLabel={`${fleetAvgUtilization}%`}
          centerSub="avg utilization"
        />
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-3 flex items-center justify-between flex-wrap gap-2">
          <PmSectionTitle title="Utilization by Machine" />
          <StackedBarLegend segments={LEGEND_SEGMENTS} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Machine</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4 w-64">24h Breakdown</th>
                <th className="py-3 px-4 text-center">Productive</th>
                <th className="py-3 px-4 text-center">Idle</th>
                <th className="py-3 px-4 text-center">Off</th>
                <th className="py-3 px-4 text-center">Utilization</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {!rows ? (
                <tr><td colSpan={7} className="py-10 text-center text-slate-400">Loading utilization data…</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.machineId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{r.machineName}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{r.site}</td>
                    <td className="py-3 px-4">
                      <StackedBar segments={SEGMENTS(r)} total={24} />
                    </td>
                    <td className="py-3 px-4 text-center font-mono text-emerald-600 dark:text-emerald-400">{r.productiveHrs}h</td>
                    <td className="py-3 px-4 text-center font-mono text-amber-600 dark:text-amber-400">{r.idleHrs}h</td>
                    <td className="py-3 px-4 text-center font-mono text-slate-500 dark:text-slate-400">{r.offHrs}h</td>
                    <td className="py-3 px-4 text-center font-mono font-semibold text-slate-800 dark:text-slate-200">{r.utilizationPct}%</td>
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
