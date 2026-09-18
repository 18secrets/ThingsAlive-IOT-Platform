import React, { useMemo, useState } from 'react';
import { Search, Library, Cog, Fuel } from 'lucide-react';
import { EquipmentTemplate, EquipmentTemplateInput } from '../../lib/api';
import { EquipmentTemplateView } from './EquipmentTemplateView';

interface ClientEquipmentTemplateViewProps {
  /** Master Admin's shared library — read-only here. Editing it stays Master Admin's job. */
  masterTemplates: EquipmentTemplate[];
  /** This client's own templates — full CRUD, invisible to Master Admin and every other client. */
  myTemplates: EquipmentTemplate[];
  myTemplatesError?: string;
  onCreateMyTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateMyTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenMyTemplate: (templateId: string) => void;
  mySensorCounts: Record<string, number>;
  myAlertCounts: Record<string, number>;
  myKpiCounts: Record<string, number>;
}

export const ClientEquipmentTemplateView: React.FC<ClientEquipmentTemplateViewProps> = ({
  masterTemplates, myTemplates, myTemplatesError,
  onCreateMyTemplate, onUpdateMyTemplate, onOpenMyTemplate,
  mySensorCounts, myAlertCounts, myKpiCounts,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredMaster = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return masterTemplates.filter((t) =>
      t.name.toLowerCase().includes(term) ||
      (t.category?.toLowerCase().includes(term) ?? false) ||
      (t.manufacturer?.toLowerCase().includes(term) ?? false));
  }, [masterTemplates, searchTerm]);

  return (
    <div id="client-equipment-template-view" className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Library className="w-4 h-4 text-sky-600" />
            <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Master Library</h3>
            <span className="text-[11px] text-slate-400">Provided by Things Alive — reference only</span>
          </div>
        </div>

        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search the master library..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredMaster.map((t) => (
            <div
              key={t.id}
              className="bg-slate-50/60 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                {t.category && (
                  <span className="font-mono text-[11px] font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                    {t.category}
                  </span>
                )}
              </div>
              <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{t.name}</h4>
              {t.manufacturer && <p className="text-[11px] text-slate-400">{t.manufacturer}</p>}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {t.engineType && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] rounded border border-slate-200 dark:border-slate-700">
                    <Cog className="w-2.5 h-2.5" />{t.engineType}
                  </span>
                )}
                {t.fuelTankCapacityLiters != null && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] rounded border border-slate-200 dark:border-slate-700 font-mono">
                    <Fuel className="w-2.5 h-2.5" />{t.fuelTankCapacityLiters} L
                  </span>
                )}
              </div>
            </div>
          ))}

          {filteredMaster.length === 0 && (
            <div className="col-span-full py-6 text-center text-slate-400 text-xs">
              No master templates match your search.
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2 pt-4">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">My Templates</h3>
          <span className="text-[11px] text-slate-400">Only visible in your account</span>
        </div>
        <EquipmentTemplateView
          templates={myTemplates}
          error={myTemplatesError}
          onCreateTemplate={onCreateMyTemplate}
          onUpdateTemplate={onUpdateMyTemplate}
          onOpenTemplate={onOpenMyTemplate}
          sensorCounts={mySensorCounts}
          alertCounts={myAlertCounts}
          kpiCounts={myKpiCounts}
        />
      </section>
    </div>
  );
};
