import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, Clock3, ExternalLink, Plus } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';
import {
  ApiError, EquipmentAvailability, EquipmentProfile, UtilizationShiftRow,
  apiGetEquipmentAvailability, apiGetEquipmentUtilization, apiListEquipment,
} from '../lib/api';

const DAYS = 7;
const REASON_TEXT: Record<string, string> = {
  no_shift_schedule: 'No shift schedule configured for this machine',
  no_readings: 'No readings in this period',
};

function periodLastNDays(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export const ProductionMonitoringDetailPage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<EquipmentProfile | null>(null);
  const [availability, setAvailability] = useState<EquipmentAvailability | null>(null);
  const [shifts, setShifts] = useState<UtilizationShiftRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  usePageHeader({
    title: profile?.name ?? externalId ?? 'Machine not found',
    subtitle: 'Production Monitoring Detail',
    onBack: () => navigate('/production-monitoring'),
  });

  useEffect(() => {
    if (!sourceSystem || !externalId) return;
    let live = true;
    const { from, to } = periodLastNDays(DAYS);
    apiListEquipment().then((list) => {
      if (live) setProfile(list.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId) ?? null);
    }).catch(() => {});
    apiGetEquipmentUtilization(sourceSystem, externalId, { from, to }).then((rows) => { if (live) setShifts(rows); }).catch(() => {});
    apiGetEquipmentAvailability(sourceSystem, externalId, from, to)
      .then((a) => { if (live) { setAvailability(a); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load this machine.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Last {DAYS} days</span>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Availability</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-4">
          <RingGauge value={availability?.readiness === 'ready' ? availability.availability : null} size={72} colorClass="text-sky-500 dark:text-sky-400" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-slate-900 dark:text-white text-base truncate">{profile?.name ?? externalId}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{sourceSystem}/{externalId}</p>
            {availability?.readiness === 'ready' ? (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <Chip icon={Clock3} title="Uptime hours" size="md">{(availability.uptimeHours ?? 0).toFixed(0)}h up</Chip>
                <Chip tone={(availability.downtimeHours ?? 0) > 0 ? 'amber' : 'slate'} title="Downtime hours" size="md">{(availability.downtimeHours ?? 0).toFixed(0)}h down</Chip>
              </div>
            ) : (
              <p className="text-xs text-slate-400 mt-2">{availability?.reason ? REASON_TEXT[availability.reason] : 'Availability not available'}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
            <Plus className="w-4 h-4" /> Create work order
          </button>
          {sourceSystem && externalId && (
            <button
              onClick={() => navigate(`/admin/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/page`)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300 cursor-pointer"
            >
              <ExternalLink className="w-4 h-4" /> View equipment page
            </button>
          )}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-2">Shift history</h3>
        {shifts.length === 0 ? (
          <p className="text-sm text-slate-400">No recorded shifts in this period.</p>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[10px]">
                  <th className="px-4 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Shift</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Productive</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Idle</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Utilization</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shifts.map((s, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2.5">{s.localDate}</td>
                    <td className="px-4 py-2.5">{s.shiftName}</td>
                    <td className="px-4 py-2.5">{(s.productiveSeconds / 3600).toFixed(1)}h</td>
                    <td className="px-4 py-2.5">{(s.idleSeconds / 3600).toFixed(1)}h</td>
                    <td className="px-4 py-2.5">{s.utilizationRate != null ? `${(s.utilizationRate * 100).toFixed(0)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
