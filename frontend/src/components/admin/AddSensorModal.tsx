import React, { useState } from 'react';
import { X, Check, Plus, Trash2 } from 'lucide-react';
import { SensorItem, SensorParameterSpec } from '../../types';

interface AddSensorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sensor: SensorItem) => void;
  categories?: string[];
}

const emptySpec = (): SensorParameterSpec => ({
  parameter: '',
  unit: '',
  min: 0,
  max: 0,
  normalRange: '',
  notes: '',
});

export const AddSensorModal: React.FC<AddSensorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  categories = [],
}) => {
  const [category, setCategory] = useState(categories[0] || '');
  const [sensorName, setSensorName] = useState('');
  const [description, setDescription] = useState('');
  const [specs, setSpecs] = useState<SensorParameterSpec[]>([emptySpec()]);

  if (!isOpen) return null;

  const updateSpec = (index: number, field: keyof SensorParameterSpec, value: string) => {
    setSpecs((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        if (field === 'min' || field === 'max') {
          return { ...s, [field]: value === '' ? 0 : Number(value) };
        }
        return { ...s, [field]: value };
      })
    );
  };

  const addSpecRow = () => setSpecs((prev) => [...prev, emptySpec()]);
  const removeSpecRow = (index: number) =>
    setSpecs((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const resetForm = () => {
    setCategory(categories[0] || '');
    setSensorName('');
    setDescription('');
    setSpecs([emptySpec()]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sensorName.trim()) return;

    const validSpecs = specs.filter((s) => s.parameter.trim());

    const newSensor: SensorItem = {
      id: `SN-${Date.now().toString().slice(-6)}`,
      sensorName: sensorName.trim().replace(/\s+/g, '_'),
      code: `SNS-${Math.floor(10 + Math.random() * 90)}`,
      createdAt: '09-03-2026',
      updatedAt: '09-03-2026',
      description: description.trim() || 'Telematics channel monitoring transducer',
      category: category || undefined,
      parameters: validSpecs.length
        ? validSpecs.map((s) => s.parameter.trim())
        : ['Differential Pressure', 'Opacity', 'Temperature'],
      parameterSpecs: validSpecs.length ? validSpecs : undefined,
    };

    onSave(newSensor);
    resetForm();
    onClose();
  };

  return (
    <div
      id="addSensorModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
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

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs overflow-y-auto">
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Sensor Category <span className="text-red-500">*</span>
            </label>
            {categories.length > 0 ? (
              <select
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-sky-500 outline-none cursor-pointer"
              >
                <option value="">— Select Category —</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Engine, Hydraulics"
                className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-sky-500 outline-none"
              />
            )}
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
            <div className="flex items-center justify-between mb-1.5">
              <label className="block font-medium text-slate-700 dark:text-slate-300">
                Telemetry Parameters
              </label>
              <button
                type="button"
                onClick={addSpecRow}
                className="text-sky-600 dark:text-sky-400 font-medium flex items-center gap-1 hover:text-sky-700 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Parameter
              </button>
            </div>

            <div className="space-y-2">
              {specs.map((spec, index) => (
                <div
                  key={index}
                  className="grid grid-cols-12 gap-1.5 items-center bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-700 rounded-lg p-2"
                >
                  <input
                    type="text"
                    value={spec.parameter}
                    onChange={(e) => updateSpec(index, 'parameter', e.target.value)}
                    placeholder="Parameter (e.g. Engine RPM)"
                    className="col-span-4 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <input
                    type="text"
                    value={spec.unit}
                    onChange={(e) => updateSpec(index, 'unit', e.target.value)}
                    placeholder="Unit"
                    className="col-span-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <input
                    type="number"
                    value={spec.min}
                    onChange={(e) => updateSpec(index, 'min', e.target.value)}
                    placeholder="Min"
                    className="col-span-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <input
                    type="number"
                    value={spec.max}
                    onChange={(e) => updateSpec(index, 'max', e.target.value)}
                    placeholder="Max"
                    className="col-span-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <input
                    type="text"
                    value={spec.normalRange}
                    onChange={(e) => updateSpec(index, 'normalRange', e.target.value)}
                    placeholder="Normal Range"
                    className="col-span-3 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <input
                    type="text"
                    value={spec.notes}
                    onChange={(e) => updateSpec(index, 'notes', e.target.value)}
                    placeholder="Notes"
                    className="col-span-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-md px-2 py-1.5 focus:ring-2 focus:ring-sky-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeSpecRow(index)}
                    disabled={specs.length === 1}
                    className="col-span-1 flex items-center justify-center text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title="Remove parameter"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
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
