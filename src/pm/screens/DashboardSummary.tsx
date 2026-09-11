/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance + Monitoring + Reports — condensed, graph-heavy overview
 * embedded on the main Dashboard landing page. Pulls from the same data-service
 * layer (api.ts) as the full screens, so every number here always agrees with
 * the dedicated page it links out to.
 */

import React, { useEffect, useState } from 'react';
import {
  Activity,
  Award,
  CheckCircle2,
  Cloud,
  Cpu,
  Fuel,
  Gauge,
  Layers,
  MapPinned,
  ShieldCheck,
  TrendingUp,
  Wrench,
} from 'lucide-react';
import {
  fetchBenchmarkRows,
  fetchDeviceHealthRows,
  fetchEmissionsRows,
  fetchFleetSummary,
  fetchFuelTheftEvents,
  fetchGeofenceEvents,
  fetchMachinesAtRisk,
  fetchOperatorScores,
  fetchUtilizationRows,
  fetchWarrantyRecords,
} from '../api';
import {
  BenchmarkRow,
  DeviceHealthRow,
  EmissionsRow,
  FleetSummary,
  FuelTheftEvent,
  GeofenceEvent,
  Machine,
  OperatorScore,
  UtilizationRow,
  WarrantyRecord,
} from '../types';
import { PmCard, PmKpiCard } from '../components/Card';
import { DonutChart } from '../components/DonutChart';
import { LineChart } from '../components/LineChart';
import { BarList } from '../components/BarList';
import { AbnormalParamChips, SeverityBadge, SignalCountBadge } from '../components/Badges';
import { NavigationTab } from '../../types';

interface DashboardSummaryProps {
  onNavigate: (tab: NavigationTab) => void;
  onViewMachine: (machineId: string) => void;
}

interface LoadedData {
  summary: FleetSummary;
  atRisk: Machine[];
  fuelTheft: FuelTheftEvent[];
  utilization: UtilizationRow[];
  geofence: GeofenceEvent[];
  deviceHealth: DeviceHealthRow[];
  operator: OperatorScore[];
  benchmark: BenchmarkRow[];
  emissions: EmissionsRow[];
  warranty: WarrantyRecord[];
}

const SectionHeading: React.FC<{ title: string; subtitle: string; ctaLabel?: string; onCta?: () => void }> = ({
  title,
  subtitle,
  ctaLabel,
  onCta,
}) => (
  <div className="flex items-end justify-between gap-3 mb-4">
    <div>
      <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
    </div>
    {ctaLabel && onCta && (
      <button
        onClick={onCta}
        className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer shrink-0 whitespace-nowrap"
      >
        {ctaLabel} →
      </button>
    )}
  </div>
);

const MonitorMiniCard: React.FC<{
  title: string;
  icon: React.FC<{ className?: string }>;
  kpiLabel: string;
  kpiValue: React.ReactNode;
  onView: () => void;
  children: React.ReactNode;
}> = ({ title, icon: Icon, kpiLabel, kpiValue, onView, children }) => (
  <PmCard className="flex flex-col">
    <div className="flex items-start justify-between mb-3">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500">{kpiLabel}</div>
        </div>
      </div>
      <div className="text-xl font-bold text-slate-900 dark:text-white shrink-0">{kpiValue}</div>
    </div>
    <div className="flex-1 flex items-center justify-center py-2">{children}</div>
    <button
      onClick={onView}
      className="mt-3 text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer text-center pt-2 border-t border-slate-100 dark:border-slate-800"
    >
      View {title} →
    </button>
  </PmCard>
);

