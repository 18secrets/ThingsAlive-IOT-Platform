import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fuel } from 'lucide-react';
import { FleetShiftFuel, apiGetFleetShiftFuel } from '../../lib/api';
import { Chip } from '../common/Chip';
import { ListTable } from '../common/ListTable';
import { TablePagination, usePagination } from '../common/TablePagination';
import { sortRows, useSort } from '../../lib/useSort';
import { appLocale, appTimeZone } from '../../lib/dateLocale';
import { Skeleton } from '../common/Skeleton';

const litres = (l: number) => l.toFixed(1);
/** "2026-11-03" as that calendar day, not UTC midnight moved into the reader's zone. */
const shiftDate = (sdate: string) => {
  const [y, m, d] = sdate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(appLocale(), { timeZone: appTimeZone(), day: 'numeric', month: 'short' });
};
const shiftKey = (s: { sdate: string; shift: 1 | 2 }) => `${s.sdate}|${s.shift}`;

interface Row {
  key: string;
  sourceSystem: string;
  externalId: string;
  name: string;
  /** Forecast litres by shift key. */
  byShift: Record<string, number>;
  now: { soFarL: number; predictedL: number } | null;
}

/**
 * The fleet's fuel per shift (`/shift-fuel-forecasts`), where the fleet is already read:
 * Production Monitoring. Until now fuel ahead was shown one machine at a time (fuel test
 * report TC-FP-11), and the fleet total the route sums was on no screen.
 *
 * It follows the page's filters, so its totals are always the machines the page shows;
 * they are summed here from the same forecasts the server sums. The shift under way adds
 * what the fleet is heading for now from each machine's in-shift re-forecast (D52).
 */
