import React, { useState } from 'react';
import { Calendar, User, Pencil } from 'lucide-react';
import { ShieldEvidenceRecord, ShieldResult, ShieldStatus } from '../../data/shieldMockData';

const STATUS_STYLE: Record<ShieldStatus, string> = {
  Current: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900',
  'Due soon': 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
  Overdue: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  'Action required': 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
};

const STATUS_TEXT: Record<ShieldStatus, string> = {
  Current: 'text-emerald-700 dark:text-emerald-400',
  'Due soon': 'text-amber-700 dark:text-amber-400',
  Overdue: 'text-rose-700 dark:text-rose-400',
  'Action required': 'text-rose-700 dark:text-rose-400',
};

export const EvidenceRecordCard: React.FC<{ record: ShieldEvidenceRecord; onEdit: () => void }> = ({ record, onEdit }) => (
  <div className={`border rounded-xl p-3.5 space-y-2 ${STATUS_STYLE[record.status]}`}>
    <div className="flex items-start justify-between gap-2">
      <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{record.title}</h4>
      <span className={`shrink-0 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-white/70 dark:bg-slate-900/50 ${STATUS_TEXT[record.status]}`}>
        {record.status}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
      <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{record.dueDate}</span>
      <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{record.owner}</span>
      <span className="font-mono text-[10px] text-slate-400" title={record.reference}>{record.reference}</span>
    </div>
    {(record.findings || record.note) && (
      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate" title={record.findings || record.note}>
        {record.findings || record.note}
      </p>
    )}
    <div className="flex items-center justify-between pt-1">
      <button onClick={onEdit} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
        <Pencil className="w-3 h-3" /> Edit
      </button>
      <span className="text-[10px] text-slate-400" title="Browser-local demonstration history; not a tamper-proof regulatory audit.">
        {new Date(record.createdAt).toLocaleDateString()}
      </span>
    </div>
  </div>
);

const RESULT_OPTIONS: ('Not assessed' | ShieldResult)[] = ['Not assessed', 'Passed', 'Attention', 'Failed'];

export const EvidenceRecordForm: React.FC<{
  initial?: ShieldEvidenceRecord;
  onCancel: () => void;
  onSave: (data: { title: string; reference: string; owner: string; dueDate: string; result: 'Not assessed' | ShieldResult; findings: string; reviewer: string; recordedBy: string }) => void;
}> = ({ initial, onCancel, onSave }) => {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [owner, setOwner] = useState(initial?.owner ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [result, setResult] = useState<'Not assessed' | ShieldResult>(initial?.result ?? 'Not assessed');
  const [findings, setFindings] = useState(initial?.findings ?? '');
  const [reviewer, setReviewer] = useState(initial?.reviewer ?? '');
  const [recordedBy, setRecordedBy] = useState(initial?.recordedBy ?? '');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSave({ title: title.trim(), reference: reference.trim(), owner: owner.trim(), dueDate, result, findings: findings.trim(), reviewer: reviewer.trim(), recordedBy: recordedBy.trim() });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Record title</span>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Requirement / document reference</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Responsible owner</span>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Due date</span>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Result</span>
        <select value={result} onChange={(e) => setResult(e.target.value as typeof result)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
          {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Evidence / inspection findings</span>
        <textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Reviewer</span>
        <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Recorded by</span>
        <input value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors">
          Save reviewed evidence
        </button>
      </div>
    </form>
  );
};
