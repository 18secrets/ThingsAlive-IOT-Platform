/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { TrendPoint } from '../types';

interface SparklineProps {
  history: TrendPoint[];
  width?: number;
  height?: number;
  strokeClassName?: string;
  fillClassName?: string;
  className?: string;
}

/** Small inline trend line used on parameter cards and table rows. */
export const Sparkline: React.FC<SparklineProps> = ({
  history,
  width = 120,
  height = 32,
  strokeClassName = 'stroke-sky-500',
  fillClassName = 'fill-sky-500/10',
  className = '',
}) => {
  const { linePath, areaPath } = useMemo(() => {
    if (history.length === 0) return { linePath: '', areaPath: '' };
    const values = history.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = width / Math.max(1, history.length - 1);
    const coords = history.map((p, i) => {
      const x = i * stepX;
      const y = height - ((p.value - min) / span) * (height - 4) - 2;
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${width},${height} L0,${height} Z`;
    return { linePath: line, areaPath: area };
  }, [history, width, height]);

  if (!linePath) return null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={className} preserveAspectRatio="none">
      <path d={areaPath} className={fillClassName} stroke="none" />
      <path d={linePath} className={strokeClassName} fill="none" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
