import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateRangePicker } from 'rsuite';
import { AlertTriangle, CheckCircle2, History, Power, ShieldAlert, Zap } from 'lucide-react';
import {
  AlertRule, EffectiveParameter, MachineEventKind, MachineEvents, SignalThresholdParams,
  apiGetEffectiveParameters, apiGetMachineEvents, apiListAlertRules, apiListEquipment,
} from '../../lib/api';
import { appLocale, appTimeZone } from '../../lib/dateLocale';
import { Chip, ChipTone } from '../common/Chip';
import { Skeleton } from '../common/Skeleton';

/**
 * Two panels for a motor or pump on its machine page (Crompton POC, 11 Nov).
 *
 * RatedAlertsPanel: D59 left open that "nothing yet shows, per machine, that a rated rule is
 * idle for want of a rating". A rule written as 1.2 × rated current fires on nothing for a
 * machine whose model has no rated current, and said nothing. This lists each rated rule
 * that applies, with the bound it works out to, or the rating it is waiting for.
 *
 * MachineEventsPanel: the pump's starts, trips and voltage events as one dated list (U6).
 */

const panel = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3';

function appliesTo(rule: AlertRule, m: { sourceSystem: string; externalId: string; classSlug: string | null; plantId: string | null }): boolean {
  if (!rule.enabled) return false;
  switch (rule.appliesTo) {
    case 'account': return true;
    case 'plant': return !!m.plantId && rule.plantId === m.plantId;
    case 'equipment': return rule.sourceSystem === m.sourceSystem && rule.externalId === m.externalId;
    case 'equipment-class': return !!m.classSlug && rule.equipmentClassSlug === m.classSlug;
    default: return false;
  }
}

const fmt = (n: number) => Number(n.toFixed(2)).toString();

