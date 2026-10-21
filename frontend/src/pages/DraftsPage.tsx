import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ExternalLink, RotateCw } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, Proposal, ProposalKind, ProposalReplayRun, ProposalStatus,
  apiApproveProposal, apiEnableProposalRule, apiGetProposal, apiGetProposalReplayRun, apiListProposals, apiRejectProposal,
} from '../lib/api';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Chip } from '../components/common/Chip';
import { Modal } from '../components/common/Modal';
import { TablePagination, usePagination } from '../components/common/TablePagination';

const STATUSES: ProposalStatus[] = ['draft_ready', 'materialised', 'rejected', 'gate_refused', 'compile_refused', 'expired', 'proposed', 'compiled', 'approved'];

const STATUS_TONE: Record<ProposalStatus, 'emerald' | 'amber' | 'rose' | 'slate' | 'sky'> = {
  draft_ready: 'amber', materialised: 'emerald', approved: 'emerald', rejected: 'slate', expired: 'slate',
  gate_refused: 'rose', compile_refused: 'rose', proposed: 'sky', compiled: 'sky',
};

const fail = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const machineOf = (p: Proposal) => {
  const t = p.target as { externalId?: string; clientEquipmentClassSlug?: string };
  return t.externalId ?? t.clientEquipmentClassSlug ?? '—';
};

/**
 * Generated drafts (QGEN1-3): what the platform proposed, where each stands, and the
 * decision that makes one real. Nothing here creates a draft — the Alert Agent's AI
 * assistant and a machine's KPI explorer do, from a closed list of intents. Approving is
 * the super admin's act (`proposal.approve`); a draft the gate could not validate is
 * created with its rules off, and switching one on is its own recorded choice.
 */
