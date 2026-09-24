import React, { useMemo, useState } from 'react';
import { AlertCircle, Clock, Layers, Plus, ShieldAlert, UploadCloud } from 'lucide-react';
import { Scenario, ScenarioInput } from '../../../lib/api';
import { AddScenarioModal } from './AddScenarioModal';

interface ClassScenariosPanelProps {
  equipmentClassSlug: string;
  availableSignals: string[];
  scenarios: Scenario[];
  error?: string;
  onCreate: (slug: string, equipmentClassSlug: string, input: ScenarioInput) => Promise<Scenario>;
  onUpdate: (slug: string, input: ScenarioInput) => Promise<Scenario>;
  onPublish: (slug: string) => Promise<void>;
}

const STATUS_STYLE: Record<Scenario['status'], string> = {
  draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  published: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

const SEVERITY_STYLE: Record<Scenario['severity'], string> = {
  none: 'text-slate-400',
  low: 'text-sky-600 dark:text-sky-400',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-orange-600 dark:text-orange-400',
  critical: 'text-rose-600 dark:text-rose-400',
};

/** One card per slug: the draft in progress if any, else the latest published version. */
function representativePerSlug(rows: Scenario[]): Scenario[] {
  const bySlug = new Map<string, Scenario[]>();
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

export const ClassScenariosPanel: React.FC<ClassScenariosPanelProps> = ({
  equipmentClassSlug, availableSignals, scenarios, error, onCreate, onUpdate, onPublish,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingScenario, setEditingScenario] = useState<Scenario | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const representatives = useMemo(() => representativePerSlug(scenarios), [scenarios]);

  const handlePublish = async (slug: string) => {
    setBusySlug(slug);
    await onPublish(slug);
    setBusySlug(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg">
          Prediction scenarios for this class. Publishing one means every account
          granted this class from now on gets a copy — accounts already granted
          keep whichever version they last adopted.
        </p>
        <button
          onClick={() => { setEditingScenario(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New Scenario</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {representatives.map((sc) => (
          <div
            key={sc.slug}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-3"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{sc.slug} · v{sc.version}
                </span>
                <button
                  onClick={() => { setEditingScenario(sc); setIsModalOpen(true); }}
                  className="text-[11px] font-semibold text-slate-500 hover:text-sky-600 cursor-pointer"
                >
                  Edit draft
                </button>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">{sc.name}</h4>
              {sc.description && (
                <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed mt-1">
                  {sc.description}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <div className={`flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700 ${SEVERITY_STYLE[sc.severity]}`}>
                <ShieldAlert className="w-3 h-3" />
                <span className="capitalize">{sc.severity}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Layers className="w-3 h-3 text-sky-600" />
                <span>Tier {sc.tier}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Clock className="w-3 h-3 text-sky-600" />
                <span>{sc.minimumHistoryDays}d history</span>
              </div>
            </div>

            {sc.requiredSignals.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {sc.requiredSignals.map((s) => (
                  <span key={s} className="px-2 py-0.5 rounded bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[10px] font-mono border border-slate-200 dark:border-slate-700">
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[sc.status]}`}>
                {sc.status}
              </span>
              {sc.status === 'draft' && (
                <button
                  onClick={() => handlePublish(sc.slug)}
                  disabled={busySlug === sc.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer disabled:opacity-50"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Publish</span>
                </button>
              )}
            </div>
          </div>
        ))}

        {representatives.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No prediction scenarios yet for this class.</span>
          </div>
        )}
      </div>

      <AddScenarioModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingScenario(null); }}
        equipmentClassSlug={equipmentClassSlug}
        availableSignals={availableSignals}
        onCreate={onCreate}
        onUpdate={onUpdate}
        existingScenario={editingScenario}
      />
    </div>
  );
};
