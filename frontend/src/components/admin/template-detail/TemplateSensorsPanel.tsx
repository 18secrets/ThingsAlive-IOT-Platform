import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Radio, X, Check } from 'lucide-react';
import { Sensor, SensorCategory } from '../../../lib/api';
import { sortByCategory } from '../../../lib/sensorCategoryOrder';

interface TemplateSensorsPanelProps {
  templateId: string;
  attachedSensorIds: string[];
  allSensors: Sensor[];
  categories: SensorCategory[];
  onAttach: (templateId: string, sensorId: string) => void;
  onDetach: (templateId: string, sensorId: string) => void;
}

export const TemplateSensorsPanel: React.FC<TemplateSensorsPanelProps> = ({
  templateId, attachedSensorIds, allSensors, categories, onAttach, onDetach,
}) => {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const categoryName = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? byId.get(id) ?? '—' : '—');
  }, [categories]);

  const attached = useMemo(
    () => sortByCategory(allSensors.filter((s) => attachedSensorIds.includes(s.id)), (s) => categoryName(s.categoryId), (s) => s.sensorName),
    [allSensors, attachedSensorIds, categoryName],
  );
  const available = useMemo(
    () => sortByCategory(allSensors.filter((s) => !attachedSensorIds.includes(s.id)), (s) => categoryName(s.categoryId), (s) => s.sensorName),
    [allSensors, attachedSensorIds, categoryName],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Sensors this class of equipment reports on. Their parameters are what alert rules and KPI formulas below can reference.
        </p>
        <button
          onClick={() => { setPendingIds([]); setIsPickerOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Sensor</span>
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
        {attached.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <Radio className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No sensors attached yet.</span>
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">Sensor</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Parameters</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {attached.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">{s.sensorName}</td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{categoryName(s.categoryId)}</td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {s.parameterSpecs.map((p) => (
                        <span key={p.parameter} className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 text-[10px]">
                          {p.parameter}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button
                      onClick={() => onDetach(templateId, s.id)}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isPickerOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
              <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">Add Sensors</h3>
              <button onClick={() => setIsPickerOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-2">
              {available.length === 0 ? (
                <p className="text-center text-slate-400 text-sm py-6">Every sensor is already attached.</p>
              ) : (
                available.map((s) => {
                  const checked = pendingIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPendingIds((prev) => (checked ? prev.filter((id) => id !== s.id) : [...prev, s.id]))}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors cursor-pointer text-left ${
                        checked
                          ? 'border-sky-300 dark:border-sky-700 bg-sky-50/40 dark:bg-sky-950/20'
                          : 'border-slate-200 dark:border-slate-700 hover:border-sky-300 hover:bg-sky-50/40 dark:hover:bg-sky-950/20'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          checked ? 'bg-[#0B7285] border-[#0B7285] text-white' : 'border-slate-300 dark:border-slate-600'
                        }`}>
                          {checked && <Check className="w-3 h-3" />}
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.sensorName}</div>
                          <div className="text-[11px] text-slate-400">{categoryName(s.categoryId)} · {s.parameterSpecs.length} parameters</div>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
            {available.length > 0 && (
              <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {pendingIds.length} selected
                </span>
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => setIsPickerOpen(false)}
                    className="px-4 py-2 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      pendingIds.forEach((id) => onAttach(templateId, id));
                      setIsPickerOpen(false);
                    }}
                    disabled={pendingIds.length === 0}
                    className="px-5 py-2 bg-[#0B7285] text-white hover:bg-[#095C6B] text-xs font-semibold rounded-lg shadow-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Add {pendingIds.length > 0 ? pendingIds.length : ''} Sensor{pendingIds.length === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