export const PmDashboardSummary: React.FC<DashboardSummaryProps> = ({ onNavigate, onViewMachine }) => {
  const [data, setData] = useState<LoadedData | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchFleetSummary(),
      fetchMachinesAtRisk(),
      fetchFuelTheftEvents(),
      fetchUtilizationRows(),
      fetchGeofenceEvents(),
      fetchDeviceHealthRows(),
      fetchOperatorScores(),
      fetchBenchmarkRows(),
      fetchEmissionsRows(),
      fetchWarrantyRecords(),
    ]).then(([summary, atRisk, fuelTheft, utilization, geofence, deviceHealth, operator, benchmark, emissions, warranty]) => {
      if (cancelled) return;
      setData({ summary, atRisk, fuelTheft, utilization, geofence, deviceHealth, operator, benchmark, emissions, warranty });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <PmCard>
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading predictive maintenance &amp; monitoring overview…</p>
      </PmCard>
    );
  }

  const { summary, atRisk, fuelTheft, utilization, geofence, deviceHealth, operator, benchmark, emissions, warranty } = data;

  const fuelSuspected = fuelTheft.filter((e) => e.status === 'Suspected').length;
  const fuelConfirmed = fuelTheft.filter((e) => e.status === 'Confirmed').length;

  const fleetAvgUtilization = utilization.length > 0 ? Math.round((utilization.reduce((s, r) => s + r.utilizationPct, 0) / utilization.length) * 10) / 10 : 0;
  const productiveTotal = Math.round(utilization.reduce((s, r) => s + r.productiveHrs, 0));
  const idleTotal = Math.round(utilization.reduce((s, r) => s + r.idleHrs, 0));
  const offTotal = Math.round(utilization.reduce((s, r) => s + r.offHrs, 0));

  const geofenceOpen = geofence.filter((e) => e.status === 'Open').length;
  const geofenceAck = geofence.filter((e) => e.status === 'Acknowledged').length;
  const geofenceResolved = geofence.filter((e) => e.status === 'Resolved').length;

  const deviceHealthy = deviceHealth.filter((r) => r.status === 'Healthy').length;
  const deviceDegraded = deviceHealth.filter((r) => r.status === 'Degraded').length;
  const deviceOffline = deviceHealth.filter((r) => r.status === 'Offline').length;

  const warrantyNormal = warranty.filter((w) => w.verdict === 'Normal Operation').length;
  const warrantyDefect = warranty.filter((w) => w.verdict === 'Genuine Defect').length;
  const warrantyPending = warranty.filter((w) => w.verdict === 'Under Investigation').length;

  return (
    <div className="space-y-10">
      {/* ---------------------------------------------------------------- */}
      {/* Predictive Maintenance                                          */}
      {/* ---------------------------------------------------------------- */}
      <section id="dashboard-pm-section">
        <SectionHeading
          title="Predictive Maintenance"
          subtitle="Composite risk scores from per-signal z-scores against each machine's own 90-day baseline"
          ctaLabel="View Full Overview"
          onCta={() => onNavigate('pm-overview')}
        />

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-5">
          <PmKpiCard label="Total Machines" value={summary.totalMachines} icon={Layers} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
          <PmKpiCard label="Healthy" value={summary.healthy} icon={CheckCircle2} iconBg="bg-emerald-50 dark:bg-emerald-950/60" iconColor="text-emerald-600 dark:text-emerald-400" />
          <PmKpiCard label="Attention Required" value={summary.attention} icon={Activity} iconBg="bg-amber-50 dark:bg-amber-950/60" iconColor="text-amber-600 dark:text-amber-400" />
          <PmKpiCard label="Critical Risk" value={summary.critical} icon={Activity} iconBg="bg-rose-50 dark:bg-rose-950/60" iconColor="text-rose-600 dark:text-rose-400" />
          <PmKpiCard label="Avg Fleet Health" value={`${summary.avgFleetHealth}%`} icon={Gauge} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
          <PmKpiCard label="Maintenance Due" value={summary.maintenanceDue} icon={Wrench} iconBg="bg-orange-50 dark:bg-orange-950/60" iconColor="text-orange-600 dark:text-orange-400" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-5">
          <PmCard>
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 mb-3">Fleet Risk Distribution</div>
            <DonutChart
              segments={[
                { label: 'Healthy', value: summary.riskDistribution.healthy, colorClass: 'stroke-emerald-500' },
                { label: 'Attention', value: summary.riskDistribution.attention, colorClass: 'stroke-amber-500' },
                { label: 'Critical', value: summary.riskDistribution.critical, colorClass: 'stroke-rose-500' },
              ]}
              centerLabel={summary.totalMachines}
              centerSub="machines"
              size={128}
            />
          </PmCard>
          <PmCard>
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 mb-3">90-Day Fleet Risk Trend</div>
            <LineChart
              points={summary.riskTrend90d.map((p) => ({ daysAgo: p.daysAgo, value: p.avgRisk }))}
              yDomain={[0, 100]}
              height={170}
              referenceLines={[{ value: 60, label: 'High', colorClass: 'stroke-orange-400' }]}
            />
          </PmCard>
        </div>

        <PmCard noPadding>
          <div className="p-5 pb-3 flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Top Machines at Risk</div>
            <button onClick={() => onNavigate('pm-action-center')} className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 cursor-pointer">
              Open Action Center →
            </button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {atRisk.slice(0, 5).map((m) => (
              <button
                key={m.id}
                onClick={() => onViewMachine(m.id)}
                className="w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3 hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors text-left cursor-pointer"
              >
                <div className="sm:w-64 shrink-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{m.name}</div>
                  <div className="text-[11px] text-slate-400 font-mono">{m.site}</div>
                </div>
                <SeverityBadge severity={m.severity} score={m.riskScore} />
                <SignalCountBadge machine={m} />
                <AbnormalParamChips chips={m.abnormalParameters} className="flex-1" />
                <span className="text-[11px] text-slate-400 font-mono shrink-0">{m.predictedServiceWindow}</span>
              </button>
            ))}
          </div>
        </PmCard>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Monitoring                                                       */}
      {/* ---------------------------------------------------------------- */}
      <section id="dashboard-monitoring-section">
        <SectionHeading title="Monitoring" subtitle="Fuel theft, utilization, geofencing and telematics device health across the fleet" />

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
          <MonitorMiniCard
            title="Fuel Theft Detection"
            icon={Fuel}
            kpiLabel="Suspected / Confirmed"
            kpiValue={`${fuelSuspected} / ${fuelConfirmed}`}
            onView={() => onNavigate('mon-fuel-theft')}
          >
            <DonutChart
              segments={[
                { label: 'Suspected', value: fuelSuspected, colorClass: 'stroke-amber-500' },
                { label: 'Confirmed', value: fuelConfirmed, colorClass: 'stroke-rose-500' },
                { label: 'Dismissed', value: fuelTheft.filter((e) => e.status === 'Dismissed').length, colorClass: 'stroke-emerald-500' },
              ]}
              size={96}
              strokeWidth={12}
            />
          </MonitorMiniCard>

          <MonitorMiniCard
            title="Utilization Reporting"
            icon={Gauge}
            kpiLabel="Fleet Avg Utilization"
            kpiValue={`${fleetAvgUtilization}%`}
            onView={() => onNavigate('mon-utilization')}
          >
            <DonutChart
              segments={[
                { label: 'Productive', value: productiveTotal, colorClass: 'stroke-emerald-500' },
                { label: 'Idle', value: idleTotal, colorClass: 'stroke-amber-400' },
                { label: 'Off', value: offTotal, colorClass: 'stroke-slate-300 dark:stroke-slate-700' },
              ]}
              size={96}
              strokeWidth={12}
            />
          </MonitorMiniCard>

          <MonitorMiniCard
            title="Geofencing"
            icon={MapPinned}
            kpiLabel="Open Events"
            kpiValue={geofenceOpen}
            onView={() => onNavigate('mon-geofencing')}
          >
            <DonutChart
              segments={[
                { label: 'Open', value: geofenceOpen, colorClass: 'stroke-rose-500' },
                { label: 'Acknowledged', value: geofenceAck, colorClass: 'stroke-amber-500' },
                { label: 'Resolved', value: geofenceResolved, colorClass: 'stroke-emerald-500' },
              ]}
              size={96}
              strokeWidth={12}
            />
          </MonitorMiniCard>

          <MonitorMiniCard
            title="Device Health"
            icon={Cpu}
            kpiLabel="Healthy Devices"
            kpiValue={`${deviceHealthy}/${deviceHealth.length}`}
            onView={() => onNavigate('mon-device-health')}
          >
            <DonutChart
              segments={[
                { label: 'Healthy', value: deviceHealthy, colorClass: 'stroke-emerald-500' },
                { label: 'Degraded', value: deviceDegraded, colorClass: 'stroke-amber-500' },
                { label: 'Offline', value: deviceOffline, colorClass: 'stroke-rose-500' },
              ]}
              size={96}
              strokeWidth={12}
            />
          </MonitorMiniCard>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Reports                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section id="dashboard-reports-section">
        <SectionHeading
          title="Reports"
          subtitle="Operator scoring, fleet benchmarking, emissions and warranty audit trail"
          ctaLabel="View All Reports"
          onCta={() => onNavigate('reports')}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PmCard>
            <div className="flex items-center gap-2 mb-3">
              <Award className="w-4 h-4 text-slate-400" />
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Top Operator Scores</div>
            </div>
            <BarList
              items={operator.slice(0, 5).map((o) => ({ label: o.operatorName, value: o.score, sub: o.machineName, colorClass: o.score >= 80 ? 'bg-emerald-500' : o.score >= 60 ? 'bg-amber-500' : 'bg-rose-500' }))}
            />
          </PmCard>

          <PmCard>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-slate-400" />
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Fuel per Hour by Model (Top 5)</div>
            </div>
            <BarList
              items={benchmark.slice(0, 5).map((b) => ({ label: b.model, value: b.fuelPerHour, sub: `${b.deltaPct > 0 ? '+' : ''}${b.deltaPct}% vs avg`, colorClass: b.deltaPct > 8 ? 'bg-rose-500' : b.deltaPct > 0 ? 'bg-amber-500' : 'bg-emerald-500' }))}
              valueFormatter={(v) => `${v} L/hr`}
            />
          </PmCard>

          <PmCard>
            <div className="flex items-center gap-2 mb-3">
              <Cloud className="w-4 h-4 text-slate-400" />
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Estimated CO₂ by Site</div>
            </div>
            <DonutChart
              segments={emissions.map((r, i) => ({
                label: r.site,
                value: r.estimatedCO2Tons,
                colorClass: ['stroke-sky-500', 'stroke-emerald-500', 'stroke-amber-500', 'stroke-purple-500', 'stroke-orange-500', 'stroke-rose-500'][i % 6],
              }))}
              centerLabel={`${Math.round(emissions.reduce((s, r) => s + r.estimatedCO2Tons, 0) * 10) / 10}t`}
              centerSub="total CO₂"
              size={128}
            />
          </PmCard>

          <PmCard>
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-4 h-4 text-slate-400" />
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Warranty Audit Verdicts</div>
            </div>
            <DonutChart
              segments={[
                { label: 'Normal Operation', value: warrantyNormal, colorClass: 'stroke-emerald-500' },
                { label: 'Genuine Defect', value: warrantyDefect, colorClass: 'stroke-rose-500' },
                { label: 'Under Investigation', value: warrantyPending, colorClass: 'stroke-amber-500' },
              ]}
              centerLabel={warranty.length}
              centerSub="incidents"
              size={128}
            />
          </PmCard>
        </div>
      </section>
    </div>
  );
};
