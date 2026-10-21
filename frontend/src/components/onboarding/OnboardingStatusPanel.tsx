import React, { useEffect, useState } from 'react';
import { Check, ListChecks, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MachineOnboarding, ONBOARDING_STEPS, OnboardingStepName, OnboardingStepState, OnboardingSummary,
  apiGetMachineOnboarding, apiGetOnboardingSummary,
} from '../../lib/api';

/** The machine the conversation has just worked on, or null for the whole account. */
export interface OnboardingFocus {
  sourceSystem: string;
  externalId: string;
}

// A pending step is the one to do now, so it gets the "active" look; a blocked one waits
// on an earlier step and stays grey until that is done.
const CARD: Record<OnboardingStepState, string> = {
  done: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50',
  pending: 'bg-sky-50 dark:bg-sky-950/30 border-sky-300 dark:border-sky-800',
  blocked: 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800',
};
const BADGE: Record<OnboardingStepState, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  pending: 'text-sky-600 dark:text-sky-400',
  blocked: 'text-slate-400 dark:text-slate-500',
};

interface Row {
  id: string;
  label: string;
  sub: string | null;
  state: OnboardingStepState;
  /** The word on the badge, when it differs from the look. */
  badge?: OnboardingStepState;
}

/**
 * Setup progress beside the onboarding chat, read live from GET /onboarding/status — the
 * same derivation the progress list uses, so the two never disagree. Re-read whenever
 * `refreshKey` changes, which the chat bumps after each onboarding answer and each
 * confirmed proposal.
 */
export const OnboardingStatusPanel: React.FC<{
  focus: OnboardingFocus | null;
  refreshKey: number;
  onClearFocus: () => void;
}> = ({ focus, refreshKey, onClearFocus }) => {
  const { t } = useTranslation('onboarding');
  const [summary, setSummary] = useState<OnboardingSummary | null>(null);
  const [machine, setMachine] = useState<MachineOnboarding | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailed(false);
    const read = focus
      ? apiGetMachineOnboarding(focus.sourceSystem, focus.externalId).then((m) => { if (live) { setMachine(m); setSummary(null); } })
      : apiGetOnboardingSummary().then((s) => { if (live) { setSummary(s); setMachine(null); } });
    read.catch(() => { if (live) setFailed(true); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [focus?.sourceSystem, focus?.externalId, refreshKey, tick]);

  const stepLabel = (s: OnboardingStepName) => t(`step.${s}`);
  let rows: Row[] = [];
  let subtitle = '';

  if (machine) {
    subtitle = t('chat.status.subtitleMachine', { name: machine.machine.name ?? machine.machine.externalId });
    rows = machine.steps.map((s) => ({
      id: s.step,
      label: stepLabel(s.step),
      state: s.state,
      sub: s.state === 'done' ? null
        : s.blockedBy ? t('progress.waitingOn', { step: stepLabel(s.blockedBy) })
          : s.reason ? t(`reason.${s.reason}`, { defaultValue: s.reason }) : null,
    }));
    // Not done yet reads "pending", but stays grey: it is the last step, never the one to do now.
    rows.push({ id: 'overall', label: t('chat.status.done'), sub: null, state: machine.overall === 'done' ? 'done' : 'blocked', badge: machine.overall === 'done' ? 'done' : 'pending' });
  } else if (summary) {
    const total = summary.sites.reduce((n, s) => n + s.machines.total, 0);
    const done = summary.sites.reduce((n, s) => n + s.machines.done, 0);
    subtitle = total ? t('chat.status.subtitleAll', { done, total }) : t('chat.status.noMachines');
    rows = ONBOARDING_STEPS.map((step) => {
      const count = (state: OnboardingStepState) => summary.sites.reduce((n, s) => n + (s.steps[step]?.[state] ?? 0), 0);
      const stepDone = count('done');
      // Done only when every machine has it; otherwise the step is to do now if any
      // machine can take it, and waiting if every remaining machine is blocked.
      const state: OnboardingStepState = total > 0 && stepDone === total ? 'done' : count('pending') > 0 || total === 0 ? 'pending' : 'blocked';
      return { id: step, label: stepLabel(step), state, sub: total ? t('chat.status.machinesDone', { done: stepDone, total }) : null };
    });
    const allDone = total > 0 && done === total;
    rows.push({ id: 'overall', label: t('chat.status.done'), sub: null, state: allDone ? 'done' : 'blocked', badge: allDone ? 'done' : 'pending' });
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
      <div className="flex items-start justify-between gap-2 pb-3 mb-1 border-b border-slate-100 dark:border-slate-800">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{t('chat.setupStatus')}</h3>
          {subtitle && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{subtitle}</p>}
          {focus && (
            <button type="button" onClick={onClearFocus} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline cursor-pointer">
              {t('chat.status.allMachines')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setTick((n) => n + 1)}
            disabled={loading}
            title={t('progress.refresh')}
            aria-label={t('progress.refresh')}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <ListChecks className="w-4 h-4 text-slate-400" />
        </div>
      </div>

      {failed && <p className="text-xs text-amber-600 dark:text-amber-400 pt-2">{t('progress.loadFailed')}</p>}
      {!failed && !rows.length && <p className="text-xs text-slate-400 pt-2">{t('progress.loading')}</p>}

      <div className="space-y-2.5 pt-2">
        {rows.map((row) => (
          <div key={row.id} className={`rounded-lg border p-3 flex items-start justify-between gap-2 transition-colors ${CARD[row.state]}`}>
            <div className="flex items-start gap-2.5 min-w-0">
              {row.state === 'done' ? (
                <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 mt-0.5">
                  <Check className="w-3 h-3" />
                </div>
              ) : (
                <div className={`w-5 h-5 rounded-full border-2 shrink-0 mt-0.5 ${row.state === 'pending' ? 'border-sky-500' : 'border-slate-300 dark:border-slate-600'}`} />
              )}
              <div className="min-w-0">
                <div className={`text-sm font-medium leading-snug ${row.state === 'blocked' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>
                  {row.label}
                </div>
                {row.sub && <div className="text-[11px] text-slate-500 dark:text-slate-400">{row.sub}</div>}
              </div>
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wider shrink-0 mt-0.5 ${BADGE[row.state]}`}>
              {t(`stepState.${row.badge ?? row.state}`)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
