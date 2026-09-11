/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Monitoring — Device Health.
 *
 * Health of the telematics devices themselves (signal, packet loss, last-seen,
 * serial-number gaps) — distinct from equipment predictive maintenance.
 */

import React, { useEffect, useState } from 'react';
import { Cpu, SignalHigh, WifiOff } from 'lucide-react';
import { fetchDeviceHealthRows } from '../api';
import { DeviceHealthRow } from '../types';
import { PmCard, PmKpiCard, PmSectionTitle } from '../components/Card';
import { DonutChart } from '../components/DonutChart';

const statusClasses: Record<DeviceHealthRow['status'], string> = {
  Healthy: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  Degraded: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  Offline: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

// Bar color follows the row's own status (not an independent GSM threshold) so the
// signal bar and the status badge in the same row never disagree.
const signalBarColorByStatus: Record<DeviceHealthRow['status'], string> = {
  Healthy: 'bg-emerald-500',
  Degraded: 'bg-amber-500',
  Offline: 'bg-rose-500',
};

export const PmDeviceHealth: React.FC = () => {
  const [rows, setRows] = useState<DeviceHealthRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDeviceHealthRows().then((r) => !cancelled && setRows(r));
    return () => {
      cancelled = true;
    };
  }, []);

  const healthy = rows?.filter((r) => r.status === 'Healthy').length ?? 0;
  const degraded = rows?.filter((r) => r.status === 'Degraded').length ?? 0;
  const offline = rows?.filter((r) => r.status === 'Offline').length ?? 0;
  const avgSignal = rows && rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.gsmSignalPct, 0) / rows.length) : 0;

  return (
    <div id="mon-device-health-view" className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PmKpiCard label="Healthy Devices" value={healthy} icon={Cpu} iconBg="bg-emerald-50 dark:bg-emerald-950/60" iconColor="text-emerald-600 dark:text-emerald-400" />
        <PmKpiCard label="Degraded" value={degraded} icon={SignalHigh} iconBg="bg-amber-50 dark:bg-amber-950/60" iconColor="text-amber-600 dark:text-amber-400" />
        <PmKpiCard label="Offline" value={offline} icon={WifiOff} iconBg="bg-rose-50 dark:bg-rose-950/60" iconColor="text-rose-600 dark:text-rose-400" />
        <PmKpiCard label="Avg GSM Signal" value={`${avgSignal}%`} icon={SignalHigh} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
      </div>

      <PmCard>
        <PmSectionTitle title="Fleet Device Status" subtitle="Distribution of telematics device health across the fleet" />
        <DonutChart
          segments={[
            { label: 'Healthy', value: healthy, colorClass: 'stroke-emerald-500' },
            { label: 'Degraded', value: degraded, colorClass: 'stroke-amber-500' },
            { label: 'Offline', value: offline, colorClass: 'stroke-rose-500' },
          ]}
          centerLabel={rows?.length ?? 0}
          centerSub="devices tracked"
        />
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Device Fleet" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Device</th>
                <th className="py-3 px-4">Equipment</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4 w-40">GSM Signal</th>
                <th className="py-3 px-4 text-center">Packet Drop</th>
                <th className="py-3 px-4">Last Seen</th>
                <th className="py-3 px-4 text-center">Serial Gaps</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {!rows ? (
                <tr><td colSpan={8} className="py-10 text-center text-slate-400">Loading device health…</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.deviceId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-5">
                      <div className="font-semibold text-slate-900 dark:text-white">{r.deviceId}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{r.imei}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{r.machineName}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{r.site}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden min-w-[60px]">
                          <div className={`h-full rounded-full ${signalBarColorByStatus[r.status]}`} style={{ width: `${r.gsmSignalPct}%` }} />
                        </div>
                        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 w-8 text-right">{r.gsmSignalPct}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center font-mono text-slate-600 dark:text-slate-400">{r.packetDropPct}%</td>
                    <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">{r.lastSeen}</td>
                    <td className="py-3 px-4 text-center font-mono text-slate-600 dark:text-slate-400">{r.serialGapCount || '—'}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${statusClasses[r.status]}`}>
                        {r.status}
                      </span>
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
