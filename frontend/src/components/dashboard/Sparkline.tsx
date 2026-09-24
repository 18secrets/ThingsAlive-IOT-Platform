import React from 'react';

interface SparklineProps {
  values: number[];
  /** A Tailwind text-color utility (e.g. "text-emerald-600 dark:text-emerald-400") — the
   *  line and end-marker both render in `currentColor`, so this is the single color knob. */
  colorClass: string;
  width?: number;
  height?: number;
}

/** Thin trend line with a single end-marker dot — no axes/legend, since the
 *  card's own status pill already carries the identity a legend would (see
 *  dataviz skill: single-series marks don't need one). Colour is status, not
 *  category, so it's applied per-card rather than from a fixed hue order. */
export const Sparkline: React.FC<SparklineProps> = ({ values, colorClass, width = 140, height = 36 }) => {
  if (values.length < 2) {
    return <div style={{ width, height }} />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 4;
  const stepX = (width - pad * 2) / (values.length - 1);

  const points = values.map((v, i) => ({
    x: pad + i * stepX,
    y: pad + (1 - (v - min) / range) * (height - pad * 2),
  }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`overflow-visible ${colorClass}`} aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r={2.5} fill="currentColor" />
    </svg>
  );
};
