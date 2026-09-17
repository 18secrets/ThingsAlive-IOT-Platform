import React from 'react';
import { X, Activity } from 'lucide-react';
import { Sensor } from '../../lib/api';

interface SensorDetailModalProps {
  sensor: Sensor | null;
  categoryName?: string;
  onClose: () => void;
}

export const SensorDetailModal: React.FC<SensorDetailModalProps> = ({ sensor, categoryName, onClose }) => {
  if (!sensor) return null;

  return (
    <div
      id="sensorDetailOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/80">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-sky-100 dark:bg-sky-950 text-[#0077b6] dark:text-sky-400">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                Sensor Telemetry Specs
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">{sensor.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-xs overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Sensor Identifier</span>
              <div className="font-semibold text-slate-800 dark:text-white font-mono text-sm mt-0.5">{sensor.sensorName}</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Sensor Category</span>
              <div className="font-semibold text-slate-800 dark:text-white mt-0.5">{categoryName || '—'}</div>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-sky-50/50 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider font-bold text-sky-700 dark:text-sky-300">
                Telemetry Parameters
              </span>
              <span className="text-[10px] bg-sky-200 dark:bg-sky-900 text-sky-800 dark:text-sky-200 px-2 py-0.5 rounded-full font-bold">
                {sensor.parameterSpecs.length} Channels
              </span>
            </div>
            {sensor.parameterSpecs.length ? (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-sky-700/80 dark:text-sky-300/80">
                      <th className="px-1.5 py-1 font-semibold">Parameter</th>
                      <th className="px-1.5 py-1 font-semibold">Unit</th>
                      <th className="px-1.5 py-1 font-semibold">Range</th>
                      <th className="px-1.5 py-1 font-semibold">Normal</th>
                      <th className="px-1.5 py-1 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sensor.parameterSpecs.map((spec, idx) => (
                      <tr key={idx} className="border-t border-sky-100 dark:border-sky-900/40 align-top">
                        <td className="px-1.5 py-1.5 font-medium text-slate-800 dark:text-slate-100 whitespace-nowrap">{spec.parameter}</td>
                        <td className="px-1.5 py-1.5 text-slate-600 dark:text-slate-300 whitespace-nowrap">{spec.unit}</td>
                        <td className="px-1.5 py-1.5 text-slate-600 dark:text-slate-300 whitespace-nowrap">{spec.min} – {spec.max}</td>
                        <td className="px-1.5 py-1.5 text-slate-600 dark:text-slate-300 whitespace-nowrap">{spec.normalRange}</td>
                        <td className="px-1.5 py-1.5 text-slate-500 dark:text-slate-400">{spec.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-slate-400">No telemetry parameters declared.</p>
            )}
          </div>

          <div className="space-y-2 text-slate-600 dark:text-slate-300 leading-relaxed">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Functional Description</span>
            <p className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              {sensor.description || 'Monitors continuous operational parameters and telemetry signals.'}
            </p>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-700">
            <span>Created: {new Date(sensor.createdAt).toLocaleDateString()}</span>
            <span>Updated: {new Date(sensor.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="px-6 py-3 bg-slate-50 dark:bg-slate-800/80 border-t border-slate-200 dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 dark:bg-slate-700 text-white text-xs font-semibold rounded-lg hover:bg-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
