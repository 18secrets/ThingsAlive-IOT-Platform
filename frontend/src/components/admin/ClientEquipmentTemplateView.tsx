import React, { useMemo, useState } from 'react';
import { Search, Library, Cog, Fuel, Radio, Bell, Sigma, ArrowRight, AlertCircle } from 'lucide-react';
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
  /** Master Admin's own counts for the Master Library cards below — the defaults
   *  every client inherits, same numbers Master Admin's own list shows. */
  masterSensorCounts: Record<string, number>;
  masterAlertCounts: Record<string, number>;
  masterKpiCounts: Record<string, number>;
}

export const ClientEquipmentTemplateView: React.FC<ClientEquipmentTemplateViewProps> = ({
  masterTemplates, myTemplates, myTemplatesError,
  onCreateMyTemplate, onUpdateMyTemplate, onOpenMyTemplate,
  mySensorCounts, myAlertCounts, myKpiCounts,
  masterSensorCounts, masterAlertCounts, masterKpiCounts,
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
            <span className="text-[11px] text-slate-400">Provided by Things Alive — open one to add your own alerts, KPIs & predictive rules on top of its defaults</span>
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
              onClick={() => onOpenMyTemplate(t.id)}
              role="button"
              title="Configure your own alerts, KPIs & predictive rules for this class"
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4 cursor-pointer"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  {t.category ? (
                    <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                      {t.category}
                    </span>
                  ) : <span />}
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
                    {masterSensorCounts[t.id] ?? 0}
                  </span>
                  <span className="flex items-center gap-1" title="Alert rules">
                    <Bell className="w-3 h-3 text-amber-600" />
                    {masterAlertCounts[t.id] ?? 0}
                  </span>
                  <span className="flex items-center gap-1" title="KPI formulas">
                    <Sigma className="w-3 h-3 text-emerald-600" />
                    {masterKpiCounts[t.id] ?? 0}
                  </span>
                </div>
                <span className="flex items-center gap-1 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                  <span>Configure</span>
                  <ArrowRight className="w-3 h-3" />
                </span>
              </div>
            </div>
          ))}

          {filteredMaster.length === 0 && (
            <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
              <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
              <span>No master templates match your search.</span>
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
