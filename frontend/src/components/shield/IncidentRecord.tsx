import React, { useState } from 'react';
import { FleetThing } from '../../data/fleetMockData';
import { IncidentCategory, IncidentSeverity, IncidentStatus, ShieldIncident } from '../../data/shieldMockData';

const SEVERITY_STYLE: Record<IncidentSeverity, string> = {
  Critical: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  Warning: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
  Info: 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-900',
};

export const IncidentCard: React.FC<{ incident: ShieldIncident; onEdit: () => void; onViewWorkOrder: () => void }> = ({ incident, onEdit, onViewWorkOrder }) => (
  <div className={`border rounded-xl p-4 space-y-1.5 ${SEVERITY_STYLE[incident.severity]}`}>
    <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Sample incident · {incident.category} · {incident.severity}</p>
    <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{incident.title}</h4>
    <p className="text-[12px] text-slate-600 dark:text-slate-300">{incident.equipmentName} · {incident.status} · {incident.owner}</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">{incident.note}</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">Action: Review evidence, assign corrective action and verify before closure.</p>
    <p className="text-[12px] text-slate-500 dark:text-slate-400">Work order: {incident.workOrderStatus}</p>
    <div className="flex items-center gap-2 pt-1">
      <button onClick={onEdit} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
        Edit incident
      </button>
      <button onClick={onViewWorkOrder} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
        View work order
      </button>
    </div>
    <details>
      <summary className="text-[11px] font-medium text-slate-500 dark:text-slate-400 cursor-pointer pt-1">Change history (1)</summary>
      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
        <p><strong>1. Sample library</strong> · {new Date(incident.createdAt).toLocaleString()}</p>
        <p>Illustrative sample record created</p>
        <p className="text-slate-400 dark:text-slate-500">Browser-local demonstration history; not a tamper-proof regulatory audit.</p>
      </div>
    </details>
  </div>
);

export interface IncidentFormValues {
  equipmentCode: string;
  title: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  owner: string;
  investigation: string;
  correctiveAction: string;
  closureEvidence: string;
  independentReviewer: string;
  recordedBy: string;
}

const CATEGORY_OPTIONS: IncidentCategory[] = ['Human safety', 'Machine wellbeing', 'Security'];
const SEVERITY_OPTIONS: IncidentSeverity[] = ['Critical', 'Warning', 'Info'];
const STATUS_OPTIONS: IncidentStatus[] = ['Open', 'Investigating', 'Resolved'];

export const IncidentForm: React.FC<{
  things: FleetThing[];
  initial?: ShieldIncident;
  defaultThingId?: string;
  onCancel: () => void;
  onSave: (values: IncidentFormValues) => void;
}> = ({ things, initial, defaultThingId, onCancel, onSave }) => {
  const [equipmentCode, setEquipmentCode] = useState(initial?.equipmentCode ?? defaultThingId ?? things[0]?.id ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState<IncidentCategory>(initial?.category ?? 'Human safety');
  const [severity, setSeverity] = useState<IncidentSeverity>(initial?.severity ?? 'Warning');
  const [status, setStatus] = useState<IncidentStatus>(initial?.status ?? 'Open');
  const [owner, setOwner] = useState(initial?.owner ?? '');
  const [investigation, setInvestigation] = useState(initial?.investigation ?? '');
  const [correctiveAction, setCorrectiveAction] = useState(initial?.correctiveAction ?? '');
  const [closureEvidence, setClosureEvidence] = useState(initial?.closureEvidence ?? '');
  const [independentReviewer, setIndependentReviewer] = useState(initial?.independentReviewer ?? '');
  const [recordedBy, setRecordedBy] = useState(initial?.recordedBy ?? '');

  return (
    <form
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !equipmentCode) return;
        onSave({ equipmentCode, title: title.trim(), category, severity, status, owner: owner.trim(), investigation: investigation.trim(), correctiveAction: correctiveAction.trim(), closureEvidence: closureEvidence.trim(), independentReviewer: independentReviewer.trim(), recordedBy: recordedBy.trim() });
      }}
    >
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Incident record</h4>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Thing</span>
        <select value={equipmentCode} onChange={(e) => setEquipmentCode(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
          {things.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Incident title</span>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value as IncidentCategory)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
          {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Severity</span>
        <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
          {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Action owner</span>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Investigation / root cause</span>
        <textarea value={investigation} onChange={(e) => setInvestigation(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Corrective action</span>
        <textarea value={correctiveAction} onChange={(e) => setCorrectiveAction(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Closure evidence</span>
        <textarea value={closureEvidence} onChange={(e) => setClosureEvidence(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Independent reviewer</span>
        <input value={independentReviewer} onChange={(e) => setIndependentReviewer(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Recorded by</span>
        <input value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
      </label>
      <p className="text-[11px] text-slate-400 dark:text-slate-500">Closure needs completed investigation and evidence, an independent reviewer and approval of any linked work order.</p>
      <div className="flex flex-col gap-2 pt-1">
        <button type="submit" className="w-full px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">Save incident</button>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
      </div>
    </form>
  );
};
