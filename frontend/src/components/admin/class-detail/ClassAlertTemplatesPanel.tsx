import React, { useMemo, useState } from 'react';
import { AlertCircle, Archive, Bell, ShieldAlert, UploadCloud } from 'lucide-react';
import { AlertRuleTemplate, AlertRuleTemplateInput } from '../../../lib/api';
import { AddAlertTemplateModal } from './AddAlertTemplateModal';

interface ClassAlertTemplatesPanelProps {
  equipmentClassSlug: string;
  availableSignals: string[];
  templates: AlertRuleTemplate[];
  error?: string;
  onCreate: (slug: string, equipmentClassSlug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  onUpdate: (slug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  onPublish: (slug: string) => Promise<void>;
  onRetire: (slug: string) => Promise<void>;
}

const STATUS_STYLE: Record<AlertRuleTemplate['status'], string> = {
  draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  published: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

const SEVERITY_STYLE: Record<AlertRuleTemplate['severity'], string> = {
  none: 'text-slate-400',
  low: 'text-sky-600 dark:text-sky-400',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-orange-600 dark:text-orange-400',
  critical: 'text-rose-600 dark:text-rose-400',
};

const TRIGGER_LABEL: Record<AlertRuleTemplate['trigger'], string> = {
  'signal-threshold': 'Signal Threshold',
  'prediction-severity': 'Prediction Severity',
  'no-telemetry': 'No Telemetry',
  'fuel-loss': 'Fuel Loss',
  'chain-origin': 'Chain Origin',
};

/** One card per slug: the draft in progress if any, else the latest published version. */
function representativePerSlug(rows: AlertRuleTemplate[]): AlertRuleTemplate[] {
  const bySlug = new Map<string, AlertRuleTemplate[]>();
  for (const row of rows) {
    const list = bySlug.get(row.slug) ?? [];
    list.push(row);
    bySlug.set(row.slug, list);
  }
  return Array.from(bySlug.values()).map((versions) =>
    versions.find((v) => v.status === 'draft')
      ?? versions.find((v) => v.status === 'published')
      ?? versions[0]);
}

export const ClassAlertTemplatesPanel: React.FC<ClassAlertTemplatesPanelProps> = ({
  equipmentClassSlug, availableSignals, templates, error, onCreate, onUpdate, onPublish, onRetire,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<AlertRuleTemplate | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const representatives = useMemo(() => representativePerSlug(templates), [templates]);

  const handlePublish = async (slug: string) => {
    setBusySlug(slug);
    await onPublish(slug);
    setBusySlug(null);
  };

  const handleRetire = async (slug: string) => {
    setBusySlug(slug);
    await onRetire(slug);
    setBusySlug(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg">
          What Things Alive knows is worth alerting on for this class. Publishing one
          means every account granted this class from now on gets a copy — accounts
          already granted keep running the version they already have.
        </p>
        <button
          onClick={() => { setEditingTemplate(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Bell className="w-4 h-4" />
          <span>New Alert Rule</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {representatives.map((tpl) => (
          <div
            key={tpl.slug}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-3"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{tpl.slug} · v{tpl.version}
                </span>
                <button
                  onClick={() => { setEditingTemplate(tpl); setIsModalOpen(true); }}
                  className="text-[11px] font-semibold text-slate-500 hover:text-sky-600 cursor-pointer"
                >
                  Edit draft
                </button>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">{tpl.name}</h4>
              {tpl.description && (
                <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed mt-1">
                  {tpl.description}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <div className={`flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700 ${SEVERITY_STYLE[tpl.severity]}`}>
                <ShieldAlert className="w-3 h-3" />
                <span className="capitalize">{tpl.severity}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Bell className="w-3 h-3 text-sky-600" />
                <span>{TRIGGER_LABEL[tpl.trigger]}</span>
              </div>
              {!tpl.enabledOnCopy && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                  <span>Off by default</span>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[tpl.status]}`}>
                {tpl.status}
              </span>
              {tpl.status === 'draft' && (
                <button
                  onClick={() => handlePublish(tpl.slug)}
                  disabled={busySlug === tpl.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer disabled:opacity-50"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Publish</span>
                </button>
              )}
              {tpl.status === 'published' && (
                <button
                  onClick={() => handleRetire(tpl.slug)}
                  disabled={busySlug === tpl.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 hover:text-rose-600 cursor-pointer disabled:opacity-50"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Retire</span>
                </button>
              )}
            </div>
          </div>
        ))}

        {representatives.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No alert rule templates yet for this class.</span>
          </div>
        )}
      </div>

      <AddAlertTemplateModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingTemplate(null); }}
        equipmentClassSlug={equipmentClassSlug}
        availableSignals={availableSignals}
        onCreate={onCreate}
        onUpdate={onUpdate}
        existingTemplate={editingTemplate}
      />
    </div>
  );
};
