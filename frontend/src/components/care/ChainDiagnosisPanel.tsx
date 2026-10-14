import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, GitBranch, Target } from 'lucide-react';
import { InputNumber } from 'rsuite';
import {
  ApiError, CausalChain, ChainProjection, ChainStageResult, MachineDiagnosis, StageVerdict,
  apiDiagnoseMachine, apiListCausalChains, apiProjectChain,
} from '../../lib/api';
import { Chip } from '../common/Chip';

const VERDICT_TONE: Record<StageVerdict, 'emerald' | 'rose' | 'amber' | 'slate'> = {
  normal: 'emerald', origin: 'rose', additional: 'amber', unevaluated: 'slate',
};
const VERDICT_LABEL: Record<StageVerdict, string> = {
  normal: 'on its curve', origin: 'origin', additional: 'separate fault', unevaluated: 'not scored',
};
const STAGE_REASON: Record<string, string> = {
  'no-target': 'no reading for this signal',
  'driver-missing': 'a driver has no reading',
  'out-of-range': 'drivers outside the range the chain was fitted on',
};
const CHAIN_REASON: Record<string, string> = {
  'no-nodes': 'the chain has no stages',
  cycle: 'the chain loops on itself',
  'nothing-evaluable': 'no stage had the readings it needs',
  'no-inputs': 'no input values given',
};

