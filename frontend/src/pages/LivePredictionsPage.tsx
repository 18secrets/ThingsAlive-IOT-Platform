import React, { useMemo } from 'react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { useAuth } from '../lib/AuthProvider';
import { Sparkline } from '../components/dashboard/Sparkline';

type PredictionStatus = 'watch' | 'normal' | 'critical' | 'na';

interface PredictionCard {
  code: string;
  tier: 'T0' | 'T1';
  title: string;
  value: string;
  caption: string;
  status: PredictionStatus;
  sourceCaption: string;
  trend?: number[];
}

const STATUS_META: Record<PredictionStatus, { label: string; dot: string; value: string; pillText: string; line: string }> = {
  watch: {
    label: 'Watch',
    dot: 'bg-amber-500',
    value: 'text-amber-600 dark:text-amber-400',
    pillText: 'text-amber-700 dark:text-amber-400',
    line: 'text-amber-500 dark:text-amber-400',
  },
  normal: {
    label: 'Normal',
    dot: 'bg-emerald-500',
    value: 'text-emerald-600 dark:text-emerald-400',
    pillText: 'text-emerald-700 dark:text-emerald-400',
    line: 'text-emerald-500 dark:text-emerald-400',
  },
  critical: {
    label: 'Critical',
    dot: 'bg-rose-500',
    value: 'text-rose-600 dark:text-rose-400',
    pillText: 'text-rose-700 dark:text-rose-400',
    line: 'text-rose-500 dark:text-rose-400',
  },
  na: {
    label: 'Not applicable',
    dot: 'bg-slate-300 dark:bg-slate-600',
    value: 'text-slate-400 dark:text-slate-500',
    pillText: 'text-slate-400 dark:text-slate-500',
    line: 'text-slate-400 dark:text-slate-500',
  },
};

const TIER_STYLE: Record<PredictionCard['tier'], string> = {
  T0: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  T1: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
};

// Mock — same convention as ClientFleetDashboard: stable placeholder data until this
// screen has a backend. Real values come from GET /predictions/:sourceSystem/:externalId
// (+ /history for the sparkline) once wired; see src/prediction/prediction.controller.ts.
const PREDICTIONS: PredictionCard[] = [
  {
    code: 'DG-2214',
    tier: 'T1',
    title: 'Fuel Consumption Anomaly',
    value: '-14.2%',
    caption: 'vs 7-day rolling baseline',
    status: 'watch',
    sourceCaption: 'unsupervised · high confidence',
    trend: [58, 55, 60, 52, 48, 44, 40, 38, 36],
  },
  {
    code: 'CR-1180',
    tier: 'T0',
    title: 'Breakdown-Hours Threshold',
    value: '612 / 750 hrs',
    caption: 'to next OEM service interval',
    status: 'normal',
    sourceCaption: 'rule-based · Mobile Crane',
    trend: [40, 42, 45, 47, 50, 52, 55, 58, 60],
  },
  {
    code: 'DG-3305',
    tier: 'T1',
    title: 'Fuel Consumption Anomaly',
    value: '-31.4%',
    caption: 'sensor drift suspected — flagged for site check',
    status: 'critical',
    sourceCaption: 'unsupervised · high confidence',
    trend: [62, 58, 50, 44, 38, 32, 28, 25, 24],
  },
  {
    code: 'AC-0447',
    tier: 'T0',
    title: 'Breakdown-Hours Threshold',
    value: '288 / 500 hrs',
    caption: 'to next OEM service interval',
    status: 'normal',
    sourceCaption: 'rule-based · Air Compressor',
    trend: [38, 40, 41, 43, 45, 47, 49, 51, 53],
  },
  {
    code: 'RT-0912',
    tier: 'T1',
    title: 'Fuel Consumption Anomaly',
    value: '-3.1%',
    caption: 'vs 7-day rolling baseline',
    status: 'normal',
    sourceCaption: 'unsupervised · Tipper',
    trend: [50, 49, 51, 50, 49, 50, 51, 50, 49],
  },
  {
    code: 'PR-0512',
    tier: 'T0',
    title: 'Running-Hours Utilization',
    value: '— excluded —',
    caption: 'idle-heavy duty cycle breaks this metric for Piling Rigs',
    status: 'na',
    sourceCaption: 'flagged at proposal stage',
  },
];

export const LivePredictionsPage: React.FC = () => {
  usePageHeader({ title: 'Live Predictions', subtitle: 'Automated Dispatch' });
  const { authUser } = useAuth();

  const cards = useMemo(() => PREDICTIONS, []);
  const portalLabel = authUser?.clientName ? `${authUser.clientName} Portal` : 'Client Portal';
  const roleLabel = authUser?.isSuperAdmin ? 'Super Admin' : 'Team Member';

  return (
    <div id="live-predictions-view" className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Live Predictions</h2>
            <span className="px-2 py-0.5 rounded-full border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-[11px] font-medium text-sky-700 dark:text-sky-300">
              {portalLabel} · {roleLabel}
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Outcomes scored continuously from live telemetry — same pipeline as replayed demo logs
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => {
          const meta = STATUS_META[c.status];
          const excluded = c.status === 'na';
          return (
            <div
              key={c.code}
              className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2.5 ${
                excluded ? 'opacity-70' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">{c.code}</span>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-sm leading-snug">{c.title}</h4>

              <div className={`text-2xl font-bold font-mono ${meta.value}`}>{c.value}</div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed min-h-[2.2em]">{c.caption}</p>

              <div className="h-9 flex items-center">
                {c.trend ? (
                  <Sparkline values={c.trend} colorClass={meta.line} width={140} height={32} />
                ) : (
                  <div className="w-full border-t border-dashed border-slate-200 dark:border-slate-700" />
                )}
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-mono font-medium ${meta.pillText}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                  {meta.label}
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500 text-right">{c.sourceCaption}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
