import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MachineExpectedFuel, MachineShiftFuelView, apiGetExpectedFuel, apiGetMachineShiftFuel,
} from '../../lib/api';

/**
 * Fuel per shift where people work, on the machine page (fuel test report TC-FP-11, C-2).
 *
 * Two answers, said apart: what the machine's class and schedule say a shift should take
 * — every input shown with its source, or the figures it is waiting for named — and D50's
 * forecast from the machine's own past shifts, with what was actually burned. The tester
 * found the forecasts only on an admin accuracy page; a machine page with neither said
 * nothing about fuel ahead at all.
 */
export function FuelPerShiftPanel({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t } = useTranslation('equipment');
  const [expected, setExpected] = useState<MachineExpectedFuel | null>(null);
  const [history, setHistory] = useState<MachineShiftFuelView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Each on its own: a role without one of them still sees the other.
    Promise.allSettled([apiGetExpectedFuel(sourceSystem, externalId), apiGetMachineShiftFuel(sourceSystem, externalId)])
      .then(([e, h]) => {
        if (!live) return;
        setExpected(e.status === 'fulfilled' ? e.value : null);
        setHistory(h.status === 'fulfilled' ? h.value : null);
        setLoading(false);
      });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const forecasted = (history?.shifts ?? []).filter((s) => s.predictedL !== null || s.fuelL !== null).slice(-4).reverse();

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{t('fuelPerShift.title')}</h3>
      {loading ? (
        <p className="text-xs text-slate-400">{t('common.loading')}</p>
      ) : (
        <>
          {expected && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-300">{t('fuelPerShift.expected')}</p>
              <p className="text-xs text-slate-400">{t('fuelPerShift.expectedHint')}</p>
              {expected.shifts.map((s, i) => (
                <div key={s.startsAt ?? i} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 space-y-1">
                  {s.shiftName && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">{s.shiftName} · {time(s.startsAt)} – {time(s.endsAt)}</p>
                  )}
                  {s.predictedL !== null ? (
                    <>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">{t('fuelPerShift.litres', { litres: s.predictedL })}</p>
                      <p className="text-xs text-slate-400">{t('fuelPerShift.split', { working: s.workingL, idle: s.idleL })}</p>
                      <p className="text-xs text-slate-400">
                        {s.workingRateFrom === 'bsfc' ? t('fuelPerShift.rateFromBsfc') : t('fuelPerShift.rateFromNominal')}
                      </p>
                      <details className="text-xs text-slate-400">
                        <summary className="cursor-pointer">{t('fuelPerShift.inputs')}</summary>
                        <ul className="mt-1 space-y-0.5">
                          {s.inputs.map((input) => (
                            <li key={input.name}>{input.name} = {input.value} {input.unit} — {input.source}</li>
                          ))}
                        </ul>
                      </details>
                    </>
                  ) : (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      <p>{t('fuelPerShift.blocked')}</p>
                      <ul className="list-disc pl-4">
                        {s.blockedBy.map((b) => <li key={b}>{t(`fuelPerShift.blocker.${b}`)}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {history && (
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-300">{t('fuelPerShift.history')}</p>
              {history.nowcast && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('fuelPerShift.inShift', { soFar: history.nowcast.soFarL, predicted: history.nowcast.predictedL })}
                </p>
              )}
              {forecasted.length === 0 ? (
                <p className="text-xs text-slate-400">{t('fuelPerShift.historyNone')}</p>
              ) : forecasted.map((s) => (
                <div key={`${s.sdate}-${s.shift}`} className="flex items-center justify-between text-xs gap-2">
                  <span className="text-slate-500 dark:text-slate-400">{time(s.startsAt)} – {time(s.endsAt)}</span>
                  <span className="text-slate-700 dark:text-slate-200">
                    {s.predictedL !== null ? t('fuelPerShift.litres', { litres: s.predictedL }) : '—'}
                    {s.fuelL !== null && <span className="text-slate-400"> · {t('fuelPerShift.actual', { litres: s.fuelL })}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
