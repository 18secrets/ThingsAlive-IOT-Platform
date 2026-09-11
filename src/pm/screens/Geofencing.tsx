/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Monitoring — Geofencing.
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle2, MapPinOff, MoonStar, Navigation } from 'lucide-react';
import { fetchGeofenceEvents } from '../api';
import { GeofenceEvent } from '../types';
import { PmCard, PmKpiCard, PmSectionTitle } from '../components/Card';
import { DonutChart } from '../components/DonutChart';

const statusClasses: Record<GeofenceEvent['status'], string> = {
  Open: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  Acknowledged: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  Resolved: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

const typeIcon: Record<GeofenceEvent['type'], React.FC<{ className?: string }>> = {
  'Boundary Exit': MapPinOff,
  'After-Hours Movement': MoonStar,
  'Unauthorized Relocation': Navigation,
};

export const PmGeofencing: React.FC = () => {
  const [events, setEvents] = useState<GeofenceEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGeofenceEvents().then((e) => !cancelled && setEvents(e));
    return () => {
      cancelled = true;
    };
  }, []);

  const open = events?.filter((e) => e.status === 'Open').length ?? 0;
  const acknowledged = events?.filter((e) => e.status === 'Acknowledged').length ?? 0;
  const resolved = events?.filter((e) => e.status === 'Resolved').length ?? 0;

  const byType = (type: GeofenceEvent['type']) => events?.filter((e) => e.type === type).length ?? 0;

  return (
    <div id="mon-geofencing-view" className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PmKpiCard label="Total Events" value={events?.length ?? '—'} icon={Navigation} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
        <PmKpiCard label="Open" value={open} icon={MapPinOff} iconBg="bg-rose-50 dark:bg-rose-950/60" iconColor="text-rose-600 dark:text-rose-400" />
        <PmKpiCard label="Acknowledged" value={acknowledged} icon={MoonStar} iconBg="bg-amber-50 dark:bg-amber-950/60" iconColor="text-amber-600 dark:text-amber-400" />
        <PmKpiCard label="Resolved" value={resolved} icon={CheckCircle2} iconBg="bg-emerald-50 dark:bg-emerald-950/60" iconColor="text-emerald-600 dark:text-emerald-400" />
      </div>

      <PmCard>
        <PmSectionTitle title="Events by Type" subtitle="Boundary exit, after-hours movement, and unauthorized relocation" />
        <DonutChart
          segments={[
            { label: 'Boundary Exit', value: byType('Boundary Exit'), colorClass: 'stroke-sky-500' },
            { label: 'After-Hours Movement', value: byType('After-Hours Movement'), colorClass: 'stroke-purple-500' },
            { label: 'Unauthorized Relocation', value: byType('Unauthorized Relocation'), colorClass: 'stroke-orange-500' },
          ]}
          centerLabel={events?.length ?? 0}
          centerSub="total events"
        />
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Geofence Events" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Machine</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4">Event Type</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Detail</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {!events ? (
                <tr><td colSpan={6} className="py-10 text-center text-slate-400">Loading events…</td></tr>
              ) : (
                events.map((e) => {
                  const Icon = typeIcon[e.type];
                  return (
                    <tr key={e.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{e.machineName}</td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{e.site}</td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                          <Icon className="w-3.5 h-3.5 text-slate-400" />
                          {e.type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">{e.timestamp}</td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{e.location}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${statusClasses[e.status]}`}>
                          {e.status}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </PmCard>
    </div>
  );
};
