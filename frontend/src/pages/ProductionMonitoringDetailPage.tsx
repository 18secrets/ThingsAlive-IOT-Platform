import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, Clock3, ExternalLink, Plus } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';
import {
  ApiError, BreakdownEvent, EquipmentAvailability, EquipmentOee, EquipmentProfile, OeeFactor, OeeParameterSource,
  OeeWindow, UtilizationShiftRow, apiGetBreakdowns, apiGetEquipmentAvailability, apiGetEquipmentOee,
  apiGetEquipmentUtilization, apiListEquipment,
} from '../lib/api';

const DAYS = 7;
const REASON_TEXT: Record<string, string> = {
  no_shift_schedule: 'No shift schedule configured for this machine',
  no_readings: 'No readings in this period',
};

const OEE_REASON_TEXT: Record<string, string> = {
  no_shift_schedule: 'No shift schedule for this machine',
  no_readings: 'No readings in this window',
  parameter_not_set: 'A required parameter is not set',
  insufficient_coverage: 'Not enough readings to judge',
  unbound: 'The signal it needs is not bound',
  unit_mismatch: 'Fuel units do not match the nominal figure',
  stale: 'Readings are stale',
  undefined_result: 'No available time to measure against',
  not_available: 'Not available',
};

const SOURCE_TEXT: Record<OeeParameterSource, string> = {
  equipment: 'this machine', class: 'its class', site: 'its site', client: 'the account', oem: 'the OEM figure',
};

const WINDOW_LABEL: Record<OeeWindow, string> = { day: 'Today', week: 'This week', month: 'This month' };

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

const FactorTile: React.FC<{ label: string; factor: OeeFactor; children?: React.ReactNode }> = ({ label, factor, children }) => (
  <div className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 space-y-1">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    {factor.readiness === 'ready' ? (
      <p className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">{pct(factor.value)}</p>
    ) : (
      <p className="text-xs text-slate-400">{OEE_REASON_TEXT[factor.reason ?? ''] ?? factor.reason ?? 'Not available'}</p>
    )}
    {children}
  </div>
);

/** OEE for one machine (QOEE1): the three factors it multiplies, each standing or
 *  falling on its own, and the breakdowns that took Performance down. */
function OeeSection({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const [oeeWindow, setOeeWindow] = useState<OeeWindow>('day');
  const [oee, setOee] = useState<EquipmentOee | null>(null);
  const [breakdowns, setBreakdowns] = useState<BreakdownEvent[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setError(undefined);
    apiGetEquipmentOee(sourceSystem, externalId, oeeWindow)
      .then((result) => {
        if (!live) return;
        setOee(result);
        // Same window the OEE was computed over, so the list explains the number above it.
        return apiGetBreakdowns(sourceSystem, externalId, result.from, result.to)
          .then((rows) => { if (live) setBreakdowns(rows); });
      })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load OEE.'); });
    return () => { live = false; };
  }, [sourceSystem, externalId, oeeWindow]);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Overall Equipment Effectiveness</h3>
          <p className="text-xs text-slate-400">Availability × Performance × Quality · UTC {oeeWindow}</p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
          {(['day', 'week', 'month'] as OeeWindow[]).map((w) => (
            <button
              key={w}
              onClick={() => setOeeWindow(w)}
              className={`px-3 py-1.5 text-xs font-semibold cursor-pointer ${oeeWindow === w ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {oee && (
        <>
          <div className="flex items-center gap-4">
            <RingGauge value={oee.oee.value != null ? oee.oee.value * 100 : null} size={72} colorClass="text-emerald-500 dark:text-emerald-400" />
            <div>
              <p className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{oee.oee.readiness === 'ready' ? pct(oee.oee.value) : '—'}</p>
              <p className="text-xs text-slate-400">
                {oee.oee.readiness === 'ready'
                  ? `${new Date(oee.from).toLocaleString()} – ${new Date(oee.to).toLocaleString()}`
                  : OEE_REASON_TEXT[oee.oee.reason ?? ''] ?? 'OEE not available'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FactorTile label="Availability" factor={oee.availability}>
              <p className="text-[11px] text-slate-400">
                {oee.availability.availableMinutes != null ? `${Math.round(oee.availability.availableMinutes)} of ` : ''}{Math.round(oee.availability.scheduledMinutes)} scheduled min
              </p>
            </FactorTile>
            <FactorTile label="Performance" factor={oee.performance}>
              <p className="text-[11px] text-slate-400">
                {oee.performance.breakdownCount} breakdown{oee.performance.breakdownCount === 1 ? '' : 's'} · {Math.round(oee.performance.breakdownMinutes)} min
                {oee.performance.openBreakdown ? ' · one ongoing' : ''}
              </p>
              {oee.performance.thresholdMinutes != null && (
                <p className="text-[11px] text-slate-400">
                  Idle over {oee.performance.thresholdMinutes} min counts{oee.performance.parameterSource ? `, set by ${SOURCE_TEXT[oee.performance.parameterSource]}` : ''}
                </p>
              )}
              {oee.performance.warning && <p className="text-[11px] text-amber-600 dark:text-amber-400">{oee.performance.warning}</p>}
            </FactorTile>
            <FactorTile label="Quality" factor={oee.quality}>
              {oee.quality.nominalFuel != null && oee.quality.actualFuel != null && (
                <p className="text-[11px] text-slate-400">
                  {oee.quality.actualFuel.toFixed(1)} {oee.quality.unit} burned vs {oee.quality.nominalFuel.toFixed(1)} nominal
                </p>
              )}
              {oee.quality.wasteLitres != null && oee.quality.wasteLitres > 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">{oee.quality.wasteLitres.toFixed(1)} L over nominal</p>
              )}
              {oee.quality.parameterSource && (
                <p className="text-[11px] text-slate-400">Nominal set by {SOURCE_TEXT[oee.quality.parameterSource]}</p>
              )}
            </FactorTile>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Breakdowns in this window</p>
            {breakdowns.length === 0 ? (
              <p className="text-xs text-slate-400">None recorded.</p>
            ) : (
              breakdowns.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 text-xs border border-slate-100 dark:border-slate-800 rounded-lg px-3 py-2">
                  <span className="text-slate-600 dark:text-slate-300">
                    {new Date(b.startedAt).toLocaleString()} – {b.endedAt ? new Date(b.endedAt).toLocaleTimeString() : 'ongoing'}
                  </span>
                  <Chip tone={b.endedAt ? 'amber' : 'rose'}>{b.durationMinutes != null ? `${b.durationMinutes} min` : 'ongoing'}</Chip>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

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

      {sourceSystem && externalId && <OeeSection sourceSystem={sourceSystem} externalId={externalId} />}

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
