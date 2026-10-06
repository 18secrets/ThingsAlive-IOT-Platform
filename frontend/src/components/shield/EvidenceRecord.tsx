import React, { useState } from 'react';
import { ShieldEvidenceRecord, ShieldResult, ShieldStatus } from '../../data/shieldMockData';

const STATUS_STYLE: Record<ShieldStatus, string> = {
  Current: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900',
  'Due soon': 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
  Overdue: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  'Action required': 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
};

export const EvidenceRecordCard: React.FC<{ record: ShieldEvidenceRecord; onEdit: () => void }> = ({ record, onEdit }) => (
  <div className={`border rounded-xl p-4 space-y-2 ${STATUS_STYLE[record.status]}`}>
    <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{record.title}</h4>
    <p className="text-[12px] text-slate-600 dark:text-slate-300">Sample record · {record.result} · {record.status}</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">Due {record.dueDate} · {record.owner} · {record.reference}</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">{record.note}</p>
    {record.findings && <p className="text-[12px] text-slate-500 dark:text-slate-400">Findings: {record.findings}</p>}
    <button onClick={onEdit} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
      Edit evidence
    </button>
    <details>
      <summary className="text-[11px] font-medium text-slate-500 dark:text-slate-400 cursor-pointer">Change history (1)</summary>
      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
        <p><strong>1. Sample library</strong> · {new Date(record.createdAt).toLocaleString()}</p>
        <p>Illustrative sample record created</p>
        <p className="text-slate-400 dark:text-slate-500">Browser-local demonstration history; not a tamper-proof regulatory audit.</p>
      </div>
    </details>
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
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSave({ title: title.trim(), reference: reference.trim(), owner: owner.trim(), dueDate, result, findings: findings.trim(), reviewer: reviewer.trim(), recordedBy: recordedBy.trim() });
      }}
    >
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Evidence record</h4>
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
      <div className="flex flex-col gap-2 pt-1">
        <button type="submit" className="w-full px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">Save reviewed evidence</button>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
      </div>
    </form>
  );
};
