import React, { useState } from 'react';
import { Calendar, User, Pencil } from 'lucide-react';
import { DatePicker, Input, SelectPicker } from 'rsuite';
import { ShieldEvidenceRecord, ShieldResult, ShieldStatus } from '../../data/shieldMockData';

// Evidence due dates are stored as plain 'YYYY-MM-DD' strings (matching the
// native <input type="date"> this replaced) — parsed/formatted in local time
// so the day shown in the picker is the day that gets saved, regardless of
// the browser's UTC offset.
function parseISODate(value: string): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatISODate(date: Date | null): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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
      <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate">{record.title}</h4>
      <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-white/70 dark:bg-slate-900/50 ${STATUS_TEXT[record.status]}`}>
        {record.status}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
      <span className="inline-flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{record.dueDate}</span>
      <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5" />{record.owner}</span>
      <span className="font-mono text-[11px] text-slate-400" title={record.reference}>{record.reference}</span>
    </div>
    {(record.findings || record.note) && (
      <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={record.findings || record.note}>
        {record.findings || record.note}
      </p>
    )}
    <div className="flex items-center justify-between pt-1">
      <button onClick={onEdit} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
        <Pencil className="w-3.5 h-3.5" /> Edit
      </button>
      <span className="text-[11px] text-slate-400" title="Browser-local demonstration history; not a tamper-proof regulatory audit.">
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
        <Input required value={title} onChange={(value) => setTitle(value)} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Requirement / document reference</span>
        <Input value={reference} onChange={(value) => setReference(value)} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Responsible owner</span>
        <Input value={owner} onChange={(value) => setOwner(value)} className="w-full" />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Due date</span>
        <DatePicker value={parseISODate(dueDate)} onChange={(date) => setDueDate(formatISODate(date))} format="yyyy-MM-dd" block />
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Result</span>
        <SelectPicker
          data={RESULT_OPTIONS.map((r) => ({ label: r, value: r }))}
          value={result}
          onChange={(value) => setResult((value ?? 'Not assessed') as typeof result)}
          searchable={false}
          cleanable={false}
          block
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Evidence / inspection findings</span>
        <Input as="textarea" value={findings} onChange={(value) => setFindings(value)} rows={3} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Reviewer</span>
        <Input value={reviewer} onChange={(value) => setReviewer(value)} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Recorded by</span>
        <Input value={recordedBy} onChange={(value) => setRecordedBy(value)} className="w-full" />
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
