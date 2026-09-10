import React, { useState } from 'react';
import { X, Check } from 'lucide-react';
import { SensorItem } from '../../types';

interface AddSensorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sensor: SensorItem) => void;
  industryTypes: string[];
}

export const AddSensorModal: React.FC<AddSensorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  industryTypes,
}) => {
  const [industryType, setIndustryType] = useState(industryTypes[0] || 'Cement & Building Materials');
  const [sensorName, setSensorName] = useState('');
  const [description, setDescription] = useState('');
  const [parameters, setParameters] = useState('Differential Pressure, Opacity, Temperature');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sensorName.trim()) return;

    const newSensor: SensorItem = {
      id: `SN-${Date.now().toString().slice(-6)}`,
      industryType: industryType,
      sensorName: sensorName.trim().replace(/\s+/g, '_'),
      code: `SNS-${Math.floor(10 + Math.random() * 90)}`,
      createdAt: '09-03-2026',
      updatedAt: '09-03-2026',
      description: description.trim() || 'Telematics channel monitoring transducer',
      parameters: parameters.split(',').map((p) => p.trim()).filter(Boolean)
    };

    onSave(newSensor);
    onClose();
  };

  return (
    <div 
      id="addSensorModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">
            Add New Telematics Sensor
          </h3>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Industry Type <span className="text-red-500">*</span>
            </label>
            <select 
              value={industryType}
              onChange={(e) => setIndustryType(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-sky-500 outline-none cursor-pointer"
            >
              {industryTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Sensor Name <span className="text-red-500">*</span>
            </label>
            <input 
              type="text" 
              required
              value={sensorName}
              onChange={(e) => setSensorName(e.target.value)}
              placeholder="e.g. Hydraulic_Oil_Pressure_Sensor" 
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-sky-500 outline-none font-mono"
            />
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Active Telemetry Parameters (comma separated)
            </label>
            <input 
              type="text" 
              value={parameters}
              onChange={(e) => setParameters(e.target.value)}
              placeholder="Differential Pressure, Opacity, Temp" 
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-sky-500 outline-none"
            />
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Description
            </label>
            <textarea 
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Operational sensor characteristics and telemetry frequency..." 
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-sky-500 outline-none resize-none"
            />
          </div>

          <div className="pt-3 flex items-center justify-end gap-2.5">
            <button 
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="px-5 py-2 rounded-lg bg-[#0077b6] hover:bg-[#023e8a] text-white font-medium shadow-xs flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              Save Sensor
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
