import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from 'rsuite';
import { AlertCircle, Info, Search } from 'lucide-react';
import { ListTable } from '../components/common/ListTable';
import { LIST_PANEL, TablePagination, usePagination } from '../components/common/TablePagination';
import { sortRows, useSort } from '../lib/useSort';
import {
  ApiError, FuelAccuracyCheckpoint, FuelAccuracyLevel, MachineFuelAccuracy, ShiftFuelAccuracy, apiGetShiftFuelAccuracy,
} from '../lib/api';

/**
 * How close the shift fuel forecast (D50) and the in-shift forecast (D52) came to what was
 * burned (D53). Every figure is the server's: the page only picks dates, a level and a
 * checkpoint, so it can never disagree with the definition the API was tested against.
 *
 * It replaced a dashboard someone refreshed by hand. The numbers behind it move on their
 * own — actuals sync hourly, snapshots every quarter hour — so an open page asks again on
 * the same quarter hour rather than going stale on a wall screen.
 */

const REFRESH_MS = 15 * 60_000;
const CHECKPOINTS: FuelAccuracyCheckpoint[] = ['2', '4', '6'];
const LEVELS: FuelAccuracyLevel[] = ['day', 'shift', 'range'];
type SortKey = 'equipment' | 'actual' | 'forecast' | 'accuracy' | 'checkpoint';

const litres = (l: number) => l.toLocaleString(undefined, { maximumFractionDigits: 1 });

