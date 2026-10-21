import React, { useState } from 'react';
import { AlertTriangle, Siren, Info as InfoIcon, User, Wrench, Pencil } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('incidents');
  const SeverityIcon = SEVERITY_ICON[incident.severity];
  return (
    <div className={`border rounded-xl p-3.5 space-y-2 ${SEVERITY_STYLE[incident.severity]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <SeverityIcon className={`w-4.5 h-4.5 shrink-0 ${SEVERITY_TEXT[incident.severity]}`} />
          <h4 className="font-semibold text-slate-800 dark:text-white text-base truncate">{incident.title}</h4>
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-white dark:bg-slate-900/50 ${SEVERITY_TEXT[incident.severity]}`}>
          {t(`mock.severity.${incident.severity}`, { defaultValue: incident.severity })}
        </span>
      </div>
      <p className="text-md text-slate-700 dark:text-slate-400 truncate">{incident.equipmentCode} · {t(`mock.category.${incident.category}`, { defaultValue: incident.category })}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 dark:text-slate-300">
        <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5" />{incident.owner}</span>
        <span className="inline-flex items-center gap-1"><Wrench className="w-3.5 h-3.5" />{t(`mock.status.${incident.workOrderStatus}`, { defaultValue: incident.workOrderStatus })}</span>
        <span className="px-1.5 py-0.5 rounded bg-white/70 dark:bg-slate-900/50 text-sm font-medium">{t(`mock.status.${incident.status}`, { defaultValue: incident.status })}</span>
      </div>
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:border-sky-400">
            <Pencil className="w-3.5 h-3.5" /> {t('mock.edit')}
          </button>
          <button onClick={onViewWorkOrder} className="px-2.5 py-1 text-xs font-medium rounded-md bg-sky-600 text-white hover:bg-sky-700">
            {t('mock.workOrder')}
          </button>
        </div>
        <span className="text-[11px] text-slate-400" title={t('mock.historyNote')}>
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
  const { t } = useTranslation('incidents');
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
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.thing')}</span>
        <SelectPicker
          data={things.map((th) => ({ label: th.name, value: th.id }))}
          value={equipmentCode}
          onChange={(value) => setEquipmentCode(value ?? things[0]?.id ?? '')}
          searchable={false}
          cleanable={false}
          block
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.incidentTitle')}</span>
        <Input required value={title} onChange={(value) => setTitle(value)} className="w-full" />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.categoryLabel')}</span>
        <SelectPicker
          data={CATEGORY_OPTIONS.map((c) => ({ label: t(`mock.category.${c}`), value: c }))}
          value={category}
          onChange={(value) => setCategory((value ?? CATEGORY_OPTIONS[0]) as IncidentCategory)}
          searchable={false}
          cleanable={false}
          block
        />
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.severityLabel')}</span>
        <SelectPicker
          data={SEVERITY_OPTIONS.map((s) => ({ label: t(`mock.severity.${s}`), value: s }))}
          value={severity}
          onChange={(value) => setSeverity((value ?? SEVERITY_OPTIONS[0]) as IncidentSeverity)}
          searchable={false}
          cleanable={false}
          block
        />
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.statusLabel')}</span>
        <SelectPicker
          data={STATUS_OPTIONS.map((s) => ({ label: t(`mock.status.${s}`), value: s }))}
          value={status}
          onChange={(value) => setStatus((value ?? STATUS_OPTIONS[0]) as IncidentStatus)}
          searchable={false}
          cleanable={false}
          block
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.actionOwner')}</span>
        <Input value={owner} onChange={(value) => setOwner(value)} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.investigation')}</span>
        <Input as="textarea" value={investigation} onChange={(value) => setInvestigation(value)} rows={3} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.correctiveAction')}</span>
        <Input as="textarea" value={correctiveAction} onChange={(value) => setCorrectiveAction(value)} rows={3} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.closureEvidence')}</span>
        <Input as="textarea" value={closureEvidence} onChange={(value) => setClosureEvidence(value)} rows={3} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.independentReviewer')}</span>
        <Input value={independentReviewer} onChange={(value) => setIndependentReviewer(value)} className="w-full" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mock.recordedBy')}</span>
        <Input value={recordedBy} onChange={(value) => setRecordedBy(value)} className="w-full" />
      </label>
      <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('mock.closureRule')}</p>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          {t('mock.cancel')}
        </button>
        <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors">
          {t('mock.save')}
        </button>
      </div>
    </form>
  );
};
