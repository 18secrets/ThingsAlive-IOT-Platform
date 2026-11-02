import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertCircle } from 'lucide-react';
import { DateRangePicker, SelectPicker } from 'rsuite';
import { ApiError, KpiEnvelope, KpiSeriesPoint, apiGetEquipmentKpi, apiListEquipmentKpis } from '../../lib/api';
import { Chip } from '../common/Chip';
import { Sparkline } from '../dashboard/Sparkline';
import { reasonText } from './PageWidgets';

type Preset = 'declared' | '24h' | '7d' | '30d' | 'custom';

/** Labels live under `kpiExplorer.preset.*`. */
const PRESETS: Preset[] = ['declared', '24h', '7d', '30d', 'custom'];
const HOURS: Partial<Record<Preset, number>> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

const fmt = (v: number | null) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 3 }));

/** An un-windowed request for a formula whose own window can't be resolved comes back
 *  with no window at all; that is "pick a range", not "Invalid Date". */
const windowText = (w: { from: string; to: string } | null, t: TFunction) =>
  w?.from && w.to ? `${new Date(w.from).toLocaleString()} – ${new Date(w.to).toLocaleString()}` : t('kpiExplorer.noWindow');

/**
 * One KPI for one machine over a chosen window (GET …/kpis/:formulaKey). The page's
 * widget shows the formula's declared window; this is where somebody asks "and last
 * month?". The answer carries the same readiness envelope — a window with no readings
 * says so rather than drawing a zero.
 */
export const KpiExplorer: React.FC<{ sourceSystem: string; externalId: string; initialFormulaKey?: string }> = ({
  sourceSystem, externalId, initialFormulaKey,
}) => {
  const { t } = useTranslation('equipment');
  const [formulas, setFormulas] = useState<string[]>(initialFormulaKey ? [initialFormulaKey] : []);
  const [formulaKey, setFormulaKey] = useState<string | null>(initialFormulaKey ?? null);
  // The formula's own window first, so exploring from a widget shows the widget's number.
  // Opening on seven days set a 7-day 62.5 °C beside the widget's 24-hour 84.3 °C, both
  // read as "the average", with nothing but the dates saying they differed (test report
  // MIN-6). A formula with no window of its own falls back to seven days, below.
  const [preset, setPreset] = useState<Preset>('declared');
  const [range, setRange] = useState<[Date, Date] | null>(null);
  const [result, setResult] = useState<KpiEnvelope | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  // The class's full KPI list, so a KPI whose widget can't show anything can still be explored.
  useEffect(() => {
    let live = true;
    apiListEquipmentKpis(sourceSystem, externalId)
      .then((list) => {
        if (!live) return;
        const keys = list.map((k) => k.formulaKey);
        setFormulas(keys);
        setFormulaKey((current) => current ?? keys[0] ?? null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  useEffect(() => {
    if (!formulaKey) return;
    let window: { from: string; to: string } | undefined;
    if (preset === 'custom') {
      if (!range) return;
      window = { from: range[0].toISOString(), to: range[1].toISOString() };
    } else if (HOURS[preset]) {
      const to = new Date();
      window = { from: new Date(to.getTime() - HOURS[preset]! * 3_600_000).toISOString(), to: to.toISOString() };
    }
    let live = true;
    setLoading(true);
    setError(undefined);
    apiGetEquipmentKpi(sourceSystem, externalId, formulaKey, window)
      .then((r) => {
        if (!live) return;
        // No declared window to resolve: seven days is a better first answer than "pick a range".
        if (preset === 'declared' && !r.window) { setPreset('7d'); return; }
        setResult(r);
      })
      .catch((err) => { if (live) { setResult(null); setError(err instanceof ApiError ? err.message : t('kpiExplorer.evaluateFailed')); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId, formulaKey, preset, range]);

  const series = result?.resultKind === 'series' ? (result.value as KpiSeriesPoint[] | null) ?? [] : [];
  const values = series.map((p) => p.v).filter((v): v is number => v != null);

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <SelectPicker
          size="sm"
          data={formulas.map((k) => ({ label: k, value: k }))}
          value={formulaKey}
          onChange={(v) => setFormulaKey(v ?? null)}
          searchable={formulas.length > 8}
          cleanable={false}
          placeholder={t('kpiExplorer.chooseKpi')}
          className="min-w-[220px]"
        />
        <SelectPicker
          size="sm"
          data={PRESETS.map((p) => ({ label: t(`kpiExplorer.preset.${p}`), value: p }))}
          value={preset}
          onChange={(v) => setPreset((v ?? 'declared') as Preset)}
          searchable={false}
          cleanable={false}
          className="min-w-[180px]"
        />
        {preset === 'custom' && (
          <DateRangePicker
            size="sm"
            format="yyyy-MM-dd HH:mm"
            value={range}
            onChange={(v) => setRange(v as [Date, Date] | null)}
            shouldDisableDate={(date) => date.getTime() > Date.now()}
            placeholder={t('kpiExplorer.fromTo')}
          />
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      {!formulaKey && <p className="text-slate-400">{t('kpiExplorer.noKpis')}</p>}
      {preset === 'custom' && !range && <p className="text-slate-400">{t('kpiExplorer.pickRange')}</p>}
      {loading && <p className="text-slate-500">{t('kpiExplorer.evaluating')}</p>}

      {result && !loading && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={result.readiness === 'ready' ? 'emerald' : result.readiness === 'blocked' ? 'rose' : 'amber'}>
              {result.readiness === 'ready' ? t('readiness.ready') : result.reason ? reasonText(result.reason, t) : t(`readiness.${result.readiness}`, { defaultValue: result.readiness })}
            </Chip>
            <span className="text-slate-400">{windowText(result.window, t)}</span>
            <span className="text-slate-400">
              · {t('kpiExplorer.coverage', { actual: result.coverage.actual, expected: result.coverage.expected, percent: (result.coverage.ratio * 100).toFixed(0) })}
            </span>
          </div>
          {result.missingParameters?.length ? (
            <p className="text-amber-600 dark:text-amber-400">{t('kpiExplorer.parametersNotSet', { list: result.missingParameters.join(', ') })}</p>
          ) : null}

          {result.readiness === 'ready' && result.resultKind === 'scalar' && (
            <p className="text-3xl font-bold font-mono text-slate-800 dark:text-slate-100">
              {fmt(result.value as number | null)} <span className="text-base font-normal text-slate-400">{result.unit}</span>
            </p>
          )}

          {result.readiness === 'ready' && result.resultKind === 'series' && (
            <div className="space-y-2">
              <div className="flex items-end gap-6 flex-wrap">
                <div>
                  <p className="text-[11px] text-slate-400">{t('kpiExplorer.latest')}</p>
                  <p className="text-2xl font-bold font-mono text-slate-800 dark:text-slate-100">{fmt(values[values.length - 1] ?? null)} <span className="text-sm font-normal text-slate-400">{result.unit}</span></p>
                </div>
                <div><p className="text-[11px] text-slate-400">{t('kpiExplorer.min')}</p><p className="font-mono">{fmt(values.length ? Math.min(...values) : null)}</p></div>
                <div><p className="text-[11px] text-slate-400">{t('kpiExplorer.max')}</p><p className="font-mono">{fmt(values.length ? Math.max(...values) : null)}</p></div>
                <div><p className="text-[11px] text-slate-400">{t('kpiExplorer.points')}</p><p className="font-mono">{series.length}</p></div>
              </div>
              {values.length >= 2 && <Sparkline values={values} width={560} height={80} colorClass="text-sky-600 dark:text-sky-400" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
