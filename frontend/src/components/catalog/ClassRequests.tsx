import React, { useEffect, useMemo, useState } from 'react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { Inbox, Send } from 'lucide-react';
import {
  ApiError, ClassRequest, ClassRequestStatus, apiAnswerClassRequest, apiCreateClassRequest, apiListClassRequestQueue,
  apiListMyClassRequests,
} from '../../lib/api';
import { appLocale, appTimeZone } from '../../lib/dateLocale';
import { Modal } from '../common/Modal';
import { Chip, ChipTone } from '../common/Chip';
import { Skeleton } from '../common/Skeleton';

/**
 * Asking Things Alive for an equipment class the library does not have, and Things Alive
 * answering (test report OB-6). The backend landed on 9 Nov with no screen on either side:
 * a machine with no class was told to "ask Things Alive", with nowhere to ask.
 */

const STATUS_TONE: Record<ClassRequestStatus, ChipTone> = {
  new: 'sky', in_progress: 'amber', published: 'emerald', declined: 'slate',
};

const when = (iso: string) => new Date(iso).toLocaleDateString(appLocale(), { timeZone: appTimeZone(), day: 'numeric', month: 'short', year: 'numeric' });

const StatusChip: React.FC<{ status: ClassRequestStatus }> = ({ status }) => {
  const { t } = useTranslation('catalog');
  return <Chip tone={STATUS_TONE[status]}>{t(`classRequests.status.${status}`)}</Chip>;
};

const fieldLabel = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1';

