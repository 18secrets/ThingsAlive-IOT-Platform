import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, GitBranch, Target } from 'lucide-react';
import { InputNumber } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, CausalChain, ChainProjection, ChainStageResult, MachineDiagnosis, StageVerdict,
  apiDiagnoseMachine, apiListCausalChains, apiProjectChain,
} from '../../lib/api';
import { Chip } from '../common/Chip';

const VERDICT_TONE: Record<StageVerdict, 'emerald' | 'rose' | 'amber' | 'slate'> = {
  normal: 'emerald', origin: 'rose', additional: 'amber', unevaluated: 'slate',
};

const num = (v: number | undefined | null) => (v == null || isNaN(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const minutes = (s: number | undefined | null) => {
  if (s == null || isNaN(Number(s))) return '—';
  const val = Number(s);
  return val < 60 ? `${Math.round(val)} s` : `${Math.round(val / 60)} min`;
};

/**
 * The machine's causal chains, read against its telemetry (P4-01). Each stage is
 * scored against what its own drivers predict, so the first stage off its curve is
 * where to look, and a downstream stage that rose only because of it is named as
 * explained rather than raised as a second alarm. The what-if feeds assumed inputs
 * forward to say which stage would breach first, and how soon.
 */
export const ChainDiagnosisPanel: React.FC<{ sourceSystem: string; externalId: string; classSlug: string | null }> = ({
  sourceSystem, externalId, classSlug,
}) => {
  const { t } = useTranslation('care');
  const [diagnosis, setDiagnosis] = useState<MachineDiagnosis | null>(null);
  const [chains, setChains] = useState<CausalChain[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    apiDiagnoseMachine(sourceSystem, externalId)
      .then((d) => { if (live) { setDiagnosis(d); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('chain.errors.diagnose')); });
    if (classSlug) apiListCausalChains(classSlug).then((c) => { if (live) setChains(c); }).catch(() => {});
    return () => { live = false; };
  }, [sourceSystem, externalId, classSlug]);

  const chainName = (slug: string) => chains.find((c) => c.slug === slug)?.name ?? slug;
  const origins = diagnosis?.chains.filter((c) => c.origin) ?? [];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left cursor-pointer">
        <span className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-sky-600" />
          <span className="font-semibold text-slate-900 dark:text-white text-base">{t('chain.title')}</span>
          {origins.length > 0 && <Chip tone="rose">{t('chain.origins', { count: origins.length })}</Chip>}
          {/* "Nothing wrong" only from a chain that actually ran; one with no readings says nothing. */}
          {diagnosis && origins.length === 0 && diagnosis.chains.some((c) => c.evaluated) && <Chip tone="emerald">{t('chain.noStageOff')}</Chip>}
          {diagnosis && diagnosis.chains.length > 0 && !diagnosis.chains.some((c) => c.evaluated) && <Chip tone="slate">{t('chain.notEnoughReadings')}</Chip>}
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 text-xs">
          {error && (
            <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          {!diagnosis && !error && <p className="text-slate-500">{t('chain.diagnosing')}</p>}
          {diagnosis && diagnosis.chains.length === 0 && diagnosis.skipped.length === 0 && (
            <p className="text-slate-400">{classSlug ? t('chain.noChainForClass', { classSlug }) : t('chain.noChain')}</p>
          )}

          {diagnosis?.chains.map((c) => (
            <div key={c.slug} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-800 dark:text-slate-100">{chainName(c.slug)}</p>
                <span className="text-slate-400">{t('chain.confidence', { value: t(`chain.confidenceLevel.${c.confidence}`, { defaultValue: c.confidence }) })}</span>
              </div>
              {!c.evaluated && <p className="text-slate-400">{t('chain.notEvaluated', { reason: c.reason ? t(`chain.chainReason.${c.reason}`, { defaultValue: c.reason }) : '' })}</p>}
              {c.origin && <OriginLine stage={c.origin} />}
              {c.additional.length > 0 && (
                <p className="text-amber-600 dark:text-amber-400">
                  {t('chain.separateFaults', { count: c.additional.length, list: c.additional.map((s) => s.label ?? s.signal).join(', ') })}
                </p>
              )}
              {c.explainedBy?.map((e) => (
                <p key={e.signal} className="text-slate-500 dark:text-slate-400">{e.signal}: {e.because}</p>
              ))}
              <StageTable stages={c.stages} />
            </div>
          ))}

          {diagnosis && diagnosis.skipped.length > 0 && (
            <p className="text-slate-400">{t('chain.notRun', { list: diagnosis.skipped.map((s) => `${chainName(s.slug)} (${t(`chain.chainReason.${s.reason}`, { defaultValue: s.reason })})`).join('; ') })}</p>
          )}

          {chains.length > 0 && (
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('chain.whatIf')}</p>
              {chains.map((c) => (
                <WhatIf key={c.slug} chain={c} observed={diagnosis?.chains.find((d) => d.slug === c.slug)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const OriginLine: React.FC<{ stage: ChainStageResult }> = ({ stage }) => {
  const { t } = useTranslation('care');
  return (
    <div className="flex items-start gap-2 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
      <Target className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold text-rose-700 dark:text-rose-300">{t('chain.lookAt', { name: stage.label ?? stage.signal })}</p>
        <p className="text-rose-700/80 dark:text-rose-300/80">
          {t('chain.reads', { actual: num(stage.actual), expected: num(stage.expected) })}
          {stage.exceedance != null ? ` · ${t('chain.exceedance', { value: num(stage.exceedance) })}` : ''}
          {stage.severity && stage.severity !== 'none' ? ` · ${t(`chain.breach.${stage.severity}`, { defaultValue: stage.severity })}` : ''}
        </p>
      </div>
    </div>
  );
};

const StageTable: React.FC<{ stages: ChainStageResult[] }> = ({ stages }) => {
  const { t } = useTranslation('care');
  return (
    <div className="space-y-1">
      {stages.map((s) => (
        <div key={s.signal} className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-1">
          <span className="text-slate-700 dark:text-slate-200">
            {s.label ?? s.signal}
            {s.verdict === 'unevaluated' && s.reason && <span className="text-slate-400"> — {t(`chain.stageReason.${s.reason}`, { defaultValue: s.reason })}{s.missingDrivers?.length ? ` (${s.missingDrivers.join(', ')})` : ''}</span>}
          </span>
          <span className="flex items-center gap-2 shrink-0">
            {s.actual != null && <span className="text-slate-400 font-mono">{num(s.actual)} / {num(s.expected)}</span>}
            <Chip tone={VERDICT_TONE[s.verdict]}>{t(`chain.verdict.${s.verdict}`, { defaultValue: s.verdict })}</Chip>
          </span>
        </div>
      ))}
    </div>
  );
};

/** Inputs are the chain's exogenous drivers — the ones no stage predicts. They start
 *  from what the machine is reading now, when the diagnosis has those values. */
const WhatIf: React.FC<{ chain: CausalChain; observed?: { stages: ChainStageResult[] } }> = ({ chain, observed }) => {
  const { t } = useTranslation('care');
  const inputs = useMemo(() => {
    const nodes = chain.nodes ?? [];
    const stageSignals = new Set(nodes.map((n) => n.signal));
    return [...new Set(nodes.flatMap((n) => (n.drivers ?? []).map((d) => d.signal)).filter((s) => !stageSignals.has(s)))];
  }, [chain]);
  const current = useMemo(() => {
    const seen: Record<string, number> = {};
    for (const s of observed?.stages ?? []) {
      for (const [k, v] of Object.entries(s.drivers ?? {})) {
        if (typeof v === 'number') seen[k] = v;
      }
    }
    return seen;
  }, [observed]);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [result, setResult] = useState<ChainProjection | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const valueOf = (signal: string) => (signal in values ? values[signal] : current[signal] ?? null);
  const ready = inputs.length > 0 && inputs.every((s) => valueOf(s) != null);

  async function project() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await apiProjectChain(chain.slug, inputs.map((s) => ({ signal: s, value: valueOf(s)! }))));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chain.errors.project'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
      <p className="font-semibold text-slate-800 dark:text-slate-100">{chain.name}</p>
      {inputs.length === 0 ? (
        <p className="text-slate-400">{t('chain.noInputs')}</p>
      ) : (
        <div className="flex items-end gap-2 flex-wrap">
          {inputs.map((s) => (
            <label key={s} className="space-y-0.5">
              <span className="block text-[11px] text-slate-500">{s}</span>
              <InputNumber
                size="sm"
                value={valueOf(s)}
                onChange={(v) => setValues((p) => ({ ...p, [s]: v == null || v === '' ? null : Number(v) }))}
                className="w-28"
              />
            </label>
          ))}
          <button onClick={project} disabled={!ready || busy} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer">
            {busy ? t('chain.projecting') : t('chain.project')}
          </button>
        </div>
      )}
      {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
      {result && !result.projected && <p className="text-slate-400">{t('chain.notProjected', { reason: result.reason ? t(`chain.chainReason.${result.reason}`, { defaultValue: result.reason }) : '' })}</p>}
      {result?.projected && (
        <div className="space-y-1">
          {result.firstBreach ? (
            <p className="font-semibold text-rose-600 dark:text-rose-400">
              {t('chain.firstBreach', {
                name: result.firstBreach.label ?? result.firstBreach.signal,
                breach: result.firstBreach.breach ? t(`chain.breach.${result.firstBreach.breach}`, { defaultValue: result.firstBreach.breach }) : '',
                time: minutes(result.firstBreach.leadSeconds ?? 0),
              })}
            </p>
          ) : (
            <p className="text-emerald-600 dark:text-emerald-400">{t('chain.noBreach')}</p>
          )}
          {(result.stages ?? []).map((st) => (
            <div key={st.signal} className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-1">
              <span className="text-slate-700 dark:text-slate-200">{st.label ?? st.signal}</span>
              <span className="flex items-center gap-2 text-slate-400">
                <span className="font-mono">{num(st.expected)}</span>
                <span>{t('chain.after', { time: minutes(st.leadSeconds ?? 0) })}</span>
                <Chip tone={st.breach === 'critical' ? 'rose' : st.breach === 'warning' ? 'amber' : st.breach === 'none' ? 'emerald' : 'slate'}>
                  {st.breach ? t(`chain.breach.${st.breach}`, { defaultValue: st.breach }) : t('chain.noRating')}
                </Chip>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
