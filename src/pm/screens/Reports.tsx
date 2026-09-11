/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reports — tabbed: Operator Scoring, Fleet Benchmarking, Emissions, Warranty Audit Trail.
 */

import React, { useEffect, useState } from 'react';
import { Award, Cloud, Gauge, ShieldCheck } from 'lucide-react';
import { fetchBenchmarkRows, fetchEmissionsRows, fetchOperatorScores, fetchWarrantyRecords } from '../api';
import { BenchmarkRow, EmissionsRow, OperatorScore, WarrantyRecord } from '../types';
import { PmCard, PmSectionTitle } from '../components/Card';
import { BarList } from '../components/BarList';
import { DonutChart } from '../components/DonutChart';

export type ReportsTab = 'operator' | 'benchmarking' | 'emissions' | 'warranty';

const TABS: { id: ReportsTab; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'operator', label: 'Operator Scoring', icon: Award },
  { id: 'benchmarking', label: 'Fleet Benchmarking', icon: Gauge },
  { id: 'emissions', label: 'Emissions', icon: Cloud },
  { id: 'warranty', label: 'Warranty Audit Trail', icon: ShieldCheck },
];

function scoreClasses(score: number): string {
  if (score >= 80) return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
  if (score >= 60) return 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800';
  return 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800';
}

const verdictClasses: Record<WarrantyRecord['verdict'], string> = {
  'Normal Operation': 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  'Genuine Defect': 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  'Under Investigation': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
};

const OperatorScoringTab: React.FC = () => {
  const [rows, setRows] = useState<OperatorScore[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchOperatorScores().then((r) => !cancelled && setRows(r));
    return () => { cancelled = true; };
  }, []);

  return (
    <PmCard noPadding>
      <div className="p-5 pb-0">
        <PmSectionTitle title="Operator Scoring" subtitle="Harsh usage events, idle ratio, and throttle/load ratio feed a single 0–100 score" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
            <tr>
              <th className="py-3 px-5">Operator</th>
              <th className="py-3 px-4">Site</th>
              <th className="py-3 px-4">Machine</th>
              <th className="py-3 px-4 text-center">Harsh Events</th>
              <th className="py-3 px-4 text-center">Idle Ratio</th>
              <th className="py-3 px-4 text-center">Throttle/Load Ratio</th>
              <th className="py-3 px-4 text-center">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
            {!rows ? (
              <tr><td colSpan={7} className="py-10 text-center text-slate-400">Loading operator scores…</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.operatorId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{r.operatorName}</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{r.site}</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{r.machineName}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.harshEvents}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.idleRatioPct}%</td>
                  <td className="py-3 px-4 text-center font-mono">{r.throttleLoadRatio}</td>
                  <td className="py-3 px-4 text-center">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-[11px] font-bold font-mono ${scoreClasses(r.score)}`}>
                      {r.score}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </PmCard>
  );
};

const FleetBenchmarkingTab: React.FC = () => {
  const [rows, setRows] = useState<BenchmarkRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchBenchmarkRows().then((r) => !cancelled && setRows(r));
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <PmCard>
        <PmSectionTitle title="Fuel per Hour by Model" subtitle="Procurement view — flags models that run less fuel-efficient than the fleet average" />
        {rows && rows.length > 0 ? (
          <BarList
            items={rows.map((r) => ({ label: `${r.model} (${r.unitsCount} units)`, value: r.fuelPerHour, sub: `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}% vs fleet avg`, colorClass: r.deltaPct > 8 ? 'bg-rose-500' : r.deltaPct > 0 ? 'bg-amber-500' : 'bg-emerald-500' }))}
            valueFormatter={(v) => `${v} L/hr`}
          />
        ) : (
          <p className="text-xs text-slate-400">Loading…</p>
        )}
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Model Benchmark Detail" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Model</th>
                <th className="py-3 px-4 text-center">Units</th>
                <th className="py-3 px-4 text-center">Fuel / Hour</th>
                <th className="py-3 px-4 text-center">Fleet Avg</th>
                <th className="py-3 px-4 text-center">Delta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {rows?.map((r) => (
                <tr key={r.model} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{r.model}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.unitsCount}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.fuelPerHour} L/hr</td>
                  <td className="py-3 px-4 text-center font-mono text-slate-500 dark:text-slate-400">{r.fleetAvgFuelPerHour} L/hr</td>
                  <td className={`py-3 px-4 text-center font-mono font-semibold ${r.deltaPct > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {r.deltaPct > 0 ? '+' : ''}{r.deltaPct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PmCard>
    </div>
  );
};