export const RatedAlertsPanel: React.FC<{
  sourceSystem: string; externalId: string; classSlug: string | null; plantId: string | null;
}> = ({ sourceSystem, externalId, classSlug, plantId }) => {
  const { t } = useTranslation('equipment');
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [params, setParams] = useState<Map<string, EffectiveParameter> | null>(null);

  useEffect(() => {
    let live = true;
    apiListAlertRules().then((r) => { if (live) setRules(r); }).catch(() => { if (live) setRules([]); });
    // Ratings resolve per machine, nameplate first, then its model (D57): the machine's own
    // effective parameters are exactly what the alert reads.
    apiListEquipment()
      .then((list) => list.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId))
      .then((profile) => (profile ? apiGetEffectiveParameters({ scope: 'equipment', scopeRef: profile.id }) : []))
      .then((p) => { if (live) setParams(new Map(p.map((x) => [x.name, x]))); })
      .catch(() => { if (live) setParams(new Map()); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  const rated = useMemo(() => (rules ?? [])
    .filter((r) => r.trigger === 'signal-threshold' && (r.params as SignalThresholdParams).rating)
    .filter((r) => appliesTo(r, { sourceSystem, externalId, classSlug, plantId })), [rules, sourceSystem, externalId, classSlug, plantId]);

  if (rules === null || params === null) return null;
  if (rated.length === 0) return null;
  const idle = rated.filter((r) => typeof params.get((r.params as SignalThresholdParams).rating!)?.value !== 'number').length;

  return (
    <div className={panel}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-slate-400" /> {t('rated.title')}
        </h3>
        {idle > 0
          ? <Chip tone="amber">{t('rated.idleCount', { count: idle })}</Chip>
          : <Chip tone="emerald">{t('rated.allLive')}</Chip>}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('rated.hint')}</p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rated.map((r) => {
          const p = r.params as SignalThresholdParams;
          const rating = params.get(p.rating!);
          const value = typeof rating?.value === 'number' ? rating.value : null;
          const unit = rating?.unit ?? '';
          const bound = (m: number | null | undefined, word: 'above' | 'below') => (m === null || m === undefined || value === null ? null
            : t(`rated.${word}`, { multiple: fmt(m), rating: p.rating, value: fmt(m * value), unit }));
          return (
            <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-800 dark:text-slate-100 break-words">{r.name}</p>
                {value !== null ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {[bound(p.max, 'above'), bound(p.min, 'below')].filter(Boolean).join(' · ')}
                    {rating?.source && <span className="text-slate-400"> · {t(`rated.from.${rating.source.scope}`, { defaultValue: rating.source.scope })}</span>}
                  </p>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{t('rated.missing', { rating: p.rating })}</p>
                )}
              </div>
              <div className="shrink-0">
                {value !== null
                  ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" />{t('rated.live')}</span>
                  : <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="w-3.5 h-3.5" />{t('rated.idle')}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const EVENT_TONE: Record<MachineEventKind, ChipTone> = {
  start: 'slate', trip_overload: 'rose', trip_overtemp: 'rose', trip_supply: 'amber', voltage_low: 'amber', voltage_high: 'amber',
};
const EVENT_ICON: Record<MachineEventKind, React.FC<{ className?: string }>> = {
  start: Power, trip_overload: AlertTriangle, trip_overtemp: AlertTriangle, trip_supply: Zap, voltage_low: Zap, voltage_high: Zap,
};

export const MachineEventsPanel: React.FC<{ sourceSystem: string; externalId: string }> = ({ sourceSystem, externalId }) => {
  const { t } = useTranslation('equipment');
  const [data, setData] = useState<MachineEvents | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<[Date, Date] | null>(null);
  const [kind, setKind] = useState<'all' | 'trips' | 'starts' | 'voltage'>('all');

  useEffect(() => {
    let live = true;
    setData(null); setFailed(false);
    const window = range ? { from: new Date(range[0].getFullYear(), range[0].getMonth(), range[0].getDate()),
      to: new Date(range[1].getFullYear(), range[1].getMonth(), range[1].getDate() + 1) } : undefined;
    apiGetMachineEvents(sourceSystem, externalId, window)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [sourceSystem, externalId, range]);

  // A machine whose logger writes none of these signals is not a motor: no panel at all.
  if (data && ['starts', 'trips', 'voltage'].every((k) => data.unavailable.some((u) => u.kind === k && u.reason === 'unbound'))) return null;
  if (failed) return null;

  const shown = (data?.events ?? []).filter((e) => kind === 'all'
    || (kind === 'trips' && e.kind.startsWith('trip_')) || (kind === 'starts' && e.kind === 'start')
    || (kind === 'voltage' && e.kind.startsWith('voltage_')));
  const when = (iso: string) => new Date(iso).toLocaleString(appLocale(), { timeZone: appTimeZone(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className={panel}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-2">
          <History className="w-4 h-4 text-slate-400" /> {t('events.title')}
        </h3>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            {(['all', 'trips', 'starts', 'voltage'] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                className={`px-2.5 py-1 text-xs font-semibold cursor-pointer ${kind === k ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                {t(`events.filter.${k}`)}
              </button>
            ))}
          </div>
          <DateRangePicker size="sm" format="yyyy-MM-dd" value={range} onChange={(v) => setRange((v as [Date, Date] | null) ?? null)}
            shouldDisableDate={(d) => d.getTime() > Date.now()} placeholder={t('events.lastDay')} cleanable className="w-full sm:w-auto! sm:min-w-[210px]" />
        </div>
      </div>
      {data?.unavailable.map((u) => (
        <p key={u.kind} className="text-xs text-slate-400">{t(`events.unavailable.${u.kind}.${u.reason}`)}</p>
      ))}
      {!data ? <Skeleton lines={3} /> : shown.length === 0 ? (
        <p className="text-sm text-slate-400">{t('events.none')}</p>
      ) : (
        <ul className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 pr-1">
          {shown.map((e, i) => {
            const Icon = EVENT_ICON[e.kind];
            return (
              <li key={`${e.at}-${e.kind}-${i}`} className="py-1.5 flex items-center gap-3 text-sm">
                <span className="text-xs text-slate-400 w-28 shrink-0 tabular-nums">{when(e.at)}</span>
                <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="flex-1 min-w-0 text-slate-700 dark:text-slate-200 break-words">
                  {t(`events.kind.${e.kind}`, { count: e.value, value: fmt(e.value), limit: e.limit !== undefined ? fmt(e.limit) : '' })}
                </span>
                <Chip tone={EVENT_TONE[e.kind]}>{t(`events.tag.${e.kind.startsWith('trip_') ? 'trip' : e.kind.startsWith('voltage_') ? 'voltage' : 'start'}`)}</Chip>
              </li>
            );
          })}
        </ul>
      )}
      {data?.truncated && <p className="text-xs text-slate-400">{t('events.truncated')}</p>}
    </div>
  );
};
