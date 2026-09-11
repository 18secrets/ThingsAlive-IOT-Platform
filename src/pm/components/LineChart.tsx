/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';

interface LineChartProps {
  points: { daysAgo: number; value: number }[];
  height?: number;
  lineClassName?: string;
  fillClassName?: string;
  /** Optional horizontal reference lines, e.g. severity thresholds. */
  referenceLines?: { value: number; label: string; colorClass: string }[];
  yDomain?: [number, number];
  valueSuffix?: string;
}

const PAD_L = 34;
const PAD_R = 46;
const PAD_T = 14;
const PAD_B = 24;
const VIEW_W = 560;

/** Single-series trend line (e.g. 90-day average fleet risk score) with optional threshold reference lines. */
export const LineChart: React.FC<LineChartProps> = ({
  points,
  height = 220,
  lineClassName = 'stroke-sky-500',
  fillClassName = 'fill-sky-500/10',
  referenceLines = [],
  yDomain,
  valueSuffix = '',
}) => {
  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((p) => p.value);
    const [yMin, yMax] = yDomain ?? [Math.min(...values) - 5, Math.max(...values) + 5];
    const stepX = plotW / Math.max(1, points.length - 1);
    const toX = (i: number) => PAD_L + i * stepX;
    const toY = (v: number) => PAD_T + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
    const coords = points.map((p, i) => [toX(i), toY(p.value)] as const);
    const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${coords[coords.length - 1][0]},${PAD_T + plotH} L${coords[0][0]},${PAD_T + plotH} Z`;
    return { linePath, areaPath, toY, yMin, yMax };
  }, [points, plotW, plotH, yDomain]);

  if (!geometry) return null;
  const { linePath, areaPath, toY, yMin, yMax } = geometry;
  const first = points[0];

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {referenceLines.map((ref, i) => (
        <g key={i}>
          <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={toY(ref.value)} y2={toY(ref.value)} className={ref.colorClass} strokeWidth={1} strokeDasharray="3 3" />
          <text x={VIEW_W - PAD_R + 4} y={toY(ref.value) + 3} className={`${ref.colorClass.replace('stroke-', 'fill-')}`} fontSize={9}>
            {ref.label}
          </text>
        </g>
      ))}

      <path d={areaPath} className={fillClassName} stroke="none" />
      <path d={linePath} className={lineClassName} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(yMax)}
        {valueSuffix}
      </text>
      <text x={PAD_L - 6} y={PAD_T + plotH} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(yMin)}
        {valueSuffix}
      </text>

      <text x={PAD_L} y={height - 6} textAnchor="start" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {first.daysAgo}d ago
      </text>
      <text x={VIEW_W - PAD_R} y={height - 6} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        Today
      </text>
    </svg>
  );
};