const EmissionsTab: React.FC = () => {
  const [rows, setRows] = useState<EmissionsRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchEmissionsRows().then((r) => !cancelled && setRows(r));
    return () => { cancelled = true; };
  }, []);

  const totalCO2 = rows ? Math.round(rows.reduce((s, r) => s + r.estimatedCO2Tons, 0) * 10) / 10 : 0;

  return (
    <div className="space-y-6">
      <PmCard>
        <PmSectionTitle title="Estimated CO₂ by Site" subtitle="Derived from fuel consumption — 2.68 kg CO₂ per litre of diesel" />
        {rows && rows.length > 0 ? (
          <DonutChart
            segments={rows.map((r, i) => ({
              label: r.site,
              value: r.estimatedCO2Tons,
              colorClass: ['stroke-sky-500', 'stroke-emerald-500', 'stroke-amber-500', 'stroke-purple-500', 'stroke-orange-500', 'stroke-rose-500'][i % 6],
            }))}
            centerLabel={`${totalCO2}t`}
            centerSub="total CO₂"
          />
        ) : (
          <p className="text-xs text-slate-400">Loading…</p>
        )}
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Emissions by Site" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Site</th>
                <th className="py-3 px-4 text-center">Machines</th>
                <th className="py-3 px-4 text-center">Fuel Consumed</th>
                <th className="py-3 px-4 text-center">Estimated CO₂</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {rows?.map((r) => (
                <tr key={r.site} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{r.site}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.machinesCount}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.fuelConsumedLiters.toLocaleString()} L</td>
                  <td className="py-3 px-4 text-center font-mono font-semibold text-slate-700 dark:text-slate-300">{r.estimatedCO2Tons} t</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PmCard>
    </div>
  );
};

const WarrantyAuditTrailTab: React.FC = () => {
  const [rows, setRows] = useState<WarrantyRecord[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchWarrantyRecords().then((r) => !cancelled && setRows(r));
    return () => { cancelled = true; };
  }, []);

  return (
    <PmCard noPadding>
      <div className="p-5 pb-0">
        <PmSectionTitle title="Warranty Audit Trail" subtitle="Was the incident within normal load/temperature bounds, or a genuine defect?" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
            <tr>
              <th className="py-3 px-5">Machine</th>
              <th className="py-3 px-4">Incident Date</th>
              <th className="py-3 px-4">Description</th>
              <th className="py-3 px-4 text-center">Load at Incident</th>
              <th className="py-3 px-4 text-center">Temp at Incident</th>
              <th className="py-3 px-4 text-center">Within Bounds</th>
              <th className="py-3 px-4">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
            {!rows ? (
              <tr><td colSpan={7} className="py-10 text-center text-slate-400">Loading warranty records…</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{r.machineName}</td>
                  <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">{r.incidentDate}</td>
                  <td className="py-3 px-4 max-w-xs truncate text-slate-600 dark:text-slate-400" title={r.description}>{r.description}</td>
                  <td className="py-3 px-4 text-center font-mono">{r.loadAtIncidentPct}%</td>
                  <td className="py-3 px-4 text-center font-mono">{r.tempAtIncidentC}°C</td>
                  <td className="py-3 px-4 text-center">
                    {r.withinNormalBounds ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Yes</span>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400 font-semibold">No</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${verdictClasses[r.verdict]}`}>
                      {r.verdict}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </PmCard>
  );
};

export const PmReports: React.FC<{ activeTab: ReportsTab; onChangeTab: (tab: ReportsTab) => void }> = ({ activeTab, onChangeTab }) => {
  return (
    <div id="reports-view" className="space-y-5">
      <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChangeTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-lg border transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
                isActive
                  ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700 shadow-xs font-semibold'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="pt-1">
        {activeTab === 'operator' && <OperatorScoringTab />}
        {activeTab === 'benchmarking' && <FleetBenchmarkingTab />}
        {activeTab === 'emissions' && <EmissionsTab />}
        {activeTab === 'warranty' && <WarrantyAuditTrailTab />}
      </div>
    </div>
  );
};
