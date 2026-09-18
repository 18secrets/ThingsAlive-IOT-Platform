import React, { useMemo, useState } from 'react';
import { Search, Plus, Edit2, AlertCircle, Cog, Fuel, Radio, Bell, Sigma, ArrowRight } from 'lucide-react';
import { EquipmentTemplate, EquipmentTemplateInput } from '../../lib/api';
import { AddEquipmentTemplateModal } from './AddEquipmentTemplateModal';

interface EquipmentTemplateViewProps {
  templates: EquipmentTemplate[];
  error?: string;
  onCreateTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenTemplate: (templateId: string) => void;
  /** Mock counts, keyed by template id — sensors/alerts/KPIs attached to it. */
  sensorCounts: Record<string, number>;
  alertCounts: Record<string, number>;
  kpiCounts: Record<string, number>;
}

export const EquipmentTemplateView: React.FC<EquipmentTemplateViewProps> = ({
  templates, error, onCreateTemplate, onUpdateTemplate, onOpenTemplate, sensorCounts, alertCounts, kpiCounts,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EquipmentTemplate | null>(null);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return templates.filter((t) =>
      t.name.toLowerCase().includes(term) ||
      (t.category?.toLowerCase().includes(term) ?? false) ||
      (t.manufacturer?.toLowerCase().includes(term) ?? false));
  }, [templates, searchTerm]);

  return (
    <div id="equipment-template-view" className="space-y-6">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Name, Category, or Manufacturer..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <button
          id="add-equipment-template-btn"
          onClick={() => { setEditingTemplate(null); setIsModalOpen(true); }}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New Template</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((t) => (
          <div
            key={t.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                {t.category ? (
                  <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                    {t.category}
                  </span>
                ) : <span />}
                <button
                  onClick={() => { setEditingTemplate(t); setIsModalOpen(true); }}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                  title="Edit"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">{t.name}</h4>
              {t.manufacturer && (
                <p className="text-[11px] text-slate-400 mt-0.5">{t.manufacturer}</p>
              )}
            </div>

            {t.description && (
              <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed">
                {t.description}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {t.engineType && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                  <Cog className="w-3 h-3 text-sky-600" />
                  <span>{t.engineType}</span>
                </div>
              )}
              {t.fuelTankCapacityLiters != null && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                  <Fuel className="w-3 h-3 text-sky-600" />
                  <span>{t.fuelTankCapacityLiters} L</span>
                </div>
              )}
              {t.serviceIntervalHours != null && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                  <span>{t.serviceIntervalHours} hrs service</span>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1" title="Sensors attached">
                  <Radio className="w-3 h-3 text-sky-600" />
                  {sensorCounts[t.id] ?? 0}
                </span>
                <span className="flex items-center gap-1" title="Alert rules">
                  <Bell className="w-3 h-3 text-amber-600" />
                  {alertCounts[t.id] ?? 0}
                </span>
                <span className="flex items-center gap-1" title="KPI formulas">
                  <Sigma className="w-3 h-3 text-emerald-600" />
                  {kpiCounts[t.id] ?? 0}
                </span>
              </div>
              <button
                onClick={() => onOpenTemplate(t.id)}
                className="flex items-center gap-1 text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer"
              >
                <span>Configure</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No equipment templates found.</span>
          </div>
        )}
      </div>

      <AddEquipmentTemplateModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingTemplate(null); }}
        onCreate={onCreateTemplate}
        onUpdate={onUpdateTemplate}
        existingTemplate={editingTemplate}
      />
    </div>
  );
};
