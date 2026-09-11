/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { TrendPoint } from '../types';

interface TrendChartProps {
  history: TrendPoint[];
  unit?: string;
  height?: number;
  lineClassName?: string;
  bandClassName?: string;
  /** Draws a dashed marker + label at the point this many days ago. */
  anomalyStartDaysAgo?: number;
  className?: string;
}

const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 24;
const VIEW_W = 640;

/**
 * Actual-value line over a shaded 90-day baseline band, with an optional
 * "deviation started N days ago" marker. Used for the large parameter trend on
 * Machine Details and the primary chart on Predictive Trends.
 */
export const TrendChart: React.FC<TrendChartProps> = ({
  history,
  unit = '',
  height = 220,
  lineClassName = 'stroke-sky-500',
  bandClassName = 'fill-slate-300/40 dark:fill-slate-600/30',
  anomalyStartDaysAgo,
  className = '',
}) => {
  const viewH = height;
  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = viewH - PAD_T - PAD_B;

  const geometry = useMemo(() => {
    if (history.length === 0) return null;
    const allY = history.flatMap((p) => [p.value, p.baselineLow, p.baselineHigh]);
    const min = Math.min(...allY);
    const max = Math.max(...allY);
    const span = max - min || 1;
    const pad = span * 0.12;
    const yMin = min - pad;
    const yMax = max + pad;
    const stepX = plotW / Math.max(1, history.length - 1);

    const toX = (i: number) => PAD_L + i * stepX;
    const toY = (v: number) => PAD_T + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    const linePoints = history.map((p, i) => [toX(i), toY(p.value)] as const);
    const linePath = linePoints.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

    const bandTop = history.map((p, i) => [toX(i), toY(p.baselineHigh)] as const);
    const bandBottom = history.map((p, i) => [toX(i), toY(p.baselineLow)] as const);
    const bandPath =
      bandTop.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
      ' ' +
      bandBottom
        .slice()
        .reverse()
        .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ') +
      ' Z';

    let anomalyX: number | null = null;
    if (anomalyStartDaysAgo !== undefined) {
      const idx = history.findIndex((p) => p.daysAgo === anomalyStartDaysAgo);
      if (idx >= 0) anomalyX = toX(idx);
    }

    return { linePath, bandPath, anomalyX, yMin, yMax, toY };
  }, [history, anomalyStartDaysAgo, plotW, plotH]);

  if (!geometry) return null;
  const { linePath, bandPath, anomalyX, yMin, yMax, toY } = geometry;

  const first = history[0];
  const last = history[history.length - 1];
  const yTicks = [yMax, (yMax + yMin) / 2, yMin];

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${VIEW_W} ${viewH}`} width="100%" height={height} preserveAspectRatio="none" role="img">
        {/* Y gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={toY(t)} y2={toY(t)} className="stroke-slate-100 dark:stroke-slate-800" strokeWidth={1} />
            <text x={PAD_L - 6} y={toY(t) + 3} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
              {Math.round(t * 10) / 10}
            </text>
          </g>
        ))}

        {/* Baseline band */}
        <path d={bandPath} className={bandClassName} stroke="none" />

        {/* Anomaly start marker */}
        {anomalyX !== null && (
          <g>
            <line x1={anomalyX} x2={anomalyX} y1={PAD_T} y2={PAD_T + plotH} className="stroke-rose-400 dark:stroke-rose-500" strokeWidth={1.25} strokeDasharray="4 3" />
            <circle cx={anomalyX} cy={PAD_T} r={2.5} className="fill-rose-500" />
          </g>
        )}

        {/* Actual value line */}
        <path d={linePath} className={lineClassName} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* X axis labels */}
        <text x={PAD_L} y={viewH - 6} textAnchor="start" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
          {first.daysAgo}d ago
        </text>
        <text x={VIEW_W - PAD_R} y={viewH - 6} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
          Today
        </text>
      </svg>
      {anomalyX !== null && anomalyStartDaysAgo !== undefined && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400 font-medium mt-1 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
          Deviation started {anomalyStartDaysAgo} days ago
        </div>
      )}
      {unit && (
        <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
          Value in {unit} · shaded band = 90-day baseline range · last reading {last.value}
          {unit}
        </div>
      )}
    </div>
  );
};
