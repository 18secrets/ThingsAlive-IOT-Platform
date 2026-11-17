import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock3, Plus } from 'lucide-react';
import { DateRangePicker } from 'rsuite';
import { useGoBack } from '../lib/useGoBack';
import { useRaiseWorkOrder } from '../lib/workOrderPrefill';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RingGauge } from '../components/common/RingGauge';
import { MachineLinks } from '../components/common/MachineLinks';
import { Chip } from '../components/common/Chip';
import {
  ApiError, EquipmentAvailability, EquipmentOee, EquipmentProfile, OeeFactor,
  OeeWindow, UtilizationShiftRow, apiGetEquipmentAvailability, apiGetEquipmentKpi, apiGetEquipmentOee,
  apiGetEquipmentUtilization, apiListEquipment,
} from '../lib/api';
import { appLocale, appTimeZone } from '../lib/dateLocale';
import { Skeleton } from '../components/common/Skeleton';

/** The fuel rate KPI the machine page and Signal Bindings show (fuel test report FU-4). */
const FUEL_RATE_KPI = 'avg_fuel_consumption';

const DAYS = 7;

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** "Performance and Quality" in the reader's language; a plain comma where the browser has no list rules for it. */
const listOf = (items: string[], lang?: string) => {
  try { return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
};

/** The API says "parameter_not_set" for both Performance and Quality; what is missing differs
 *  (the class's running signals; the nominal fuel per hour), so each says its own. */
const reasonText = (kind: string, reason: string | undefined, t: (k: string, o?: Record<string, unknown>) => string) =>
  !reason ? t('common.notAvailable')
    : reason === 'parameter_not_set' && kind !== 'availability' ? t(`oeeReason.${kind}_not_set`)
      : t(`oeeReason.${reason}`, { defaultValue: reason });

const FactorTile: React.FC<{ kind: 'availability' | 'performance' | 'quality'; label: string; factor: OeeFactor; children?: React.ReactNode; reasonShown?: boolean }> = ({ kind, label, factor, children, reasonShown }) => {
  const { t } = useTranslation('production');
  return (
    <div className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {factor.readiness === 'ready' ? (
        <p className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">{pct(factor.value)}</p>
      ) : reasonShown ? (
        <p className="text-xl font-bold font-mono text-slate-300 dark:text-slate-600">—</p>
      ) : (
        <p className="text-xs text-slate-400">{reasonText(kind, factor.reason, t)}</p>
      )}
      {children}
    </div>
  );
};

/** OEE for one machine (QOEE1): the three factors it multiplies, each standing or
 *  falling on its own, and the breakdowns that took Performance down. */
function OeeSection({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t, i18n } = useTranslation('production');
  const [oeeWindow, setOeeWindow] = useState<OeeWindow>('day');
  // Dates picked instead of a window (test report P3-D4): whole days, the last one to its end.
  const [range, setRange] = useState<[Date, Date] | null>(null);
  const [oee, setOee] = useState<EquipmentOee | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // The fuel rate for this same window, from the same KPI the machine page and Signal
  // Bindings read (FU-4): one computation, so the three screens cannot show three numbers.
  const [fuelRate, setFuelRate] = useState<{ value: number; unit: string } | null>(null);
  // The rows the count above was made from, in the same response — a separate fetch
  // could land late or fail and leave "7 breakdowns" beside "none recorded".
  const breakdowns = oee?.breakdowns ?? [];
  const waitingOn = oee ? ([['availability', oee.availability], ['performance', oee.performance], ['quality', oee.quality]] as const)
    .filter(([, f]) => f.readiness !== 'ready').map(([k]) => t(`oee.${k}`)) : [];
  // All three out for the same reason ("no readings in this window"): said once, under the ring.
  const sharedReason = oee && [oee.availability, oee.performance, oee.quality]
    .every((f) => f.readiness !== 'ready' && f.reason && f.reason === oee.availability.reason) ? oee.availability.reason : null;

  useEffect(() => {
    let live = true;
    setError(undefined);
    // The previous window's numbers must not stand under the newly selected one.
    setOee(null);
    const period = range
      ? { from: new Date(range[0].getFullYear(), range[0].getMonth(), range[0].getDate()),
        to: new Date(range[1].getFullYear(), range[1].getMonth(), range[1].getDate() + 1) }
      : oeeWindow;
    apiGetEquipmentOee(sourceSystem, externalId, period)
      .then((result) => { if (live) setOee(result); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.loadOee')); });
    return () => { live = false; };
  }, [sourceSystem, externalId, oeeWindow, range]);

  useEffect(() => {
    let live = true;
    setFuelRate(null);
    if (!oee) return () => { live = false; };
    // A class without the KPI, or a window it cannot answer, simply shows no line.
    apiGetEquipmentKpi(sourceSystem, externalId, FUEL_RATE_KPI, { from: oee.from, to: oee.to })
      .then((k) => { if (live && k.readiness === 'ready' && typeof k.value === 'number') setFuelRate({ value: k.value, unit: k.unit }); })
      .catch(() => {});
    return () => { live = false; };
  }, [sourceSystem, externalId, oee]);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('oee.title')}</h3>
          <p className="text-xs text-slate-400">
            {range ? t('oee.formulaRange') : t('oee.formula', { window: t(`oee.windowUnit.${oeeWindow}`) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            {(['day', 'week', 'month'] as OeeWindow[]).map((w) => (
              <button
                key={w}
                onClick={() => { setRange(null); setOeeWindow(w); }}
                className={`px-3 py-1.5 text-xs font-semibold cursor-pointer ${!range && oeeWindow === w ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              >
                {t(`oee.window.${w}`)}
              </button>
            ))}
          </div>
          <DateRangePicker
            size="sm"
            format="yyyy-MM-dd"
            value={range}
            onChange={(v) => setRange((v as [Date, Date] | null) ?? null)}
            // The server takes up to 92 days and nothing after today.
            shouldDisableDate={(date) => date.getTime() > Date.now()}
            placeholder={t('oee.pickDates')}
            cleanable
            className="w-full sm:w-auto! sm:min-w-[220px]"
          />
        </div>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {!oee && !error && <Skeleton lines={2} />}

      {oee && (
        <>
          {/* The OEE once, in its ring, with the three factors it multiplies beside it on the same
              row. Not worked out: say which factor it waits on — each tile already gives its own
              reason, which used to be repeated here as well. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="flex flex-col items-center justify-center gap-1.5 text-center rounded-lg bg-slate-50 dark:bg-slate-800/40 p-3">
              <RingGauge value={oee.oee.value != null ? oee.oee.value * 100 : null} size={72} colorClass="text-emerald-500 dark:text-emerald-400" />
              <p className="text-xs text-slate-400">
                {oee.oee.readiness === 'ready'
                  ? `${new Date(oee.from).toLocaleString(appLocale(), { timeZone: appTimeZone() })} – ${new Date(oee.to).toLocaleString(appLocale(), { timeZone: appTimeZone() })}`
                  : sharedReason
                    ? t(`oeeReason.${sharedReason}`, { defaultValue: sharedReason })
                    : waitingOn.length
                    ? t('oee.waitingOn', { factors: listOf(waitingOn, i18n.resolvedLanguage) })
                    : oee.oee.reason ? t(`oeeReason.${oee.oee.reason}`, { defaultValue: oee.oee.reason }) : t('common.oeeNotAvailable')}
              </p>
            </div>
            <FactorTile kind="availability" label={t('oee.availability')} factor={oee.availability} reasonShown={!!sharedReason}>
              <p className="text-xs text-slate-400">
                {oee.availability.availableMinutes != null
                  ? t('oee.availableOfScheduled', { available: Math.round(oee.availability.availableMinutes), scheduled: Math.round(oee.availability.scheduledMinutes) })
                  : t('oee.scheduled', { scheduled: Math.round(oee.availability.scheduledMinutes) })}
              </p>
            </FactorTile>
            <FactorTile kind="performance" label={t('oee.performance')} factor={oee.performance} reasonShown={!!sharedReason}>
              <p className="text-xs text-slate-400">
                {t('oee.breakdowns', { count: oee.performance.breakdownCount, minutes: Math.round(oee.performance.breakdownMinutes) })}
                {oee.performance.openBreakdown ? ` · ${t('oee.oneOngoing')}` : ''}
              </p>
              {oee.performance.thresholdMinutes != null && (
                <p className="text-xs text-slate-400">
                  {oee.performance.parameterSource
                    ? t('oee.idleThresholdSetBy', { minutes: oee.performance.thresholdMinutes, source: t(`source.${oee.performance.parameterSource}`) })
                    : t('oee.idleThreshold', { minutes: oee.performance.thresholdMinutes })}
                </p>
              )}
              {oee.performance.warning && <p className="text-xs text-amber-600 dark:text-amber-400">{oee.performance.warning}</p>}
            </FactorTile>
            <FactorTile kind="quality" label={t('oee.quality')} factor={oee.quality} reasonShown={!!sharedReason}>
              {oee.quality.nominalFuel != null && oee.quality.actualFuel != null && (
                <p className="text-xs text-slate-400">
                  {t('oee.burnedVsNominal', { actual: oee.quality.actualFuel.toFixed(1), unit: oee.quality.unit, nominal: oee.quality.nominalFuel.toFixed(1) })}
                </p>
              )}
              {fuelRate && (
                <p className="text-xs text-slate-500 dark:text-slate-300">
                  {t('oee.fuelRateWhileRunning', { rate: fuelRate.value.toFixed(1), unit: fuelRate.unit })}
                </p>
              )}
              {oee.quality.wasteLitres != null && oee.quality.wasteLitres > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{t('oee.overNominal', { litres: oee.quality.wasteLitres.toFixed(1) })}</p>
              )}
              {/* The rate and where it came from, so "OEM figure" can be checked (FU-5). */}
              {oee.quality.nominalOrigin?.kind === 'library' && oee.quality.nominalFuelPerHour != null ? (
                <>
                  <p className="text-xs text-slate-400">
                    {t('oee.nominalFromLibrary', {
                      rate: oee.quality.nominalFuelPerHour, unit: oee.quality.nominalRateUnit ?? '',
                      className: oee.quality.nominalOrigin.className, version: oee.quality.nominalOrigin.classVersion,
                    })}
                  </p>
                  <p className={`text-xs ${oee.quality.nominalOrigin.citation ? 'text-slate-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {oee.quality.nominalOrigin.citation
                      ? t('oee.nominalCitation', { citation: oee.quality.nominalOrigin.citation })
                      : t('oee.nominalNoCitation')}
                  </p>
                </>
              ) : oee.quality.nominalOrigin?.kind === 'parameter' && oee.quality.nominalFuelPerHour != null ? (
                <p className="text-xs text-slate-400">
                  {t('oee.nominalFromParameter', {
                    rate: oee.quality.nominalFuelPerHour, unit: oee.quality.nominalRateUnit ?? '',
                    source: t(`source.${oee.quality.nominalOrigin.scope}`),
                  })}
                </p>
              ) : oee.quality.parameterSource && (
                <p className="text-xs text-slate-400">{t('oee.nominalSetBy', { source: t(`source.${oee.quality.parameterSource}`) })}</p>
              )}
              {/* The OEM figure is the fallback when nobody set a nominal: say where to set one
                  (fuel test report TC-FP-05 found it "unnamed", with Cost Admin left empty). */}
              {oee.quality.parameterSource === 'oem' && (
                <p className="text-xs text-slate-400">{t('oee.nominalOverride')}</p>
              )}
            </FactorTile>
          </div>

          {/* Listed only when there are some: Performance already says "0 breakdowns". */}
          {breakdowns.length > 0 && <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('oee.breakdownsInWindow')}</p>
            {(
              breakdowns.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 text-xs border border-slate-100 dark:border-slate-800 rounded-lg px-3 py-2">
                  <span className="text-slate-600 dark:text-slate-300">
                    {new Date(b.startedAt).toLocaleString(appLocale(), { timeZone: appTimeZone() })} – {b.endedAt ? new Date(b.endedAt).toLocaleTimeString(appLocale(), { timeZone: appTimeZone() }) : t('oee.ongoing')}
                  </span>
                  <Chip tone={b.endedAt ? 'amber' : 'rose'}>{b.durationMinutes != null ? `${b.durationMinutes} min` : t('oee.ongoing')}</Chip>
                </div>
              ))
            )}
          </div>}
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
  const raiseWorkOrder = useRaiseWorkOrder();
  const goBack = useGoBack('/production-monitoring');
  const { t } = useTranslation('production');
  const [profile, setProfile] = useState<EquipmentProfile | null>(null);
  const [availability, setAvailability] = useState<EquipmentAvailability | null>(null);
  const [shifts, setShifts] = useState<UtilizationShiftRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  usePageHeader({
    breadcrumb: t('translation:sidebar.productionMonitoring'),
    title: profile?.name ?? externalId ?? t('page.machineNotFound'),
    subtitle: t('page.detailSubtitle'),
    onBack: goBack,
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.loadMachine')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (loading) return <Skeleton />;

  return (
    <div className="space-y-3">
      {/* The same top as ThingsCare's and Machine summary's: the banner is the page's heading
          only, and one card carries the machine, its main figures, its links and the action. */}
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('hero.lastDays', { count: DAYS })}</span>
        <h2 className="text-xl font-bold">{t('hero.title')}</h2>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-2">
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-white text-base truncate">{profile?.name ?? externalId}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{sourceSystem}/{externalId}</p>
            </div>
            {/* Up and down hours over the last 7 days. Its availability % is not repeated here:
                the OEE section below gives Availability for the period it shows. */}
            {availability?.readiness === 'ready' ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip icon={Clock3} title={t('common.uptimeTitle')} size="md">{t('common.hoursUp', { hours: (availability.uptimeHours ?? 0).toFixed(0) })}</Chip>
                <Chip tone={(availability.downtimeHours ?? 0) > 0 ? 'amber' : 'slate'} title={t('common.downtimeTitle')} size="md">{t('common.hoursDown', { hours: (availability.downtimeHours ?? 0).toFixed(0) })}</Chip>
                <span className="text-xs text-slate-400">{t('detail.lastDays', { count: DAYS })}</span>
              </div>
            ) : (
              <p className="text-xs text-slate-400">{availability?.reason ? t(`detailReason.${availability.reason}`, { defaultValue: availability.reason }) : t('detail.availabilityNotAvailable')}</p>
            )}
            {sourceSystem && externalId && <MachineLinks sourceSystem={sourceSystem} externalId={externalId} current="production" />}
          </div>
          <button onClick={() => raiseWorkOrder({
            machine: { sourceSystem: sourceSystem!, externalId: externalId!, name: profile?.name }, from: 'production',
            downtime: availability?.readiness === 'ready' ? { hours: availability.downtimeHours ?? 0, days: DAYS } : null,
          })} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer shrink-0">
            <Plus className="w-4 h-4" /> {t('common.createWorkOrder')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {sourceSystem && externalId && <OeeSection sourceSystem={sourceSystem} externalId={externalId} />}

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-2">{t('shifts.title')}</h3>
        {shifts.length === 0 ? (
          <p className="text-sm text-slate-400">{t('shifts.empty')}</p>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[0.6875rem]">
                  <th className="px-4 py-2.5 text-left font-semibold">{t('shifts.col.date')}</th>
                  <th className="px-4 py-2.5 text-left font-semibold">{t('shifts.col.shift')}</th>
                  <th className="px-4 py-2.5 text-left font-semibold">{t('shifts.col.productive')}</th>
                  <th className="px-4 py-2.5 text-left font-semibold">{t('shifts.col.idle')}</th>
                  <th className="px-4 py-2.5 text-left font-semibold">{t('shifts.col.utilization')}</th>
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
