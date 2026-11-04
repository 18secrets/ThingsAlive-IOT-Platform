import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fuel } from 'lucide-react';
import {
  ExpectedShiftFuel, MachineExpectedFuel, MachineShiftFuel, ShiftFuelRow, apiGetExpectedFuel, apiGetMachineShiftFuel,
} from '../../lib/api';
import { Chip } from '../common/Chip';
import { PanelRow, PanelRows, shortWhen } from '../common/PanelRow';

const litres = (l: number) => l.toFixed(1);
/** "2026-11-03" as that calendar day, not UTC midnight moved into the reader's zone. */
const shiftDate = (sdate: string) => {
  const [y, m, d] = sdate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
/** The accuracy page's score for one shift (D53): 100 − the miss as a share of what burned, never below 0. */
const shiftAccuracy = (forecast: number, actual: number) => Math.max(0, 100 - Math.round((100 * Math.abs(forecast - actual)) / actual));

const SECTION = 'text-xs font-semibold uppercase tracking-wide text-slate-500';

/**
 * Fuel per shift, the one panel for it: Machine summary, the machine page and ThingsCare
 * all show this (fuel test report TC-FP-11). Machine summary had its own card beside this
 * one, so the same machine read two ways depending on the page.
 *
 * Three answers, each said apart:
 * - the shift under way: litres burned so far plus the rest of the shift's share (D52);
 * - what the class and schedule say a shift should take (D55), inputs shown, or the
 *   figures it waits for named once — not once per shift;
 * - D50's forecast from the machine's own past shifts, beside what burned and how close
 *   it came; a forecast learned from no history says so rather than "0 L" (TC-FP-09).
 */
export function FuelPerShiftPanel({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t } = useTranslation('equipment');
  const [expected, setExpected] = useState<MachineExpectedFuel | null>(null);
  const [history, setHistory] = useState<MachineShiftFuel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Each on its own: a role without one of them still sees the other.
    Promise.allSettled([apiGetExpectedFuel(sourceSystem, externalId), apiGetMachineShiftFuel(sourceSystem, externalId, 7)])
      .then(([e, h]) => {
        if (!live) return;
        setExpected(e.status === 'fulfilled' ? e.value : null);
        setHistory(h.status === 'fulfilled' ? h.value : null);
        setLoading(false);
      });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  const now = Date.now();
  const nowcast = history?.nowcast ?? null;
  // A counter last read well before the snapshot means the feed went quiet: say when it last spoke.
  const stale = nowcast != null && Date.parse(nowcast.asOf) - Date.parse(nowcast.counterAt) > 30 * 60_000;
  const past = (history?.shifts ?? []).filter((s) => s.predictedL !== null || s.fuelL !== null).slice(-4).reverse();

  const expectedShifts = expected?.shifts ?? [];
  const computed = expectedShifts.filter((s) => s.predictedL !== null);
  // Every shift waiting on the same figures: one list, not the same list under each shift.
  const blockers = [...new Set(expectedShifts.filter((s) => s.predictedL === null).flatMap((s) => s.blockedBy))];

  const shiftLabel = (r: { sdate: string; shift: 1 | 2 }) => t('fuelPerShift.shiftLabel', { n: r.shift, date: shiftDate(r.sdate) });
  const expectedLabel = (s: ExpectedShiftFuel) => [s.shiftName, s.startsAt ? shortWhen(s.startsAt) : null].filter(Boolean).join(' · ');
  const pastDetail = (r: ShiftFuelRow) => {
    const forecast = r.predictedL == null ? t('fuelPerShift.noForecast')
      : r.inputsThrough == null && r.predictedL === 0 ? t('fuelPerShift.noHistory')
        : t('fuelPerShift.forecast', { litres: litres(r.predictedL) });
    const actual = r.fuelL != null
      ? t('fuelPerShift.actualIn', { litres: litres(r.fuelL), hours: (r.workHrs ?? 0).toFixed(1) })
      : Date.parse(r.endsAt) <= now ? t('fuelPerShift.notTotalled') : null;
    return actual ? `${forecast} · ${actual}` : forecast;
  };
  const pastChip = (r: ShiftFuelRow) => {
    if (Date.parse(r.startsAt) > now) return <Chip tone="slate">{t('fuelPerShift.next')}</Chip>;
    if (Date.parse(r.endsAt) > now) return <Chip tone="sky">{t('fuelPerShift.running')}</Chip>;
    if (r.predictedL == null || r.fuelL == null || r.fuelL <= 0) return undefined;
    const a = shiftAccuracy(r.predictedL, r.fuelL);
    return <Chip tone={a >= 85 ? 'emerald' : a >= 70 ? 'amber' : 'rose'}>{t('fuelPerShift.accuracy', { pct: a })}</Chip>;
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <Fuel className="w-4 h-4" />{t('fuelPerShift.title')}
      </p>
      {loading ? (
        <p className="text-xs text-slate-500">{t('common.loading')}</p>
      ) : !expected && !history ? (
        <p className="text-xs text-slate-500">{t('fuelPerShift.unavailable')}</p>
      ) : (
        <>
          {nowcast && (
            <div className="rounded-lg border border-sky-100 dark:border-sky-900 bg-sky-50/60 dark:bg-sky-950/30 p-3 text-xs space-y-0.5">
              <p className="text-slate-500 dark:text-slate-400">{t('fuelPerShift.nowTitle', { shift: shiftLabel(nowcast) })}</p>
              <p className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{t('fuelPerShift.litres', { litres: litres(nowcast.predictedL) })}</p>
              <p className="text-slate-600 dark:text-slate-300">
                {t('fuelPerShift.nowDetail', { soFar: litres(nowcast.soFarL), rest: litres(Math.max(0, nowcast.predictedL - nowcast.soFarL)) })}
              </p>
              <p className="text-slate-500">
                {t('fuelPerShift.asOf', { time: shortWhen(nowcast.asOf) })}
                {stale ? ` · ${t('fuelPerShift.stale', { time: shortWhen(nowcast.counterAt) })}` : ''}
              </p>
            </div>
          )}

          {expected && (
            <section className="space-y-1">
              <p className={SECTION}>{t('fuelPerShift.expected')}</p>
              <p className="text-xs text-slate-500">{t('fuelPerShift.expectedHint')}</p>
              {computed.length > 0 && (
                <PanelRows>
                  {computed.map((s, i) => (
                    <PanelRow
                      key={s.startsAt ?? i}
                      title={expectedLabel(s) || t('fuelPerShift.title')}
                      detail={`${t('fuelPerShift.split', { working: litres(s.workingL ?? 0), idle: litres(s.idleL ?? 0) })} · ${s.workingRateFrom === 'bsfc' ? t('fuelPerShift.rateFromBsfc') : t('fuelPerShift.rateFromNominal')}`}
                      right={<span className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">{t('fuelPerShift.litres', { litres: litres(s.predictedL!) })}</span>}
                    />
                  ))}
                </PanelRows>
              )}
              {computed[0]?.inputs.length ? (
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer">{t('fuelPerShift.inputs')}</summary>
                  <ul className="mt-1 space-y-0.5">
                    {computed[0].inputs.map((input) => (
                      <li key={input.name}>{input.name.replace(/_/g, ' ')} = {input.value} {input.unit} · {input.source}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {blockers.length > 0 && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <p>{t('fuelPerShift.blocked')}</p>
                  <ul className="list-disc pl-4">
                    {blockers.map((b) => <li key={b}>{t(`fuelPerShift.blocker.${b}`)}</li>)}
                  </ul>
                </div>
              )}
            </section>
          )}

          {history && (
            <section className="space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
              <p className={SECTION}>{t('fuelPerShift.history')}</p>
              {past.length === 0 ? (
                <p className="text-xs text-slate-500">{t('fuelPerShift.historyNone')}</p>
              ) : (
                <>
                  <PanelRows>
                    {past.map((r) => <PanelRow key={`${r.sdate}-${r.shift}`} title={shiftLabel(r)} detail={pastDetail(r)} right={pastChip(r)} />)}
                  </PanelRows>
                  <p className="text-xs text-slate-500">{t('fuelPerShift.method')}</p>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