export const DraftsPage: React.FC = () => {
  const { t } = useTranslation('drafts');
  usePageHeader({ title: t('page.title'), subtitle: t('page.subtitle') });
  const [params, setParams] = useSearchParams();
  const [drafts, setDrafts] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ProposalKind | 'all'>(() => (['kpi', 'workflow'].includes(params.get('kind') ?? '') ? params.get('kind') as ProposalKind : 'all'));
  const [status, setStatus] = useState<ProposalStatus | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const openId = params.get('id');

  const load = () => {
    setLoading(true);
    apiListProposals()
      .then((list) => { setDrafts(list); setError(undefined); })
      .catch((err) => setError(fail(err, t('errors.load'))))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => (drafts ?? [])
    .filter((d) => (kind === 'all' || d.kind === kind) && (status === 'all' || d.status === status)), [drafts, kind, status]);
  const { pageItems, ...pager } = usePagination(filtered);

  const open = (id: string | null) => setParams(id ? { id } : {});

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <SelectPicker
            data={[{ label: t('filter.allKinds'), value: 'all' }, { label: t('kind.workflow'), value: 'workflow' }, { label: t('kind.kpi'), value: 'kpi' }]}
            value={kind}
            onChange={(v) => setKind((v ?? 'all') as ProposalKind | 'all')}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-48"
          />
          <SelectPicker
            data={[{ label: t('filter.allStatuses'), value: 'all' }, ...STATUSES.map((s) => ({ label: t(`status.${s}`), value: s }))]}
            value={status}
            onChange={(v) => setStatus((v ?? 'all') as ProposalStatus | 'all')}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-52"
          />
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-50 cursor-pointer self-start" title={t('refresh')}>
          <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">{t('col.kind')}</th>
                <th className="py-3 px-4 min-w-[280px]">{t('col.what')}</th>
                <th className="py-3 px-4">{t('col.machine')}</th>
                <th className="py-3 px-4">{t('col.status')}</th>
                <th className="py-3 px-4">{t('col.proposed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-200">
              {pageItems.map((d) => (
                <tr key={d.id} onClick={() => open(d.id)} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 cursor-pointer align-top">
                  <td className="py-3 px-4 font-semibold">{t(`kind.${d.kind}`)}</td>
                  <td className="py-3 px-4">
                    <div>{d.rendering[0] ?? d.sentence}</div>
                    {d.unvalidated && <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">{t('unvalidatedShort')}</div>}
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px]">{machineOf(d)}</td>
                  <td className="py-3 px-4"><Chip tone={STATUS_TONE[d.status]}>{t(`status.${d.expired ? 'expired' : d.status}`)}</Chip></td>
                  <td className="py-3 px-4 text-slate-500">{new Date(d.provenance.proposedAt).toLocaleString()}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="py-10 text-center text-slate-400">{drafts === null && !error ? t('loading') : t('empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && <TablePagination {...pager} />}
      </div>

      <Modal isOpen={!!openId} onClose={() => open(null)} title={t('detail.title')} maxWidth="max-w-3xl">
        {openId && <DraftDetail key={openId} id={openId} onChanged={load} />}
      </Modal>
    </div>
  );
};

const DraftDetail: React.FC<{ id: string; onChanged: () => void }> = ({ id, onChanged }) => {
  const { t } = useTranslation('drafts');
  const navigate = useNavigate();
  const [p, setP] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<(ProposalReplayRun & { firesDetail: { total?: number; kept?: number; windows?: { window: { start: string; shift: string }; summary: string }[] } }) | null>(null);

  useEffect(() => {
    apiGetProposal(id).then(setP).catch((err) => setError(fail(err, t('errors.load'))));
  }, [id]);

  const act = async (fn: () => Promise<Proposal | unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const out = await fn();
      if (out && typeof out === 'object' && 'status' in out && 'kind' in out) setP(out as Proposal);
      else setP(await apiGetProposal(id));
      setNotice(done);
      onChanged();
    } catch (err) {
      setError(fail(err, t('errors.action')));
    } finally {
      setBusy(false);
    }
  };

  if (!p) return <p className="text-sm text-slate-500">{error ?? t('loading')}</p>;

  const decidable = p.status === 'draft_ready' && !p.expired;
  const rules = p.materialisedRef?.ruleIds ?? [];
  const refused = p.compileResult && (p.compileResult as { refused?: boolean }).refused ? String((p.compileResult as { message?: string }).message ?? '') : null;

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={STATUS_TONE[p.status]}>{t(`status.${p.expired ? 'expired' : p.status}`)}</Chip>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{t(`kind.${p.kind}`)}</span>
            <span className="font-mono text-slate-500">{machineOf(p)}</span>
          </div>
          <p className="text-sm text-slate-800 dark:text-slate-100">{p.sentence}</p>
        </div>
      </div>

      {error && <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span></div>}
      {notice && <div className="flex items-start gap-2 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2"><CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{notice}</span></div>}

      {p.rendering.length > 0 && (
        <Block title={t('detail.whatItDoes')}>
          <ul className="list-disc pl-4 space-y-1">{p.rendering.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </Block>
      )}
      {refused && <Block title={t('detail.compileRefused')}><p className="text-rose-600 dark:text-rose-400">{refused}</p></Block>}

      {p.unvalidated && <p className="text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg px-3 py-2">{t('detail.unvalidated')}</p>}

      {p.replayRuns && p.replayRuns.length > 0 && (
        <Block title={t('detail.replay')}>
          <table className="w-full text-left">
            <thead className="text-slate-400">
              <tr><th className="py-1 pr-3">{t('col.machine')}</th><th className="py-1 pr-3">{t('detail.windows')}</th><th className="py-1 pr-3">{t('detail.fires')}</th><th className="py-1 pr-3">{t('detail.outcome')}</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {p.replayRuns.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="py-1.5 pr-3 font-mono">{r.externalId}</td>
                  <td className="py-1.5 pr-3">{r.windowsEvaluated}</td>
                  <td className="py-1.5 pr-3">{r.fires}</td>
                  <td className="py-1.5 pr-3">
                    <span className={r.outcome === 'pass' ? 'text-emerald-600' : r.outcome === 'refuse' ? 'text-rose-600' : 'text-amber-600'}>{t(`gate.${r.outcome}`)}</span>
                    <span className="block text-[11px] text-slate-500">{r.outcomeReason}</span>
                  </td>
                  <td className="py-1.5 text-right">
                    {r.fires > 0 && (
                      <button onClick={() => apiGetProposalReplayRun(p.id, r.id).then((x) => setRun(x as typeof run)).catch((err) => setError(fail(err, t('errors.load'))))}
                        className="text-sky-600 dark:text-sky-400 hover:underline cursor-pointer">{t('detail.whenFired')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {run && (
            <div className="mt-2 border border-slate-200 dark:border-slate-800 rounded-lg p-2 space-y-1 max-h-48 overflow-y-auto">
              <p className="text-slate-500">{t('detail.firedOn', { machine: run.externalId, total: run.firesDetail.total ?? run.fires, kept: run.firesDetail.kept ?? 0 })}</p>
              {(run.firesDetail.windows ?? []).map((w, i) => (
                <p key={i}><span className="font-mono text-slate-500">{new Date(w.window.start).toLocaleString()} · {w.window.shift}</span> — {w.summary}</p>
              ))}
            </div>
          )}
        </Block>
      )}

      <Block title={t('detail.provenance')}>
        <p className="text-slate-500">
          {t('detail.proposedAt', { at: new Date(p.provenance.proposedAt).toLocaleString(), emitter: `${p.provenance.emitterKind}@${p.provenance.emitterVersion}` })}
          {' · '}{t('detail.expiresAt', { at: new Date(p.expiresAt).toLocaleString() })}
        </p>
        {p.approval && <p className="text-emerald-600 dark:text-emerald-400">{t('detail.approvedAt', { at: new Date(p.approval.at).toLocaleString() })}</p>}
        {p.rejection && <p className="text-slate-500">{t('detail.rejectedAt', { at: new Date(p.rejection.at).toLocaleString() })}{p.rejection.reason ? ` — ${p.rejection.reason}` : ''}</p>}
      </Block>

      <div className="flex items-center justify-end gap-2 flex-wrap pt-2 border-t border-slate-100 dark:border-slate-800">
        {p.status === 'materialised' && p.kind === 'workflow' && (
          <button onClick={() => navigate('/alert-agent')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer">
            <ExternalLink className="w-3.5 h-3.5" />{t('detail.openAlertAgent')}
          </button>
        )}
        {p.status === 'materialised' && p.unvalidated && rules.map((ruleId, i) => (
          <button key={ruleId} disabled={busy}
            onClick={() => { if (window.confirm(t('detail.enableConfirm'))) act(() => apiEnableProposalRule(p.id, ruleId), t('detail.enabled')); }}
            className="px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 dark:text-amber-300 disabled:opacity-50 cursor-pointer">
            {t('detail.enableRule', { n: i + 1 })}
          </button>
        ))}
        {decidable && (
          <>
            <button disabled={busy}
              onClick={() => { const reason = window.prompt(t('detail.rejectReason')); if (reason !== null) act(() => apiRejectProposal(p.id, reason), t('detail.rejected')); }}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-50 cursor-pointer">{t('detail.reject')}</button>
            <button disabled={busy}
              onClick={() => { if (window.confirm(p.unvalidated ? t('detail.approveUnvalidatedConfirm') : t('detail.approveConfirm'))) act(() => apiApproveProposal(p.id), t('detail.approved')); }}
              className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-semibold disabled:opacity-50 cursor-pointer">{t('detail.approve')}</button>
          </>
        )}
      </div>
    </div>
  );
};

const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-1.5">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
    <div className="text-slate-700 dark:text-slate-200">{children}</div>
  </div>
);