/** A segmented control in the look of Administration's own tab buttons, smaller. */
function Segmented<T extends string>({ value, options, onChange, label, id }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; id: string;
}) {
  return (
    <div id={id} role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-sm font-medium cursor-pointer border-l first:border-l-0 border-slate-200 dark:border-slate-700 transition-colors ${
            value === o.value
              ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A percentage with a bar under it; red under 50, where the forecast misses by more than half. */
const AccuracyCell: React.FC<{ value: number | null; didntRun: boolean }> = ({ value, didntRun }) => {
  const { t } = useTranslation('admin');
  if (didntRun) return <span className="text-slate-400 dark:text-slate-500 italic">{t('fuelAccuracy.didntRun')}</span>;
  if (value === null) return <span className="text-slate-400" title={t('fuelAccuracy.notScored')}>—</span>;
  const low = value < 50;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`font-mono font-semibold w-10 text-right ${low ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}%</span>
      <span className="w-16 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden" aria-hidden>
        <span className={`block h-full rounded-full ${low ? 'bg-rose-500' : 'bg-sky-500'}`} style={{ width: `${value}%` }} />
      </span>
    </span>
  );
};

const Tile: React.FC<{ label: string; value: string; note?: string | null; children?: React.ReactNode; id: string }> = ({
  label, value, note, children, id,
}) => (
  <div id={id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-1 min-w-0">
    <div className="flex items-start justify-between gap-2 flex-wrap">
      <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</p>
      {children}
    </div>
    <p className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{value}</p>
    {note && <p className="text-[11px] text-amber-700 dark:text-amber-400">{note}</p>}
  </div>
);

export const FuelForecastAccuracyPage: React.FC = () => {
  const { t } = useTranslation('admin');
  // null: "today", as the server reckons it in India — and the latest day with data when
  // today has nothing totalled yet. Picking a date switches to exactly the dates picked.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [level, setLevel] = useState<FuelAccuracyLevel>('day');
  const [checkpoint, setCheckpoint] = useState<FuelAccuracyCheckpoint>('2');
  const [data, setData] = useState<ShiftFuelAccuracy | null>(null);
  const [fellBackFrom, setFellBackFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const { sort, toggle } = useSort<SortKey>({ key: 'accuracy', dir: 'desc' });
  const [search, setSearch] = useState('');
  // Most of the fleet sits idle on a given day; a table led by rows that say so buries the
  // machines whose forecast there is something to say about. The tiles leave them out too.
  const [showIdle, setShowIdle] = useState(false);

  const load = useCallback(async (live: () => boolean) => {
    setLoading(true);
    try {
      let r = await apiGetShiftFuelAccuracy({ ...(range ?? {}), level });
      let fallback: string | null = null;
      // Before tonight's sync nothing of today has been totalled, and an empty page on
      // opening says nothing useful. The latest day that has data is what was asked for.
      if (!range && r.machines.length === 0 && r.latestDataDate && r.latestDataDate < r.from) {
        fallback = r.from;
        r = await apiGetShiftFuelAccuracy({ from: r.latestDataDate, to: r.latestDataDate, level });
      }
      if (!live()) return;
      setData(r);
      setFellBackFrom(fallback);
      setError(undefined);
    } catch (err) {
      if (live()) setError(err instanceof ApiError ? err.message : t('fuelAccuracy.loadFailed'));
    } finally {
      if (live()) setLoading(false);
    }
  }, [range, level, t]);

  useEffect(() => {
    let alive = true;
    const live = () => alive;
    load(live);
    const timer = window.setInterval(() => load(live), REFRESH_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [load]);

  const allMachines = data?.machines ?? [];
  const nameOf = (m: MachineFuelAccuracy) => m.name ?? m.externalId;
  const idleCount = allMachines.filter((m) => m.actualL === 0).length;
  const machines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allMachines.filter((m) => (showIdle || m.actualL > 0)
      && (!q || (m.name ?? m.externalId).toLowerCase().includes(q) || m.externalId.toLowerCase().includes(q)));
  }, [allMachines, search, showIdle]);
  const sorted = useMemo(() => sortRows(machines, sort, {
    equipment: (m) => nameOf(m),
    actual: (m) => m.actualL,
    forecast: (m) => m.forecastL,
    accuracy: (m) => m.accuracy,
    checkpoint: (m) => m.checkpoints[checkpoint],
  }), [machines, sort, checkpoint]);
  const { pageItems, ...pager } = usePagination(sorted, 20);

  const shownFrom = range?.from ?? data?.from ?? '';
  const shownTo = range?.to ?? data?.to ?? '';
  const setDate = (which: 'from' | 'to', value: string) => {
    if (!value) return;
    const next = { from: shownFrom || value, to: shownTo || value, [which]: value };
    setRange(next);
  };

  const fleet = data?.fleet;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
  const missingCheckpoint = fleet?.shiftsWithoutCheckpoint[checkpoint] ?? 0;
  const checkpointLabel = (h: FuelAccuracyCheckpoint) => t('fuelAccuracy.hours', { count: Number(h) });

  return (
    <div id="fuel-forecast-accuracy" className="space-y-3" data-purpose="fuel-forecast-accuracy">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('fuelAccuracy.title')}</h2>
        {data && (
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            {t('fuelAccuracy.updated', { time: new Date(data.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t('fuelAccuracy.totalsLine', { count: fleet?.machines ?? 0 })}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Tile id="fuel-accuracy-actual" label={t('fuelAccuracy.tiles.actual')} value={fleet ? litres(fleet.actualL) : '—'} />
        <Tile id="fuel-accuracy-forecast" label={t('fuelAccuracy.tiles.forecast')} value={fleet ? litres(fleet.forecastL) : '—'} />
        <Tile
          id="fuel-accuracy-forecast-accuracy"
          label={t('fuelAccuracy.tiles.accuracy')}
          value={pct(fleet?.accuracy)}
          note={fleet && fleet.shiftsWithoutForecast > 0 ? t('fuelAccuracy.noForecastNote', { count: fleet.shiftsWithoutForecast }) : null}
        />
        <Tile
          id="fuel-accuracy-in-shift"
          label={t('fuelAccuracy.tiles.inShift')}
          value={pct(fleet?.checkpoints[checkpoint])}
          note={missingCheckpoint > 0 ? t('fuelAccuracy.noCheckpointNote', { count: missingCheckpoint, hours: checkpointLabel(checkpoint) }) : null}
        >
          <Segmented<FuelAccuracyCheckpoint>
            id="fuel-accuracy-checkpoint"
            label={t('fuelAccuracy.checkpointLabel')}
            value={checkpoint}
            onChange={setCheckpoint}
            options={CHECKPOINTS.map((h) => ({ value: h, label: checkpointLabel(h) }))}
          />
        </Tile>
      </div>

      {fellBackFrom && data && (
        <div className="flex items-center gap-2 text-xs text-sky-800 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900 rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span>{t('fuelAccuracy.fellBack', { today: fellBackFrom, shown: data.from })}</span>
        </div>
      )}

      <div className={LIST_PANEL}>
        <div className="flex flex-wrap items-end gap-3 p-3 border-b border-slate-200 dark:border-slate-800">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">{t('fuelAccuracy.from')}</span>
            <input
              id="fuel-accuracy-from"
              type="date"
              value={shownFrom}
              max={shownTo || undefined}
              onChange={(e) => setDate('from', e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">{t('fuelAccuracy.to')}</span>
            <input
              id="fuel-accuracy-to"
              type="date"
              value={shownTo}
              min={shownFrom || undefined}
              onChange={(e) => setDate('to', e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-2.5 py-1.5 text-sm"
            />
          </label>
          <button
            id="fuel-accuracy-today"
            type="button"
            onClick={() => setRange(null)}
            className="px-3.5 py-1.5 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-300 cursor-pointer"
          >
            {t('fuelAccuracy.today')}
          </button>
          <div className="space-y-1">
            <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">{t('fuelAccuracy.countMissesPer')}</span>
            <Segmented<FuelAccuracyLevel>
              id="fuel-accuracy-level"
              label={t('fuelAccuracy.countMissesPer')}
              value={level}
              onChange={setLevel}
              options={LEVELS.map((l) => ({ value: l, label: t(`fuelAccuracy.levels.${l}`) }))}
            />
          </div>
          <div className="relative w-full sm:w-64 sm:ml-auto">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 z-10" />
            <Input
              id="fuel-accuracy-search"
              value={search}
              onChange={(v) => setSearch(v)}
              placeholder={t('fuelAccuracy.search')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 pb-1.5 cursor-pointer">
            <input id="fuel-accuracy-show-idle" type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
            {t('fuelAccuracy.showIdle', { count: idleCount })}
          </label>
          {loading && <span className="text-xs text-slate-400 pb-2">{t('fuelAccuracy.loading')}</span>}
        </div>

        {machines.length === 0 ? (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
            {loading && !data ? t('fuelAccuracy.loading') : allMachines.length > 0 ? t('fuelAccuracy.noMatch') : t('fuelAccuracy.empty')}
          </p>
        ) : (
          // Wide enough for every column, and scrolled sideways on a phone rather than squeezed.
          <div className="overflow-x-auto">
            <ListTable<MachineFuelAccuracy>
              bare
              columns={[
                { label: t('fuelAccuracy.columns.equipment'), sortKey: 'equipment', minWidth: 220 },
                { label: t('fuelAccuracy.columns.actual'), sortKey: 'actual', align: 'right', minWidth: 110 },
                { label: t('fuelAccuracy.columns.forecast'), sortKey: 'forecast', align: 'right', minWidth: 110 },
                { label: t('fuelAccuracy.columns.accuracy'), sortKey: 'accuracy', minWidth: 150 },
                { label: t('fuelAccuracy.columns.inShift', { hours: checkpointLabel(checkpoint) }), sortKey: 'checkpoint', minWidth: 170 },
              ]}
              rows={pageItems}
              rowKey={(m) => `${m.sourceSystem}|${m.externalId}`}
              sort={sort}
              onSort={(key) => toggle(key as SortKey, key === 'equipment' ? 'asc' : 'desc')}
              cells={(m) => {
                const didntRun = m.actualL === 0;
                return [
                  <span><span className="font-medium">{nameOf(m)}</span> <span className="text-slate-400">· {m.externalId}</span></span>,
                  <span className="font-mono">{litres(m.actualL)}</span>,
                  <span className="font-mono">{litres(m.forecastL)}</span>,
                  <AccuracyCell value={m.accuracy} didntRun={didntRun} />,
                  <AccuracyCell value={m.checkpoints[checkpoint]} didntRun={didntRun} />,
                ];
              }}
            />
          </div>
        )}
        {machines.length > 0 && <TablePagination {...pager} />}
      </div>

      <section id="fuel-accuracy-how" className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 text-sm text-slate-600 dark:text-slate-300">
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">{t('fuelAccuracy.how.title')}</h3>
        <ul className="list-disc pl-5 space-y-1.5">
          {(['shifts', 'actual', 'forecast', 'backfilled', 'inShift', 'formula', 'levels', 'fleet', 'didntRun'] as const).map((k) => (
            <li key={k}>{t(`fuelAccuracy.how.${k}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
};
