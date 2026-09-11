/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';

export interface ScatterPoint {
  x: number;
  y: number;
  recent?: boolean;
}

interface ScatterChartProps {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
}

const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 30;
const VIEW_W = 420;

/** Correlation scatter (e.g. oil pressure vs engine load) — recent points highlighted. */
export const ScatterChart: React.FC<ScatterChartProps> = ({ points, xLabel, yLabel, height = 220 }) => {
  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xSpan = xMax - xMin || 1;
    const ySpan = yMax - yMin || 1;
    const toX = (v: number) => PAD_L + ((v - xMin) / xSpan) * plotW;
    const toY = (v: number) => PAD_T + plotH - ((v - yMin) / ySpan) * plotH;
    return { toX, toY, xMin, xMax, yMin, yMax };
  }, [points, plotW, plotH]);

  if (!geometry) return null;
  const { toX, toY, xMin, xMax, yMin, yMax } = geometry;

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {/* Axes */}
      <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
      <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + plotH} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />

      {/* Axis labels */}
      <text x={PAD_L + plotW / 2} y={height - 4} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" fontSize={10}>
        {xLabel}
      </text>
      <text x={12} y={PAD_T + plotH / 2} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" fontSize={10} transform={`rotate(-90 12 ${PAD_T + plotH / 2})`}>
        {yLabel}
      </text>

      <text x={PAD_L} y={PAD_T + plotH + 14} textAnchor="start" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(xMin)}
      </text>
      <text x={VIEW_W - PAD_R} y={PAD_T + plotH + 14} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(xMax)}
      </text>
      <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(yMax)}
      </text>
      <text x={PAD_L - 6} y={PAD_T + plotH} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={9}>
        {Math.round(yMin)}
      </text>

      {points.map((p, i) => (
        <circle
          key={i}
          cx={toX(p.x)}
          cy={toY(p.y)}
          r={p.recent ? 4 : 2.5}
          className={p.recent ? 'fill-sky-500' : 'fill-slate-300 dark:fill-slate-600'}
          opacity={p.recent ? 1 : 0.7}
        />
      ))}
    </svg>
  );
};
