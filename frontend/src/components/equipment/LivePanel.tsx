import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertOctagon, ChevronDown, ChevronRight, MapPin, Radio } from 'lucide-react';
import { DateRangePicker } from 'rsuite';
import { ApiError, EquipmentFaults, FaultCode, LiveConnection, MachineLive, apiGetEquipmentFaults, apiGetMachineLive } from '../../lib/api';
import { Chip, ChipTone } from '../common/Chip';
import { Skeleton } from '../common/Skeleton';
import { appLocale, appTimeZone } from '../../lib/dateLocale';

/** How often the Live view asks again. Devices report about once a minute, so polling
 *  this often is as current as a push would be, with nothing new to run. */
export const LIVE_REFRESH_MS = 20_000;
/** Cleared fault codes shown until the reader picks a period: the last week. */
const FAULT_HISTORY_DAYS = 7;

/** The cleared codes' period: whole days of the reader's range, else the last week up to now. */
function faultPeriod(range: [Date, Date] | null): { from: Date; to: Date } {
  if (!range) {
    const to = new Date();
    return { from: new Date(to.getTime() - FAULT_HISTORY_DAYS * 86_400_000), to };
  }
  const [a, b] = range;
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
  return { from: new Date(a.getFullYear(), a.getMonth(), a.getDate()), to: end > new Date() ? new Date() : end };
}

const CONNECTION_TONE: Record<LiveConnection, ChipTone> = { online: 'emerald', delayed: 'amber', offline: 'rose', 'no-device': 'slate' };
const LAMP_TONE: Record<string, ChipTone> = { red_stop: 'rose', protect: 'rose', amber_warning: 'amber', mil: 'amber', none: 'slate' };

const CARD = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs';
const LABEL = 'text-xs font-semibold uppercase tracking-wide text-slate-500';

/**
 * The machine as it is now (Live view, 13 Nov 2026): connection, running, position, each
 * signal's newest value with its age, and the active fault codes when the device reports
 * them. Asked again every 20 s while the page is open and visible. Everything else on the
 * machine page is history over a window; this is the part that moves.
 */
