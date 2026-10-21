import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, Lightbulb, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError, RecBundleOutcome, RecEvidenceBundle, RecFrame,
  apiGetLatestRecEvidence, apiGetRecFrame, apiRenderRecFrame, apiRunRecEvidence,
} from '../../lib/api';
import { Chip } from '../common/Chip';
import { ChatMarkdown } from '../common/ChatMarkdown';

const OUTCOME_TONE: Record<RecBundleOutcome, 'rose' | 'amber' | 'slate' | 'emerald'> = {
  attributed: 'rose', unattributed: 'amber', inconclusive: 'slate', nothing_detected: 'emerald',
};

const notFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/**
 * What the recommendation engine makes of this machine (QREC1), in sentences (QREC2).
 * The latest evidence and its frame are read on open; nothing is evaluated or written
 * until someone asks, because the page never renders on read. Analysing again returns
 * the same evidence when nothing it read has changed, so the button is safe to press.
 */
export const RecommendationPanel: React.FC<{ sourceSystem: string; externalId: string }> = ({ sourceSystem, externalId }) => {
  const { t } = useTranslation('care');
  const [bundle, setBundle] = useState<RecEvidenceBundle | null>(null);
  const [frame, setFrame] = useState<RecFrame | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<'analyse' | 'explain' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const b = await apiGetLatestRecEvidence(sourceSystem, externalId);
        if (!live) return;
        setBundle(b);
        const f = await apiGetRecFrame(b.id).catch((err) => { if (notFound(err)) return null; throw err; });
        if (live) setFrame(f);
      } catch (err) {
        if (live && !notFound(err)) setError(err instanceof ApiError ? err.message : t('rec.errors.load'));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  const explain = async (b: RecEvidenceBundle) => {
    setBusy('explain');
    try {
      setFrame(await apiRenderRecFrame(b.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('rec.errors.explain'));
    } finally {
      setBusy(null);
    }
  };

  const analyse = async () => {
    setBusy('analyse');
    setError(undefined);
    try {
      const b = await apiRunRecEvidence(sourceSystem, externalId);
      setBundle(b);
      // Same bundle back means nothing changed, and its frame already stands.
      if (frame?.provenance.bundleId === b.id) return;
      setFrame(null);
      setFrame(await apiRenderRecFrame(b.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('rec.errors.analyse'));
    } finally {
      setBusy(null);
    }
  };

  const coverage = bundle?.detect?.coverage;
  const expected = coverage?.expected?.length ?? 0;
  const observed = coverage?.observed?.length ?? 0;
  const answer = frame?.answer;

  const chip = !bundle ? null
    : bundle.status === 'ready' && bundle.outcome
      ? <Chip tone={OUTCOME_TONE[bundle.outcome]}>{t(`rec.outcome.${bundle.outcome}`)}</Chip>
      : <Chip tone="slate">{t(`rec.reason.${bundle.reason}`, { defaultValue: bundle.reason ?? bundle.status })}</Chip>;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left cursor-pointer">
        <span className="flex items-center gap-2 flex-wrap">
          <Lightbulb className="w-4 h-4 text-sky-600" />
          <span className="font-semibold text-slate-900 dark:text-white text-base">{t('rec.title')}</span>
          {chip}
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

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-slate-500 dark:text-slate-400">
              {!loaded ? t('rec.loading')
                : bundle ? t('rec.asOf', { at: new Date(bundle.asOf).toLocaleString() })
                  : t('rec.notYet')}
              {bundle && expected > 0 && <> · {t('rec.coverage', { observed, expected })}</>}
            </p>
            <div className="flex items-center gap-2">
              {bundle && !frame && (
                <button onClick={() => explain(bundle)} disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold disabled:opacity-50 cursor-pointer">
                  {busy === 'explain' ? t('rec.explaining') : t('rec.explain')}
                </button>
              )}
              <button onClick={analyse} disabled={busy !== null || !loaded}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                <RotateCw className={`w-3.5 h-3.5 ${busy === 'analyse' ? 'animate-spin' : ''}`} />
                {busy === 'analyse' ? t('rec.analysing') : bundle ? t('rec.analyseAgain') : t('rec.analyse')}
              </button>
            </div>
          </div>

          {answer && (
            <>
              <div className="text-sm text-slate-800 dark:text-slate-100 leading-relaxed"><ChatMarkdown text={answer.summary} /></div>

              {answer.observations.length > 0 && (
                <Block title={t('rec.observations')}>
                  <ul className="list-disc pl-4 space-y-1">{answer.observations.map((o, i) => <li key={i}>{o.claim}</li>)}</ul>
                </Block>
              )}

              {answer.hypotheses.length > 0 && (
                <Block title={t('rec.hypotheses')}>
                  {answer.hypotheses.map((h, i) => (
                    <div key={i} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-1">
                      <p className="text-slate-800 dark:text-slate-100">{h.claim}</p>
                      {h.limitations.map((l, j) => <p key={j} className="text-[11px] text-slate-500 dark:text-slate-400">{l}</p>)}
                    </div>
                  ))}
                </Block>
              )}

              {answer.next_steps.length > 0 && (
                <Block title={t('rec.nextSteps')}>
                  <ol className="list-decimal pl-4 space-y-1.5">
                    {answer.next_steps.map((s, i) => (
                      <li key={i}>
                        <span className="text-slate-800 dark:text-slate-100">{s.aim}</span>
                        {s.expected_outcome && <span className="block text-[11px] text-slate-500 dark:text-slate-400">{s.expected_outcome}</span>}
                      </li>
                    ))}
                  </ol>
                </Block>
              )}

              {answer.missing_inputs.length > 0 && (
                <Block title={t('rec.missing')}>
                  <ul className="list-disc pl-4 space-y-1 text-amber-700 dark:text-amber-300">
                    {/* Two kinds today (render.ts): an unbound signal, and a cost parameter the account has not set. */}
                    {answer.missing_inputs.map((m, i) => (
                      <li key={i}>
                        {m.startsWith('signal_binding:')
                          ? t('rec.missingBinding', { signal: m.slice('signal_binding:'.length) })
                          : t('rec.missingParameter', { name: m.replace(/_/g, ' ') })}
                      </li>
                    ))}
                  </ul>
                </Block>
              )}

              {answer.limitations.length > 0 && (
                <Block title={t('rec.limitations')}>
                  <ul className="list-disc pl-4 space-y-1 text-slate-500 dark:text-slate-400">{answer.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
                </Block>
              )}

              <p className="text-[11px] text-slate-400">
                {frame!.provenance.renderer === 'model'
                  ? t('rec.byModel', { model: frame!.provenance.modelId ?? '' })
                  : t('rec.byTemplate', { version: frame!.provenance.rendererVersion })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1.5">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
    <div className="text-slate-700 dark:text-slate-200">{children}</div>
  </div>
);
