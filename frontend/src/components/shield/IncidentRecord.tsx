import React, { useState } from 'react';
import { AlertTriangle, Siren, Info as InfoIcon, User, Wrench, Pencil } from 'lucide-react';
import { FleetThing } from '../../data/fleetMockData';
import { IncidentCategory, IncidentSeverity, IncidentStatus, ShieldIncident } from '../../data/shieldMockData';

const SEVERITY_STYLE: Record<IncidentSeverity, string> = {
  Critical: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900',
  Warning: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900',
  Info: 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-900',
};

const SEVERITY_TEXT: Record<IncidentSeverity, string> = {
  Critical: 'text-rose-700 dark:text-rose-400',
  Warning: 'text-amber-700 dark:text-amber-400',
  Info: 'text-sky-700 dark:text-sky-400',
};

const SEVERITY_ICON: Record<IncidentSeverity, React.FC<{ className?: string }>> = {
  Critical: Siren,
  Warning: AlertTriangle,
  Info: InfoIcon,
};

export const IncidentCard: React.FC<{ incident: ShieldIncident; onEdit: () => void; onViewWorkOrder: () => void }> = ({ incident, onEdit, onViewWorkOrder }) => {
  const SeverityIcon = SEVERITY_ICON[incident.severity];
  return (
    <div className={`border rounded-xl p-3.5 space-y-2 ${SEVERITY_STYLE[incident.severity]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <SeverityIcon className={`w-4 h-4 shrink-0 ${SEVERITY_TEXT[incident.severity]}`} />
          <h4 className="font-semibold text-slate-900 dark:text-white text-sm truncate">{incident.title}</h4>
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-white/70 dark:bg-slate-900/50 ${SEVERITY_TEXT[incident.severity]}`}>
          {incident.severity}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{incident.equipmentName} · {incident.category}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{incident.owner}</span>
        <span className="inline-flex items-center gap-1"><Wrench className="w-3 h-3" />{incident.workOrderStatus}</span>
        <span className="px-1.5 py-0.5 rounded bg-white/70 dark:bg-slate-900/50 text-[10px] font-medium">{incident.status}</span>
      </div>
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
            <Pencil className="w-3 h-3" /> Edit
          </button>
          <button onClick={onViewWorkOrder} className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-sky-600 text-white hover:bg-sky-700">
            Work order
          </button>
        </div>
        <span className="text-[10px] text-slate-400" title="Browser-local demonstration history; not a tamper-proof regulatory audit.">
          {new Date(incident.createdAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
};

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
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !equipmentCode) return;
        onSave({ equipmentCode, title: title.trim(), category, severity, status, owner: owner.trim(), investigation: investigation.trim(), correctiveAction: correctiveAction.trim(), closureEvidence: closureEvidence.trim(), independentReviewer: independentReviewer.trim(), recordedBy: recordedBy.trim() });
      }}
    >
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
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors">
          Save incident
        </button>
      </div>
    </form>
  );
};
