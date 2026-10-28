import React from 'react';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, ReferenceArea, Tooltip, XAxis, YAxis } from 'recharts';
import { Prediction } from '../../lib/api';

/**
 * A scenario's risk score over its recent scores, on the fixed 0–100 scale the score
 * is defined on.
 *
 * Fixed, not fitted to the data: the generic sparkline stretched whatever range it was
 * given to full height, so 48 → 10 and 25 → 7 drew the identical line and every card on
 * a page looked like the same story. On a fixed axis a fall from 11 to 10 is flat,
 * which is what it is. The shaded bands are tier1's severity cut-offs (medium from 40,
 * high from 60, critical from 85), so the line is read against what the colours mean.
 */
export const RiskTrend: React.FC<{ history: Prediction[]; width?: number; height?: number }> = ({
  history, width = 168, height = 48,
}) => {
  const { t } = useTranslation('care');
  const points = history
    .filter((h) => typeof h.riskScore === 'number')
    .map((h) => ({ t: new Date(h.occurredAt).getTime(), risk: h.riskScore, severity: h.severity }))
    .sort((a, b) => a.t - b.t);

  if (points.length < 2) {
    return (
      <p className="text-[11px] text-slate-400 text-right w-[168px] leading-snug">
        {t('trend.tooFew', { count: points.length })}
      </p>
    );
  }

  return (
    <div className="flex flex-col items-end" title={t('trend.title', { count: points.length })}>
      <LineChart width={width} height={height} data={points} margin={{ top: 2, right: 4, bottom: 2, left: 4 }}>
        <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
        <YAxis domain={[0, 100]} hide />
        <ReferenceArea y1={40} y2={60} fill="#f59e0b" fillOpacity={0.08} ifOverflow="hidden" />
        <ReferenceArea y1={60} y2={100} fill="#f43f5e" fillOpacity={0.08} ifOverflow="hidden" />
        <Line dataKey="risk" stroke="#0ea5e9" strokeWidth={1.75} isAnimationActive={false}
          dot={{ r: 2, fill: '#0ea5e9', strokeWidth: 0 }} activeDot={{ r: 3.5 }} />
        <Tooltip
          labelFormatter={(ms) => new Date(Number(ms)).toLocaleString()}
          formatter={(value) => [`${value}`, t('trend.risk')]}
          contentStyle={{ fontSize: 11, borderRadius: 8, padding: '4px 8px' }}
        />
      </LineChart>
      <span className="text-[10px] text-slate-400">{t('trend.caption', { count: points.length })}</span>
    </div>
  );
};
