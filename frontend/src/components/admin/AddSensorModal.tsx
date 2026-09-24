import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import {
  ApiError, Sensor, SensorCategory, SensorInput, SensorParameterSpec,
} from '../../lib/api';

interface AddSensorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: SensorInput) => Promise<Sensor>;
  onUpdate: (id: string, input: SensorInput) => Promise<Sensor>;
  categories: SensorCategory[];
  onCreateCategory: (name: string) => Promise<SensorCategory>;
  existingSensor?: Sensor | null;
}

const emptySpec = (): SensorParameterSpec => ({
  parameter: '', unit: '', min: 0, max: 0, normalRange: '', notes: '',
});

const NEW_CATEGORY = '__new__';

export const AddSensorModal: React.FC<AddSensorModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, categories, onCreateCategory, existingSensor,
}) => {
  const [categoryId, setCategoryId] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [sensorName, setSensorName] = useState('');
  const [description, setDescription] = useState('');
  const [specs, setSpecs] = useState<SensorParameterSpec[]>([emptySpec()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingSensor;

  useEffect(() => {
    if (!isOpen) return;
    setCategoryId(existingSensor?.categoryId ?? '');
    setNewCategoryName('');
    setSensorName(existingSensor?.sensorName ?? '');
    setDescription(existingSensor?.description ?? '');
    setSpecs(existingSensor?.parameterSpecs?.length ? existingSensor.parameterSpecs : [emptySpec()]);
    setError(undefined);
  }, [isOpen, existingSensor]);

  if (!isOpen) return null;

  const updateSpec = (index: number, field: keyof SensorParameterSpec, value: string) => {
    setSpecs((prev) => prev.map((s, i) => {
      if (i !== index) return s;
      if (field === 'min' || field === 'max') return { ...s, [field]: value === '' ? 0 : Number(value) };
      return { ...s, [field]: value };
    }));
  };
  const addSpecRow = () => setSpecs((prev) => [...prev, emptySpec()]);
  const removeSpecRow = (index: number) =>
    setSpecs((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = sensorName.trim();
    if (!finalName) return;
    if (categoryId === NEW_CATEGORY && !newCategoryName.trim()) return;

    const parameterSpecs = specs.filter((s) => s.parameter.trim());

    setBusy(true);
    setError(undefined);
    try {
      let finalCategoryId = categoryId || undefined;
      if (categoryId === NEW_CATEGORY) {
        const created = await onCreateCategory(newCategoryName.trim());
        finalCategoryId = created.id;
      }
      const input: SensorInput = {
        sensorName: finalName,
        categoryId: finalCategoryId,
        description: description.trim() || undefined,
        parameterSpecs,
      };
      if (isEditing) {
        await onUpdate(existingSensor!.id, input);
      } else {
        await onCreate(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the sensor.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addSensorModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">
            {isEditing ? 'Edit Telematics Sensor' : 'Add New Telematics Sensor'}
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
            <select
              required
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-sky-500 outline-none cursor-pointer"
            >
              <option value="">— Select Category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value={NEW_CATEGORY}>+ Add new category…</option>
            </select>
            {categoryId === NEW_CATEGORY && (
              <input
                type="text"
                autoFocus
                required
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="e.g. Engine, Hydraulics"
                className="w-full mt-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-sky-500 outline-none"
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

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

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
              disabled={busy}
              className="px-5 py-2 rounded-lg bg-[#0077b6] hover:bg-[#023e8a] text-white font-medium shadow-xs flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              {busy ? 'Saving…' : 'Save Sensor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
