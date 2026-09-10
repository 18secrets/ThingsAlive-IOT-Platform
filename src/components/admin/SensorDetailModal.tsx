import React from 'react';
import { X, Activity, Radio, Cpu, Calendar, CheckCircle2 } from 'lucide-react';
import { SensorItem } from '../../types';

interface SensorDetailModalProps {
  sensor: SensorItem | null;
  onClose: () => void;
}

export const SensorDetailModal: React.FC<SensorDetailModalProps> = ({ sensor, onClose }) => {
  if (!sensor) return null;

  return (
    <div 
      id="sensorDetailOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/80">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-sky-100 dark:bg-sky-950 text-[#0077b6] dark:text-sky-400">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                Sensor Telemetry Specs
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{sensor.id}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Sensor Identifier</span>
              <div className="font-semibold text-slate-800 dark:text-white font-mono text-sm mt-0.5">{sensor.sensorName}</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Industry Domain</span>
              <div className="font-semibold text-slate-800 dark:text-white mt-0.5">{sensor.industryType}</div>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-sky-50/50 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider font-bold text-sky-700 dark:text-sky-300">
                Mapped Parameters & Telemetry Channels
              </span>
              <span className="text-[10px] bg-sky-200 dark:bg-sky-900 text-sky-800 dark:text-sky-200 px-2 py-0.5 rounded-full font-bold">
                {sensor.parameters?.length || 3} Active Channels
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {sensor.parameters?.map((p, idx) => (
                <span key={idx} className="px-2.5 py-1 rounded-md bg-white dark:bg-slate-800 border border-sky-200 dark:border-sky-800 text-slate-700 dark:text-slate-200 font-medium">
                  {p}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-2 text-slate-600 dark:text-slate-300 leading-relaxed">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Functional Description</span>
            <p className="p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700">
              {sensor.description || 'Monitors continuous operational parameters and telemetry signals.'}
            </p>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-700">
            <span>Created: {sensor.createdAt}</span>
            <span>Updated: {sensor.updatedAt}</span>
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
