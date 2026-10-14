import React, { useState } from 'react';
import { AlertCircle, Calendar, User, Pencil, History } from 'lucide-react';
import { DatePicker, Input, SelectPicker } from 'rsuite';
import { ApiError, ShieldEvidence, ShieldEvidenceInput, ShieldResult, ShieldStatus } from '../../lib/api';

// Dates are picked as calendar days and sent as local midnight, so the day shown in the
// picker is the day the backend stores whatever the browser's UTC offset.
function toDay(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

export const STATUS_LABEL: Record<ShieldStatus, string> = {
  action_required: 'Action required', overdue: 'Overdue', due_soon: 'Due soon', current: 'Current', not_recorded: 'Not recorded',
};

const STATUS_STYLE: Record<ShieldStatus, string> = {
  current: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900',
  due_soon: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
  overdue: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  action_required: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  not_recorded: 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700',
};

const STATUS_TEXT: Record<ShieldStatus, string> = {
  current: 'text-emerald-700 dark:text-emerald-400',
  due_soon: 'text-amber-700 dark:text-amber-400',
  overdue: 'text-rose-700 dark:text-rose-400',
  action_required: 'text-rose-700 dark:text-rose-400',
  not_recorded: 'text-slate-500 dark:text-slate-400',
};

const RESULT_LABEL: Record<ShieldResult, string> = { passed: 'Passed', attention: 'Attention', failed: 'Failed' };

/**
 * One record. `status` is only passed for the record the category's status was read
 * from; older and corrected records show their result, not a status of their own.
 */
export const EvidenceRecordCard: React.FC<{
  record: ShieldEvidence;
  status?: ShieldStatus;
  onCorrect?: () => void;
}> = ({ record, status, onCorrect }) => {
  const corrected = record.supersededById !== null;
  const tone: ShieldStatus = status ?? (corrected ? 'not_recorded' : record.result === 'passed' ? 'current' : 'action_required');
  return (
    <div className={`border rounded-xl p-3.5 space-y-2 ${STATUS_STYLE[tone]} ${corrected ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <h4 className={`font-semibold text-slate-900 dark:text-white text-base truncate ${corrected ? 'line-through' : ''}`}>{record.title}</h4>
        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-white/70 dark:bg-slate-900/50 ${STATUS_TEXT[tone]}`}>
          {corrected ? 'Corrected' : status ? STATUS_LABEL[status] : RESULT_LABEL[record.result]}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1" title="When the check was performed"><History className="w-3.5 h-3.5" />{fmtDay(record.performedAt)}</span>
        <span className="inline-flex items-center gap-1" title="Next check due"><Calendar className="w-3.5 h-3.5" />{record.dueAt ? `due ${fmtDay(record.dueAt)}` : 'one-off'}</span>
        {(record.ownerName || record.ownerUserId) && (
          <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5" />{record.ownerName ?? 'Account user'}</span>
        )}
        {record.reference && <span className="font-mono text-[11px] text-slate-400" title={record.reference}>{record.reference}</span>}
        <span className="text-[11px] text-slate-400">· {RESULT_LABEL[record.result]}</span>
      </div>
      {record.findings && (
        <p className="text-xs text-slate-500 dark:text-slate-400" title={record.findings}>{record.findings}</p>
      )}
      <div className="flex items-center justify-between pt-1">
        {onCorrect && !corrected ? (
          <button onClick={onCorrect} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400 cursor-pointer">
            <Pencil className="w-3.5 h-3.5" /> Correct
          </button>
        ) : <span />}
        <span className="text-[11px] text-slate-400" title="Recorded in the platform; corrections are added, never overwritten">
          Recorded {new Date(record.recordedAt).toLocaleString()}{record.supersedesId ? ' · a correction' : ''}
        </span>
      </div>
    </div>
  );
};

const RESULT_OPTIONS: ShieldResult[] = ['passed', 'attention', 'failed'];

/** Adds a record, or — with `initial` — files a correction of it. The original stays. */
export const EvidenceRecordForm: React.FC<{
  initial?: ShieldEvidence;
  onCancel: () => void;
  onSave: (input: ShieldEvidenceInput) => Promise<void>;
}> = ({ initial, onCancel, onSave }) => {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [result, setResult] = useState<ShieldResult>(initial?.result ?? 'passed');
  const [performedAt, setPerformedAt] = useState<Date | null>(toDay(initial?.performedAt ?? null) ?? new Date());
  const [dueAt, setDueAt] = useState<Date | null>(toDay(initial?.dueAt ?? null));
  const [ownerName, setOwnerName] = useState(initial?.ownerName ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [findings, setFindings] = useState(initial?.findings ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The backend needs an owner (a user id or a name); a correction of a record owned by
  // a user keeps that user unless a name replaces it.
  const keepsUserOwner = !!initial?.ownerUserId && !ownerName.trim();
  const valid = !!title.trim() && !!performedAt && performedAt.getTime() <= Date.now() && (!!ownerName.trim() || keepsUserOwner);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || !performedAt) return;
        setBusy(true);
        setError(undefined);
        try {
          await onSave({
            title: title.trim(),
            result,
            performedAt: performedAt.toISOString(),
            dueAt: dueAt ? dueAt.toISOString() : null,
            ownerName: ownerName.trim() || null,
            ownerUserId: keepsUserOwner ? initial!.ownerUserId : null,
            reference: reference.trim() || null,
            findings: findings.trim() || null,
          });
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not save this record.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {initial && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
          A correction is saved as a new record that replaces this one. The original stays in the history, and a record can be corrected once.
        </p>
      )}
      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">What was checked</span>
        <Input required value={title} onChange={(value) => setTitle(value)} placeholder="e.g. Guard / isolation inspection" className="w-full" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Result</span>
          <SelectPicker
            data={RESULT_OPTIONS.map((r) => ({ label: RESULT_LABEL[r], value: r }))}
            value={result}
            onChange={(value) => setResult((value ?? 'passed') as ShieldResult)}
            searchable={false}
            cleanable={false}
            block
          />
        </div>
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Performed on</span>
          <DatePicker
            value={performedAt}
            onChange={(date) => setPerformedAt(date)}
            format="yyyy-MM-dd"
            shouldDisableDate={(date) => date.getTime() > Date.now()}
            cleanable={false}
            block
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Next check due (optional)</span>
          <DatePicker value={dueAt} onChange={(date) => setDueAt(date)} format="yyyy-MM-dd" placeholder="One-off" block />
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Owner</span>
          <Input
            value={ownerName}
            onChange={(value) => setOwnerName(value)}
            placeholder={keepsUserOwner ? 'Kept: the account user who owns it' : 'e.g. R. Kulkarni (contractor)'}
            className="w-full"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Requirement / document reference</span>
        <Input value={reference} onChange={(value) => setReference(value)} placeholder="e.g. CHK-2026-0412" className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Findings</span>
        <Input as="textarea" value={findings} onChange={(value) => setFindings(value)} rows={3} className="w-full" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!valid || busy} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {busy ? 'Saving…' : initial ? 'Save correction' : 'Save record'}
        </button>
      </div>
    </form>
  );
};