export const FleetFuelPanel: React.FC<{
  inScope: (sourceSystem: string, externalId: string) => boolean;
  nameOf: (sourceSystem: string, externalId: string) => string;
  onOpen: (sourceSystem: string, externalId: string) => void;
}> = ({ inScope, nameOf, onOpen }) => {
  const { t } = useTranslation('production');
  const [fleet, setFleet] = useState<FleetShiftFuel | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const { sort, toggle } = useSort<string>({ key: 'first', dir: 'desc' });

  useEffect(() => {
    let live = true;
    apiGetFleetShiftFuel()
      .then((f) => { if (live) { setFleet(f); setState('ok'); } })
      .catch(() => { if (live) setState('unavailable'); });
    return () => { live = false; };
  }, []);

  const view = useMemo(() => {
    const forecasts = (fleet?.forecasts ?? []).filter((f) => inScope(f.sourceSystem, f.externalId));
    const nowcasts = (fleet?.nowcasts ?? []).filter((n) => inScope(n.sourceSystem, n.externalId));
    const shifts = [...new Map(forecasts.map((f) => [shiftKey(f), f])).values()]
      .sort((a, b) => (a.sdate === b.sdate ? a.shift - b.shift : a.sdate < b.sdate ? -1 : 1))
      .slice(-2);
    const rows = new Map<string, Row>();
    const rowOf = (ss: string, id: string) => {
      const k = `${ss}|${id}`;
      if (!rows.has(k)) rows.set(k, { key: k, sourceSystem: ss, externalId: id, name: nameOf(ss, id), byShift: {}, now: null });
      return rows.get(k)!;
    };
    for (const f of forecasts) rowOf(f.sourceSystem, f.externalId).byShift[shiftKey(f)] = f.predictedL;
    for (const n of nowcasts) rowOf(n.sourceSystem, n.externalId).now = { soFarL: n.soFarL, predictedL: n.predictedL };
    const totals = shifts.map((s) => {
      const k = shiftKey(s);
      const mine = forecasts.filter((f) => shiftKey(f) === k);
      const running = nowcasts.filter((n) => shiftKey(n) === k);
      return {
        ...s, key: k,
        predictedL: mine.reduce((sum, f) => sum + f.predictedL, 0), machines: mine.length,
        now: running.length ? {
          predictedL: running.reduce((sum, n) => sum + n.predictedL, 0),
          soFarL: running.reduce((sum, n) => sum + n.soFarL, 0),
          machines: running.length,
        } : null,
      };
    });
    return { shifts: totals, rows: [...rows.values()] };
  }, [fleet, inScope, nameOf]);

  const [first, second] = view.shifts;
  const sorted = useMemo(() => sortRows(view.rows, sort, {
    name: (r) => r.name,
    first: (r) => (first ? r.byShift[first.key] : null),
    second: (r) => (second ? r.byShift[second.key] : null),
    now: (r) => r.now?.predictedL,
  }), [view.rows, sort, first, second]);
  const { pageItems, ...pager } = usePagination(sorted);

  const now = Date.now();
  const stateChip = (s: { startsAt: string; endsAt: string }) =>
    Date.parse(s.startsAt) > now ? <Chip tone="slate">{t('fleetFuel.next')}</Chip>
      : Date.parse(s.endsAt) > now ? <Chip tone="sky">{t('fleetFuel.running')}</Chip>
        : <Chip tone="slate">{t('fleetFuel.ended')}</Chip>;
  const label = (s: { sdate: string; shift: 1 | 2 }) => t('fleetFuel.shiftLabel', { n: s.shift, date: shiftDate(s.sdate) });
  const cell = (v: number | undefined) => (v == null ? <span className="text-slate-400">—</span> : <span className="font-mono">{litres(v)} L</span>);

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="space-y-0.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Fuel className="w-4 h-4" />{t('fleetFuel.title')}</p>
        <p className="text-xs text-slate-500">{t('fleetFuel.subtitle')}</p>
      </div>

      {state === 'loading' ? <Skeleton lines={2} />
        : state === 'unavailable' ? <p className="text-xs text-slate-500">{t('fleetFuel.unavailable')}</p>
          : view.shifts.length === 0 ? <p className="text-xs text-slate-500">{t('fleetFuel.empty')}</p> : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {view.shifts.map((s) => (
                  <div key={s.key} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400">{label(s)}</p>
                      {stateChip(s)}
                    </div>
                    <p className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{litres(s.predictedL)} L</p>
                    <p className="text-xs text-slate-500">{t('fleetFuel.machines', { count: s.machines })}</p>
                    {s.now && (
                      <p className="text-xs text-sky-700 dark:text-sky-300">
                        {t('fleetFuel.heading', { litres: litres(s.now.predictedL), soFar: litres(s.now.soFarL), count: s.now.machines })}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Column heads say only the shift: the tiles above carry its date, and a date
                  in a head was cut off on a phone. */}
              <div className="border border-slate-100 dark:border-slate-800 rounded-lg overflow-hidden">
                <ListTable bare
                  columns={[
                    { label: t('fleetFuel.col.machine'), sortKey: 'name', minWidth: 160 },
                    ...(first ? [{ label: t('fleetFuel.shiftShort', { n: first.shift }), align: 'right' as const, sortKey: 'first', minWidth: 120 }] : []),
                    ...(second ? [{ label: t('fleetFuel.shiftShort', { n: second.shift }), align: 'right' as const, sortKey: 'second', minWidth: 120 }] : []),
                    { label: t('fleetFuel.col.now'), align: 'right' as const, sortKey: 'now', minWidth: 150 },
                  ]}
                  sort={sort}
                  onSort={(key) => { toggle(key, key === 'name' ? 'asc' : 'desc'); pager.setPage(1); }}
                  rows={pageItems}
                  rowKey={(r) => r.key}
                  cells={(r) => [
                    <span><span className="font-medium">{r.name}</span> <span className="text-slate-400">{r.externalId}</span></span>,
                    ...(first ? [cell(r.byShift[first.key])] : []),
                    ...(second ? [cell(r.byShift[second.key])] : []),
                    r.now
                      ? <span className="font-mono">{t('fleetFuel.nowCell', { soFar: litres(r.now.soFarL), predicted: litres(r.now.predictedL) })}</span>
                      : <span className="text-slate-400">—</span>,
                  ]}
                  onOpen={(r) => onOpen(r.sourceSystem, r.externalId)}
                />
                <TablePagination {...pager} />
              </div>
              <p className="text-xs text-slate-500">{t('fleetFuel.note')}</p>
            </>
          )}
    </section>
  );
};
