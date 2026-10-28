import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ApiError, PredictionSignalDetail, apiGetPredictionSignalDetail } from '../../lib/api';

const WINDOWS = [24, 72, 168] as const;

// Hex rather than Tailwind classes: recharts paints SVG attributes, which a class
// cannot reach. These are the 500 shades the card's chips already use, chosen because
// they read on both the light and the dark card background.
const C = { line: '#0ea5e9', range: '#0ea5e9', normal: '#10b981', warning: '#f59e0b', critical: '#f43f5e', axis: '#94a3b8', mean: '#64748b' };

const fmt = (v: number | null | undefined, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');

/**
 * One signal of one scenario, opened from its row on the scenario card: what the
 * readings did, the band the scorer called normal, and where warning and critical
 * start. Every line drawn is one the API says the verdict was judged against; nothing
 * is recomputed here, so an override on this machine shows up as it was applied.
 */
export const SignalDrilldown: React.FC<{
  sourceSystem: string;
  externalId: string;
  clientScenarioSlug: string;
  signal: string;
}> = ({ sourceSystem, externalId, clientScenarioSlug, signal }) => {
  const { t } = useTranslation('care');
  const [hours, setHours] = useState<number>(72);
  const [detail, setDetail] = useState<PredictionSignalDetail | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGetPredictionSignalDetail(sourceSystem, externalId, clientScenarioSlug, signal, hours)
      .then((d) => { if (live) { setDetail(d); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('drill.loadError')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId, clientScenarioSlug, signal, hours, t]);

  const data = useMemo(() => (detail?.readings ?? []).map((r) => ({
    t: new Date(r.at).getTime(), avg: r.avg, range: [r.min, r.max] as [number, number], count: r.count,
  })), [detail]);

  // The y-range has to include the critical lines, or a calm signal's chart would zoom
  // until ordinary noise filled the height and looked like an excursion.
  const yDomain = useMemo((): [number, number] | ['auto', 'auto'] => {
    const ys = data.flatMap((d) => d.range);
    const b = detail?.baseline;
    if (b) ys.push(b.critical.lo, b.critical.hi);
    if (typeof detail?.verdict?.value === 'number') ys.push(detail.verdict.value);
    if (!ys.length) return ['auto', 'auto'];
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    return [lo - pad, hi + pad];
  }, [data, detail]);

  const b = detail?.baseline ?? null;
  const v = detail?.verdict ?? null;
  const from = detail ? new Date(detail.window.from).getTime() : 0;
  const to = detail ? new Date(detail.window.to).getTime() : 0;
  const scoredAt = detail?.occurredAt ? new Date(detail.occurredAt).getTime() : null;
  const tick = (ms: number) => new Date(ms).toLocaleString(undefined, hours <= 24
    ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', hour: '2-digit' });

  return (
    <div className="mt-2 mb-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-slate-600 dark:text-slate-300">{summary(t, detail)}</p>
        <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden" role="group" aria-label={t('drill.window')}>
          {WINDOWS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              aria-pressed={hours === h}
              className={`px-2 py-0.5 text-[11px] font-medium cursor-pointer ${hours === h
                ? 'bg-sky-600 text-white'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            >
              {t(`drill.range.h${h}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading && !detail && <p className="text-xs text-slate-400">{t('common.loading')}</p>}

      {detail && data.length === 0 && !loading && (
        <p className="text-xs text-slate-400 py-6 text-center">{t('drill.noReadings')}</p>
      )}

      {detail && data.length > 0 && (
        <div className={`h-52 ${loading ? 'opacity-60' : ''}`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={C.axis} strokeOpacity={0.15} vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} tickFormatter={tick}
                stroke={C.axis} fontSize={10} tickLine={false} minTickGap={40} />
              <YAxis domain={yDomain} stroke={C.axis} fontSize={10} tickLine={false} width={44}
                tickFormatter={(n: number) => fmt(n, Math.abs(n) >= 100 ? 0 : 1)} />
              {b && <ReferenceArea y1={b.warning.lo} y2={b.warning.hi} fill={C.normal} fillOpacity={0.08} ifOverflow="hidden" />}
              {b && <ReferenceLine y={b.mean} stroke={C.mean} strokeDasharray="2 3" strokeOpacity={0.7} />}
              {b && [b.warning.lo, b.warning.hi].map((y) => (
                <ReferenceLine key={`w${y}`} y={y} stroke={C.warning} strokeDasharray="4 3" strokeOpacity={0.8} />
              ))}
              {b && [b.critical.lo, b.critical.hi].map((y) => (
                <ReferenceLine key={`c${y}`} y={y} stroke={C.critical} strokeDasharray="4 3" strokeOpacity={0.8} />
              ))}
              <Area dataKey="range" stroke="none" fill={C.range} fillOpacity={0.12} isAnimationActive={false} />
              <Line dataKey="avg" stroke={C.line} strokeWidth={1.75} dot={false} isAnimationActive={false} />
              {scoredAt !== null && typeof v?.value === 'number' && (
                <ReferenceDot x={scoredAt} y={v.value} r={4} fill={v.state === 'critical' ? C.critical : v.state === 'warning' ? C.warning : C.normal}
                  stroke="#fff" strokeWidth={1.5} ifOverflow="extendDomain" />
              )}
              <Tooltip
                labelFormatter={(ms) => new Date(Number(ms)).toLocaleString()}
                formatter={(value, name) => (name === 'range'
                  ? [Array.isArray(value) ? `${fmt(Number(value[0]))} – ${fmt(Number(value[1]))}` : String(value), t('drill.minMax')]
                  : [fmt(Number(value)), t('drill.average')])}
                contentStyle={{ fontSize: 11, borderRadius: 8 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {detail && (
        <div className="flex items-center gap-3 flex-wrap text-[11px] text-slate-500 dark:text-slate-400">
          <Legend swatch={<span className="inline-block w-4 h-0.5" style={{ background: C.line }} />} label={t('drill.legend.reading')} />
          {b && <Legend swatch={<span className="inline-block w-4 h-2 rounded-sm" style={{ background: C.normal, opacity: 0.25 }} />} label={t('drill.legend.normal', { lo: fmt(b.warning.lo), hi: fmt(b.warning.hi) })} />}
          {b && <Legend swatch={<span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: C.warning }} />} label={t('drill.legend.warning', { sigma: b.warningSigma })} />}
          {b && <Legend swatch={<span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: C.critical }} />} label={t('drill.legend.critical', { sigma: b.criticalSigma, lo: fmt(b.critical.lo), hi: fmt(b.critical.hi) })} />}
          {!b && detail.modelRef === 'influence@1' && <span>{t('drill.influenceNoBands')}</span>}
          {!b && detail.modelRef !== 'influence@1' && <span>{t('drill.noBaseline')}</span>}
          {b && <span className="ml-auto">{t('drill.baselineFrom', { days: b.windowDays, samples: b.sampleCount.toLocaleString(), coverage: Math.round(b.coverageRatio * 100) })}</span>}
        </div>
      )}
    </div>
  );
};

const Legend: React.FC<{ swatch: React.ReactNode; label: string }> = ({ swatch, label }) => (
  <span className="inline-flex items-center gap-1.5">{swatch}{label}</span>
);

/** The verdict in one sentence: the value, how far from normal, and which way. */
function summary(t: (k: string, o?: Record<string, unknown>) => string, d: PredictionSignalDetail | null): string {
  if (!d) return '';
  const v = d.verdict;
  if (!v) return t('drill.notScoredYet');
  const at = d.occurredAt ? new Date(d.occurredAt).toLocaleString() : '—';
  if (v.state === 'unscored') return t('drill.unscored', { reason: t(`unscoredReason.${v.reason ?? 'unknown'}`, { defaultValue: v.reason ?? '' }), at });
  if (typeof v.residual === 'number') {
    return t('drill.influenceSummary', { value: fmt(v.value), expected: fmt(v.expected), residual: fmt(Math.abs(v.residual)), dir: t(v.residual >= 0 ? 'drill.above' : 'drill.below'), at });
  }
  if (typeof v.z === 'number' && d.baseline) {
    return t(`drill.summary.${v.state}`, { value: fmt(v.value), sigma: fmt(Math.abs(v.z), 1), dir: t(v.z >= 0 ? 'drill.above' : 'drill.below'), mean: fmt(d.baseline.mean), at });
  }
  return t('drill.valueOnly', { value: fmt(v.value), at });
}
