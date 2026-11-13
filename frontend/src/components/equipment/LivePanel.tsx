import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertOctagon, ChevronDown, ChevronRight, MapPin, Radio } from 'lucide-react';
import { ApiError, EquipmentFaults, FaultCode, LiveConnection, MachineLive, apiGetEquipmentFaults, apiGetMachineLive } from '../../lib/api';
import { Chip, ChipTone } from '../common/Chip';
import { ListTable } from '../common/ListTable';
import { Skeleton } from '../common/Skeleton';
import { appLocale, appTimeZone } from '../../lib/dateLocale';

/** How often the Live view asks again. Devices report about once a minute, so polling
 *  this often is as current as a push would be, with nothing new to run. */
export const LIVE_REFRESH_MS = 20_000;

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

  useEffect(() => {
    let alive = true;
    const load = () => {
      // A hidden tab asks nothing; it catches up the moment it is shown again.
      if (document.visibilityState === 'hidden') return;
      apiGetMachineLive(sourceSystem, externalId)
        .then((l) => { if (alive) { setLive(l); setError(undefined); onLive?.(l); } })
        .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : t('live.loadFailed')); });
      // Fault codes are their own route; a failure there leaves the values standing.
      apiGetEquipmentFaults(sourceSystem, externalId)
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

  const age = (seconds: number) => (seconds < 60 ? t('live.age.s', { n: seconds })
    : seconds < 3600 ? t('live.age.min', { n: Math.round(seconds / 60) }) : t('live.age.h', { n: Math.round(seconds / 3600) }));
  const value = (v: number | string) => (typeof v === 'number' ? v.toLocaleString(appLocale(), { maximumFractionDigits: 2 }) : v);

  if (!live && !error) return <div className={CARD}><Skeleton /></div>;

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

      {faults?.reportsFaults && <FaultCodesPanel faults={faults} />}

      {live && live.connection !== 'no-device' && (
        <div className={`${CARD} space-y-2`}>
          <h4 className={LABEL}>{t('live.parameters')}</h4>
          {live.signals.length === 0 ? (
            <p className="text-sm text-slate-400">{t('live.noSignals')}</p>
          ) : (
            <ListTable bare
              columns={[
                // Narrow enough for a phone: the age is short ("25 min"), the value a number.
                { label: t('live.col.signal'), grow: 3, minWidth: 100 },
                { label: t('live.col.value'), width: 120, align: 'right' },
                { label: t('live.col.updated'), width: 80, align: 'right' },
              ]}
              rows={live.signals}
              rowKey={(s) => s.signal}
              cells={(s) => [
                <span className={`font-mono text-xs break-all ${s.stale ? 'text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>{s.signal}</span>,
                <span className={`font-semibold tabular-nums ${s.stale ? 'text-slate-400' : 'text-slate-900 dark:text-white'}`}>
                  {value(s.value)}{s.unit ? <span className="ml-1 text-xs font-normal text-slate-500">{s.unit}</span> : null}
                </span>,
                <span className={`text-xs ${s.stale ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500'}`} title={s.stale ? t('live.staleTitle') : undefined}>
                  {age(s.ageSeconds)}
                </span>,
              ]}
            />
          )}
        </div>
      )}
    </section>
  );
};

/** Active fault codes, red lamp first, each opening to its causes and what to do. */
const FaultCodesPanel: React.FC<{ faults: EquipmentFaults }> = ({ faults }) => {
  const { t } = useTranslation('equipment');
  const [open, setOpen] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const when = (iso: string) => new Date(iso).toLocaleString(appLocale(), { timeZone: appTimeZone(), dateStyle: 'medium', timeStyle: 'short' });

  const row = (f: FaultCode, cleared: boolean) => (
    <li key={f.id} className="border-t border-slate-100 dark:border-slate-800 first:border-t-0">
      <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)}
        className="w-full flex items-start justify-between gap-3 py-2.5 text-left cursor-pointer">
        <span className="min-w-0 flex items-start gap-2">
          {open === f.id ? <ChevronDown className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" />}
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-900 dark:text-white break-words">{f.description}</span>
            <span className="block text-xs text-slate-500 font-mono">{f.code}</span>
          </span>
        </span>
        <span className="flex flex-col items-end gap-1 shrink-0">
          {!cleared && <Chip tone={LAMP_TONE[f.lamp] ?? 'slate'}>{t(`faults.lamp.${f.lamp}`, { defaultValue: f.lamp })}</Chip>}
          <span className="text-xs text-slate-500">
            {cleared && f.clearedAt ? t('faults.clearedAt', { when: when(f.clearedAt) }) : t('faults.lastSeen', { when: when(f.lastSeenAt) })}
          </span>
        </span>
      </button>
      {open === f.id && (
        <div className="pb-3 pl-6 space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
          <p>{t('faults.firstSeen', { when: when(f.firstSeenAt) })} · {t('faults.occurrences', { count: f.occurrences })}</p>
          {f.causes && <p><span className="font-semibold">{t('faults.causes')}:</span> {f.causes}</p>}
          {f.remedies && <p><span className="font-semibold">{t('faults.remedies')}:</span> {f.remedies}</p>}
          {!f.causes && !f.remedies && <p className="text-slate-400">{t('faults.noGuidance')}</p>}
        </div>
      )}
    </li>
  );

  return (
    <div className={`${CARD} space-y-1`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className={`${LABEL} flex items-center gap-1.5`}><AlertOctagon className="w-3.5 h-3.5" /> {t('faults.title')}</h4>
        <Chip tone={faults.active.length ? 'rose' : 'emerald'}>{t('faults.activeCount', { count: faults.active.length })}</Chip>
      </div>
      {faults.active.length === 0
        ? <p className="text-sm text-slate-500 py-1">{t('faults.none')}</p>
        : <ul>{faults.active.map((f) => row(f, false))}</ul>}
      {faults.history.length > 0 && (
        <div className="pt-1">
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs font-semibold text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
            {showHistory ? t('faults.hideHistory') : t('faults.showHistory', { count: faults.history.length })}
          </button>
          {showHistory && <ul className="mt-1">{faults.history.map((f) => row(f, true))}</ul>}
        </div>
      )}
    </div>
  );
};