/** The account's form. Only the machine type is required; the rest helps staff find the datasheet. */
export const ClassRequestModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSent: (request: ClassRequest) => void;
  /** What the person was registering, when they came from the machine form. */
  initial?: { manufacturer?: string; model?: string };
}> = ({ isOpen, onClose, onSent, initial }) => {
  const { t } = useTranslation('catalog');
  const [machineType, setMachineType] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [signals, setSignals] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    setMachineType(''); setManufacturer(initial?.manufacturer ?? ''); setModel(initial?.model ?? '');
    setSignals(''); setNote(''); setError(undefined);
  }, [isOpen, initial?.manufacturer, initial?.model]);

  // The table refuses a type under 2 characters; caught here so the button says so first.
  const valid = machineType.trim().length >= 2;

  const send = async () => {
    setSending(true); setError(undefined);
    try {
      const sent = await apiCreateClassRequest({
        machineType: machineType.trim(),
        manufacturer: manufacturer.trim() || undefined,
        model: model.trim() || undefined,
        signals: signals.split(',').map((s) => s.trim()).filter(Boolean),
        note: note.trim() || undefined,
      });
      onSent(sent);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('classRequests.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('classRequests.askTitle')} subtitle={t('classRequests.askSubtitle')} maxWidth="max-w-lg">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !sending) void send(); }}>
        <label className="block">
          <span className={fieldLabel}>{t('classRequests.machineType')} <span className="text-rose-500">*</span></span>
          <Input value={machineType} onChange={setMachineType} maxLength={120} placeholder={t('classRequests.machineTypePlaceholder')} />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>{t('classRequests.manufacturer')}</span>
            <Input value={manufacturer} onChange={setManufacturer} maxLength={120} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t('classRequests.model')}</span>
            <Input value={model} onChange={setModel} maxLength={120} />
          </label>
        </div>
        <label className="block">
          <span className={fieldLabel}>{t('classRequests.signals')}</span>
          <Input value={signals} onChange={setSignals} placeholder={t('classRequests.signalsPlaceholder')} />
          <span className="block text-xs text-slate-400 dark:text-slate-500 mt-1">{t('classRequests.signalsHint')}</span>
        </label>
        <label className="block">
          <span className={fieldLabel}>{t('classRequests.note')}</span>
          <Input as="textarea" rows={3} value={note} onChange={setNote} maxLength={2000} placeholder={t('classRequests.notePlaceholder')} />
        </label>
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm cursor-pointer">
            {t('classRequests.cancel')}
          </button>
          <button
            type="submit"
            disabled={!valid || sending}
            className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" /> {sending ? t('classRequests.sending') : t('classRequests.send')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/** The account's own requests and where each one is. Nothing at all until there is one. */
export const MyClassRequests: React.FC<{ requests: ClassRequest[] | null }> = ({ requests }) => {
  const { t } = useTranslation('catalog');
  if (!requests || requests.length === 0) return null;
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4 space-y-2">
      <h3 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-2">
        <Inbox className="w-4 h-4 text-slate-400" /> {t('classRequests.yours', { count: requests.length })}
      </h3>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {requests.map((r) => (
          <div key={r.id} className="py-2.5 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100 break-words">
                {r.machineType}
                {(r.manufacturer || r.model) && (
                  <span className="text-slate-400 font-normal"> · {[r.manufacturer, r.model].filter(Boolean).join(' ')}</span>
                )}
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('classRequests.asked', { when: when(r.createdAt) })}</p>
              {r.status === 'published' && r.publishedClassSlug && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">{t('classRequests.publishedAs', { slug: r.publishedClassSlug })}</p>
              )}
              {r.staffNote && <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 break-words">{t('classRequests.staffSaid', { note: r.staffNote })}</p>}
            </div>
            <div className="shrink-0"><StatusChip status={r.status} /></div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Loads the account's requests; `reload` after a new one is sent. */
export function useMyClassRequests(): { requests: ClassRequest[] | null; reload: () => void } {
  const [requests, setRequests] = useState<ClassRequest[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // A role without client-catalog.read simply has no list; nothing to say about it here.
    apiListMyClassRequests().then((r) => { if (live) setRequests(r); }).catch(() => { if (live) setRequests([]); });
    return () => { live = false; };
  }, [tick]);
  return { requests, reload: () => setTick((n) => n + 1) };
}

/** Staff: every account's requests, open ones first, and the three answers. */
export const ClassRequestQueue: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  /** Published classes to name when a request is answered with one. */
  classes: { slug: string; name: string; status: string }[];
  /** Answering is catalog.write; a role without it reads the queue. */
  canAnswer: boolean;
  onChanged?: (open: number) => void;
}> = ({ isOpen, onClose, classes, canAnswer, onChanged }) => {
  const { t } = useTranslation('catalog');
  const [rows, setRows] = useState<ClassRequest[] | null>(null);
  const [error, setError] = useState<string>();
  const [answering, setAnswering] = useState<{ id: string; kind: 'published' | 'declined' } | null>(null);
  const [note, setNote] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => apiListClassRequestQueue()
    .then((r) => { setRows(r); setError(undefined); onChanged?.(r.filter((x) => x.status === 'new' || x.status === 'in_progress').length); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('classRequests.loadFailed')));
  useEffect(() => { if (isOpen) { setRows(null); void load(); } }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const published = useMemo(
    () => classes.filter((c) => c.status === 'published').map((c) => ({ label: `${c.name} (${c.slug})`, value: c.slug })),
    [classes],
  );

  const answer = async (r: ClassRequest, status: ClassRequestStatus, extra: { staffNote?: string; publishedClassSlug?: string } = {}) => {
    setBusy(r.id); setError(undefined);
    try {
      await apiAnswerClassRequest(r.id, { status, ...extra });
      setAnswering(null); setNote(''); setSlug(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('classRequests.answerFailed'));
    } finally {
      setBusy(null);
    }
  };

  const open = (r: ClassRequest) => r.status === 'new' || r.status === 'in_progress';
  const button = 'px-2.5 py-1 rounded-lg text-xs font-semibold border cursor-pointer disabled:opacity-50';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('classRequests.queueTitle')} subtitle={t('classRequests.queueSubtitle')} maxWidth="max-w-3xl">
      <div className="space-y-3">
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        {rows === null ? <Skeleton lines={4} /> : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">{t('classRequests.queueEmpty')}</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <div key={r.id} className="py-3 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 break-words">
                      {r.machineType}
                      {(r.manufacturer || r.model) && (
                        <span className="text-slate-400 font-normal"> · {[r.manufacturer, r.model].filter(Boolean).join(' ')}</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{t('classRequests.fromAccount', { account: r.tenantId, when: when(r.createdAt) })}</p>
                    {r.signals.length > 0 && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 break-words">{t('classRequests.signalsList', { signals: r.signals.join(', ') })}</p>
                    )}
                    {r.note && <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 break-words">“{r.note}”</p>}
                    {r.publishedClassSlug && <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">{t('classRequests.publishedAs', { slug: r.publishedClassSlug })}</p>}
                    {r.staffNote && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 break-words">{t('classRequests.staffSaid', { note: r.staffNote })}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <StatusChip status={r.status} />
                    {canAnswer && open(r) && (
                      <>
                        {r.status === 'new' && (
                          <button disabled={busy === r.id} onClick={() => void answer(r, 'in_progress')}
                            className={`${button} border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30`}>
                            {t('classRequests.start')}
                          </button>
                        )}
                        <button disabled={busy === r.id} onClick={() => { setAnswering({ id: r.id, kind: 'published' }); setNote(''); setSlug(null); }}
                          className={`${button} border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30`}>
                          {t('classRequests.publish')}
                        </button>
                        <button disabled={busy === r.id} onClick={() => { setAnswering({ id: r.id, kind: 'declined' }); setNote(''); }}
                          className={`${button} border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800`}>
                          {t('classRequests.decline')}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {answering?.id === r.id && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3 space-y-2">
                    {answering.kind === 'published' && (
                      // A div, not a label: a label hands its click on to the picker a second
                      // time, and the menu opened and closed again at once.
                      <div className="block">
                        <span className={fieldLabel}>{t('classRequests.whichClass')} <span className="text-rose-500">*</span></span>
                        <SelectPicker data={published} value={slug} onChange={setSlug} block size="sm" placeholder={t('classRequests.pickClass')} />
                      </div>
                    )}
                    <label className="block">
                      <span className={fieldLabel}>
                        {answering.kind === 'declined' ? t('classRequests.whyDeclined') : t('classRequests.noteForAccount')}
                        {answering.kind === 'declined' && <span className="text-rose-500"> *</span>}
                      </span>
                      <Input as="textarea" rows={2} value={note} onChange={setNote} maxLength={2000} />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setAnswering(null)} className={`${button} border-slate-200 dark:border-slate-700`}>{t('classRequests.cancel')}</button>
                      <button
                        disabled={busy === r.id || (answering.kind === 'published' ? !slug : !note.trim())}
                        onClick={() => void answer(r, answering.kind, {
                          staffNote: note.trim() || undefined,
                          publishedClassSlug: answering.kind === 'published' ? slug ?? undefined : undefined,
                        })}
                        className={`${button} border-transparent bg-[#0B7285] hover:bg-[#095C6B] text-white`}
                      >
                        {answering.kind === 'published' ? t('classRequests.confirmPublish') : t('classRequests.confirmDecline')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};