const num = (v: number | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const minutes = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

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
  const [diagnosis, setDiagnosis] = useState<MachineDiagnosis | null>(null);
  const [chains, setChains] = useState<CausalChain[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    apiDiagnoseMachine(sourceSystem, externalId)
      .then((d) => { if (live) { setDiagnosis(d); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not diagnose this machine.'); });
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
          <span className="font-semibold text-slate-900 dark:text-white text-base">Root-cause diagnosis</span>
          {origins.length > 0 && <Chip tone="rose">{origins.length} origin{origins.length === 1 ? '' : 's'}</Chip>}
          {/* "Nothing wrong" only from a chain that actually ran; one with no readings says nothing. */}
          {diagnosis && origins.length === 0 && diagnosis.chains.some((c) => c.evaluated) && <Chip tone="emerald">no stage off its curve</Chip>}
          {diagnosis && diagnosis.chains.length > 0 && !diagnosis.chains.some((c) => c.evaluated) && <Chip tone="slate">not enough readings</Chip>}
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
          {!diagnosis && !error && <p className="text-slate-500">Diagnosing…</p>}
          {diagnosis && diagnosis.chains.length === 0 && diagnosis.skipped.length === 0 && (
            <p className="text-slate-400">No published causal chain covers this machine's class{classSlug ? ` (${classSlug})` : ''}.</p>
          )}

          {diagnosis?.chains.map((c) => (
            <div key={c.slug} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-800 dark:text-slate-100">{chainName(c.slug)}</p>
                <span className="text-slate-400">confidence {c.confidence}</span>
              </div>
              {!c.evaluated && <p className="text-slate-400">Not evaluated: {CHAIN_REASON[c.reason ?? ''] ?? c.reason}</p>}
              {c.origin && <OriginLine stage={c.origin} />}
              {c.additional.length > 0 && (
                <p className="text-amber-600 dark:text-amber-400">
                  Separate fault{c.additional.length === 1 ? '' : 's'} further down: {c.additional.map((s) => s.label ?? s.signal).join(', ')}
                </p>
              )}
              {c.explainedBy?.map((e) => (
                <p key={e.signal} className="text-slate-500 dark:text-slate-400">{e.signal}: {e.because}</p>
              ))}
              <StageTable stages={c.stages} />
            </div>
          ))}

          {diagnosis && diagnosis.skipped.length > 0 && (
            <p className="text-slate-400">Not run: {diagnosis.skipped.map((s) => `${chainName(s.slug)} (${s.reason})`).join('; ')}</p>
          )}

          {chains.length > 0 && (
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">What if…</p>
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

const OriginLine: React.FC<{ stage: ChainStageResult }> = ({ stage }) => (
  <div className="flex items-start gap-2 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
    <Target className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
    <div>
      <p className="font-semibold text-rose-700 dark:text-rose-300">Look at: {stage.label ?? stage.signal}</p>
      <p className="text-rose-700/80 dark:text-rose-300/80">
        reads {num(stage.actual)} where its drivers predict {num(stage.expected)}
        {stage.exceedance != null ? ` · ${num(stage.exceedance)}× its warning threshold` : ''}
        {stage.severity && stage.severity !== 'none' ? ` · ${stage.severity}` : ''}
      </p>
    </div>
  </div>
);

const StageTable: React.FC<{ stages: ChainStageResult[] }> = ({ stages }) => (
  <div className="space-y-1">
    {stages.map((s) => (
      <div key={s.signal} className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-1">
        <span className="text-slate-700 dark:text-slate-200">
          {s.label ?? s.signal}
          {s.verdict === 'unevaluated' && s.reason && <span className="text-slate-400"> — {STAGE_REASON[s.reason] ?? s.reason}{s.missingDrivers?.length ? ` (${s.missingDrivers.join(', ')})` : ''}</span>}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {s.actual != null && <span className="text-slate-400 font-mono">{num(s.actual)} / {num(s.expected)}</span>}
          <Chip tone={VERDICT_TONE[s.verdict]}>{VERDICT_LABEL[s.verdict]}</Chip>
        </span>
      </div>
    ))}
  </div>
);

/** Inputs are the chain's exogenous drivers — the ones no stage predicts. They start
 *  from what the machine is reading now, when the diagnosis has those values. */
const WhatIf: React.FC<{ chain: CausalChain; observed?: { stages: ChainStageResult[] } }> = ({ chain, observed }) => {
  const inputs = useMemo(() => {
    const stageSignals = new Set(chain.nodes.map((n) => n.signal));
    return [...new Set(chain.nodes.flatMap((n) => n.drivers.map((d) => d.signal)).filter((s) => !stageSignals.has(s)))];
  }, [chain]);
  const current = useMemo(() => {
    const seen: Record<string, number> = {};
    for (const s of observed?.stages ?? []) for (const [k, v] of Object.entries(s.drivers ?? {})) seen[k] = v;
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
      setError(err instanceof ApiError ? err.message : 'Could not project this chain.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
      <p className="font-semibold text-slate-800 dark:text-slate-100">{chain.name}</p>
      {inputs.length === 0 ? (
        <p className="text-slate-400">This chain has no external inputs to set.</p>
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
            {busy ? 'Projecting…' : 'Project'}
          </button>
        </div>
      )}
      {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
      {result && !result.projected && <p className="text-slate-400">Not projected: {CHAIN_REASON[result.reason ?? ''] ?? result.reason}</p>}
      {result?.projected && (
        <div className="space-y-1">
          {result.firstBreach ? (
            <p className="font-semibold text-rose-600 dark:text-rose-400">
              {result.firstBreach.label ?? result.firstBreach.signal} breaches its rating ({result.firstBreach.breach}) in about {minutes(result.firstBreach.leadSeconds)}
            </p>
          ) : (
            <p className="text-emerald-600 dark:text-emerald-400">No rated stage breaches at these inputs.</p>
          )}
          {result.stages.map((st) => (
            <div key={st.signal} className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-1">
              <span className="text-slate-700 dark:text-slate-200">{st.label ?? st.signal}</span>
              <span className="flex items-center gap-2 text-slate-400">
                <span className="font-mono">{num(st.expected)}</span>
                <span>after {minutes(st.leadSeconds)}</span>
                <Chip tone={st.breach === 'critical' ? 'rose' : st.breach === 'warning' ? 'amber' : st.breach === 'none' ? 'emerald' : 'slate'}>
                  {st.breach ?? 'no rating'}
                </Chip>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
