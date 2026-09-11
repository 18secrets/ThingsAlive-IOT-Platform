/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Monitoring — Fuel Theft Detection.
 *
 * Flags events where fuel level drops sharply while ignition is off and there is
 * no GPS movement — the classic siphoning signature.
 */

import React, { useEffect, useState } from 'react';
import { AlertOctagon, Droplet, Fuel, ShieldAlert } from 'lucide-react';
import { fetchFuelTheftEvents } from '../api';
import { FuelTheftEvent } from '../types';
import { PmCard, PmKpiCard, PmSectionTitle } from '../components/Card';
import { BarList } from '../components/BarList';

const statusClasses: Record<FuelTheftEvent['status'], string> = {
  Confirmed: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  Suspected: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  Dismissed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

export const PmFuelTheftDetection: React.FC = () => {
  const [events, setEvents] = useState<FuelTheftEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFuelTheftEvents().then((e) => !cancelled && setEvents(e));
    return () => {
      cancelled = true;
    };
  }, []);

  const suspected = events?.filter((e) => e.status === 'Suspected').length ?? 0;
  const confirmed = events?.filter((e) => e.status === 'Confirmed').length ?? 0;
  const totalLoss = events?.reduce((s, e) => s + e.fuelDropLiters, 0) ?? 0;
  const avgDrop = events && events.length > 0 ? Math.round((events.reduce((s, e) => s + e.fuelDropPct, 0) / events.length) * 10) / 10 : 0;

  return (
    <div id="mon-fuel-theft-view" className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PmKpiCard label="Suspected Events" value={suspected} icon={ShieldAlert} iconBg="bg-amber-50 dark:bg-amber-950/60" iconColor="text-amber-600 dark:text-amber-400" />
        <PmKpiCard label="Confirmed Events" value={confirmed} icon={AlertOctagon} iconBg="bg-rose-50 dark:bg-rose-950/60" iconColor="text-rose-600 dark:text-rose-400" />
        <PmKpiCard label="Total Fuel Loss" value={`${totalLoss} L`} icon={Fuel} iconBg="bg-sky-50 dark:bg-sky-950/60" iconColor="text-sky-600 dark:text-sky-400" />
        <PmKpiCard label="Avg Drop per Event" value={`${avgDrop}%`} icon={Droplet} iconBg="bg-slate-100 dark:bg-slate-800" iconColor="text-slate-600 dark:text-slate-300" />
      </div>

      <PmCard>
        <PmSectionTitle title="Fuel Drop % by Event" subtitle="Ignition off + stationary GPS during the drop window" />
        {events && events.length > 0 ? (
          <BarList
            items={events.map((e) => ({ label: `${e.machineName}`, value: e.fuelDropPct, sub: `${e.fuelDropLiters} L`, colorClass: e.status === 'Confirmed' ? 'bg-rose-500' : e.status === 'Suspected' ? 'bg-amber-500' : 'bg-emerald-500' }))}
            valueFormatter={(v) => `${v}%`}
          />
        ) : (
          <p className="text-xs text-slate-400">Loading…</p>
        )}
      </PmCard>

      <PmCard noPadding>
        <div className="p-5 pb-0">
          <PmSectionTitle title="Suspected Fuel Theft Events" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-y border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-5">Machine</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4">Time Window</th>
                <th className="py-3 px-4">Fuel Drop</th>
                <th className="py-3 px-4">Ignition</th>
                <th className="py-3 px-4">GPS</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {!events ? (
                <tr><td colSpan={7} className="py-10 text-center text-slate-400">Loading events…</td></tr>
              ) : (
                events.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-5 font-semibold text-slate-900 dark:text-white">{e.machineName}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">{e.site}</td>
                    <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">{e.windowStart} → {e.windowEnd}</td>
                    <td className="py-3 px-4">
                      <span className="font-mono font-semibold text-rose-600 dark:text-rose-400">-{e.fuelDropPct}%</span>
                      <span className="text-[11px] text-slate-400 ml-1">({e.fuelDropLiters} L)</span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{e.ignitionStatus}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{e.gpsStatus}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${statusClasses[e.status]}`}>
                        {e.status}
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