export const LivePanel: React.FC<{
  sourceSystem: string;
  externalId: string;
  /** The newest values, for the digital twin's markers. */
  onLive?: (live: MachineLive) => void;
}> = ({ sourceSystem, externalId, onLive }) => {
  const { t } = useTranslation('equipment');
  const navigate = useNavigate();
  const [live, setLive] = useState<MachineLive | null>(null);
  const [faults, setFaults] = useState<EquipmentFaults | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // The cleared codes' period, chosen in the Fault codes panel. Held here, where the
  // 20 s refresh asks for faults, so a refresh keeps the reader's period.
  const [faultRange, setFaultRange] = useState<[Date, Date] | null>(null);
  const faultRangeRef = useRef(faultRange);
  faultRangeRef.current = faultRange;

  useEffect(() => {
    let alive = true;
    const load = () => {
      // A hidden tab asks nothing; it catches up the moment it is shown again.
      if (document.visibilityState === 'hidden') return;
      apiGetMachineLive(sourceSystem, externalId)
        .then((l) => { if (alive) { setLive(l); setError(undefined); onLive?.(l); } })
        .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : t('live.loadFailed')); });
      // Fault codes are their own route; a failure there leaves the values standing.
      apiGetEquipmentFaults(sourceSystem, externalId, faultPeriod(faultRangeRef.current))
        .then((f) => { if (alive) setFaults(f); })
        .catch(() => { if (alive) setFaults(null); });
    };
    load();
    const timer = window.setInterval(load, LIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
    // onLive is a page callback; re-subscribing on its identity would restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  // A new period is asked for at once, not at the next 20 s tick.
  const firstRange = useRef(true);
  useEffect(() => {
    if (firstRange.current) { firstRange.current = false; return; }
    let alive = true;
    apiGetEquipmentFaults(sourceSystem, externalId, faultPeriod(faultRange))
      .then((f) => { if (alive) setFaults(f); })
      .catch(() => {});
    return () => { alive = false; };
  }, [faultRange, sourceSystem, externalId]);

  const age = (seconds: number) => (seconds < 60 ? t('live.age.s', { n: seconds })
    : seconds < 3600 ? t('live.age.min', { n: Math.round(seconds / 60) }) : t('live.age.h', { n: Math.round(seconds / 3600) }));
  const value = (v: number | string) => (typeof v === 'number' ? v.toLocaleString(appLocale(), { maximumFractionDigits: 2 }) : v);

  if (!live && !error) return <div className={CARD}><Skeleton /></div>;
  // One age for the whole grid: the tiles all come from the same reading, and a time on
  // each said the same thing twelve times (16 Nov). A tile left behind shows it greyed.
  const newestAge = live?.signals.length ? Math.min(...live.signals.map((s) => s.ageSeconds)) : null;

  return (
    <section className="space-y-3" aria-label={t('live.title')}>
      <div className={`${CARD} space-y-3`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base flex items-center gap-2">
            <Radio className="w-4 h-4 text-sky-600" /> {t('live.title')}
          </h3>
          <span className="text-xs text-slate-500">{t('live.updates')}</span>
        </div>
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        {live && (
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={CONNECTION_TONE[live.connection]} size="md" title={t('live.connectionTitle')}>{t(`live.connection.${live.connection}`)}</Chip>
            <span className="text-xs text-slate-500">
              {live.lastReadingAt
                ? t('live.lastReading', { age: age(Math.max(0, Math.round((Date.parse(live.asOf) - Date.parse(live.lastReadingAt)) / 1000))) })
                : t('live.noReading')}
            </span>
            {live.running !== null && (
              <Chip icon={Activity} tone={live.running ? 'emerald' : 'slate'} size="md">{live.running ? t('live.running') : t('live.stopped')}</Chip>
            )}
            {live.location ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                {live.location.lat.toFixed(5)}, {live.location.lng.toFixed(5)}
                <span className="text-slate-400">· {age(live.location.ageSeconds)}</span>
                <button type="button" onClick={() => navigate('/geofence')} className="font-semibold text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                  {t('live.viewOnMap')}
                </button>
              </span>
            ) : live.connection !== 'no-device' && <span className="text-xs text-slate-400">{t('live.noLocation')}</span>}
          </div>
        )}
      </div>

      {faults?.reportsFaults && <FaultCodesPanel faults={faults} range={faultRange} onRange={setFaultRange} />}

      {live && live.connection !== 'no-device' && (
        <div className={`${CARD} space-y-2`}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className={LABEL}>{t('live.parameters')}</h4>
            {newestAge !== null && <span className="text-xs text-slate-500 dark:text-slate-400">{t('live.lastReading', { age: age(newestAge) })}</span>}
          </div>
          {live.signals.length === 0 ? (
            <p className="text-sm text-slate-400">{t('live.noSignals')}</p>
          ) : (
            // Tiles, not a table: a name stretched across the card left its value a screen
            // away from it (16 Nov). Each tile keeps its own height.
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 items-start">
              {live.signals.map((s) => (
                <li key={s.signal} title={s.stale ? t('live.staleTitle') : undefined} className="min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 p-3 space-y-1">
                  <p className="font-mono text-xs text-slate-500 dark:text-slate-400 break-all">{s.signal}</p>
                  <p className={`text-lg font-semibold tabular-nums leading-tight break-words ${s.stale ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-white'}`}>
                    {value(s.value)}{s.unit ? <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">{s.unit}</span> : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * Active fault codes, red lamp first, one card each that opens to its causes and what to
 * do. The chip says how serious the code is (Critical, Warning) in the words the pump
 * guide and the mobile app use; "red stop" and "amber warning" are a truck dashboard's
 * lamps and meant nothing on a pump (16 Nov). Its colour still comes from the lamp:
 * severityTone paints high and critical alike, and a warning is amber.
 */
const FaultCodesPanel: React.FC<{
  faults: EquipmentFaults;
  /** The cleared codes' period; null is the last seven days. */
  range: [Date, Date] | null;
  onRange: (range: [Date, Date] | null) => void;
}> = ({ faults, range, onRange }) => {
  const { t } = useTranslation('equipment');
  const [open, setOpen] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const when = (iso: string) => new Date(iso).toLocaleString(appLocale(), { timeZone: appTimeZone(), dateStyle: 'medium', timeStyle: 'short' });

  const card = (f: FaultCode, cleared: boolean) => (
    <li key={f.id} className="min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
      <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)} aria-expanded={open === f.id}
        className="w-full p-3 text-left cursor-pointer space-y-1.5">
        <span className="flex items-center justify-between gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-slate-700 dark:text-slate-200">
            {open === f.id ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
            {f.code}
          </span>
          {!cleared && <Chip tone={LAMP_TONE[f.lamp] ?? 'slate'}>{t(`faults.severity.${f.severity}`, { defaultValue: f.severity })}</Chip>}
        </span>
        <span className="block text-sm font-medium text-slate-900 dark:text-white break-words">{f.description}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">
          {cleared && f.clearedAt ? t('faults.clearedAt', { when: when(f.clearedAt) }) : t('faults.lastSeen', { when: when(f.lastSeenAt) })}
        </span>
      </button>
      {open === f.id && (
        <div className="px-3 pb-3 space-y-1.5 text-xs text-slate-600 dark:text-slate-300 break-words">
          <p>{t('faults.firstSeen', { when: when(f.firstSeenAt) })} · {t('faults.occurrences', { count: f.occurrences })}</p>
          {f.causes && <p><span className="font-semibold">{t('faults.causes')}:</span> {f.causes}</p>}
          {f.remedies && <p><span className="font-semibold">{t('faults.remedies')}:</span> {f.remedies}</p>}
          {!f.causes && !f.remedies && <p className="text-slate-500 dark:text-slate-400">{t('faults.noGuidance')}</p>}
        </div>
      )}
    </li>
  );
  // Each card keeps its own height, so one opened does not stretch its row.
  const GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 items-start';

  return (
    <div className={`${CARD} space-y-2`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className={`${LABEL} flex items-center gap-1.5`}><AlertOctagon className="w-3.5 h-3.5" /> {t('faults.title')}</h4>
        <Chip tone={faults.active.length ? 'rose' : 'emerald'}>{t('faults.activeCount', { count: faults.active.length })}</Chip>
      </div>
      {faults.active.length === 0
        ? <p className="text-sm text-slate-500 py-1">{t('faults.none')}</p>
        : <ul className={`${GRID} pt-1`}>{faults.active.map((f) => card(f, false))}</ul>}
      {/* Always offered, even with none cleared this week: older ones are a period away. */}
      <div className="pt-1 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}
            className="text-xs font-semibold text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
            {showHistory ? t('faults.hideHistory') : t('faults.showCleared', { count: faults.history.length })}
          </button>
          {showHistory && (
            <DateRangePicker size="sm" format="yyyy-MM-dd" value={range} onChange={(v) => onRange((v as [Date, Date] | null) ?? null)}
              shouldDisableDate={(d) => d.getTime() > Date.now()} placeholder={t('faults.last7Days')} aria-label={t('faults.clearedPeriod')}
              cleanable showOneCalendar placement="autoVerticalEnd" className="w-full sm:w-auto! sm:min-w-[210px]" />
          )}
        </div>
        {showHistory && (faults.history.length
          ? <ul className={GRID}>{faults.history.map((f) => card(f, true))}</ul>
          : <p className="text-sm text-slate-500 dark:text-slate-400">{t('faults.noneCleared')}</p>)}
        {showHistory && faults.historyTruncated && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('faults.truncated', { n: faults.history.length })}</p>
        )}
      </div>
    </div>
  );
};
