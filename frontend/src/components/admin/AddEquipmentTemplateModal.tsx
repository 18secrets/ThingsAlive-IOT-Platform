import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { ApiError, EquipmentTemplate, EquipmentTemplateInput } from '../../lib/api';

interface AddEquipmentTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  existingTemplate?: EquipmentTemplate | null;
}

export const AddEquipmentTemplateModal: React.FC<AddEquipmentTemplateModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingTemplate,
}) => {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [engineType, setEngineType] = useState('');
  const [fuelTankCapacityLiters, setFuelTankCapacityLiters] = useState('');
  const [serviceIntervalHours, setServiceIntervalHours] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingTemplate;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingTemplate?.name ?? '');
    setCategory(existingTemplate?.category ?? '');
    setManufacturer(existingTemplate?.manufacturer ?? '');
    setEngineType(existingTemplate?.engineType ?? '');
    setFuelTankCapacityLiters(existingTemplate?.fuelTankCapacityLiters?.toString() ?? '');
    setServiceIntervalHours(existingTemplate?.serviceIntervalHours?.toString() ?? '');
    setDescription(existingTemplate?.description ?? '');
    setError(undefined);
  }, [isOpen, existingTemplate]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    if (!finalName) return;

    setBusy(true);
    setError(undefined);
    try {
      const input: EquipmentTemplateInput = {
        name: finalName,
        category: category.trim() || undefined,
        manufacturer: manufacturer.trim() || undefined,
        engineType: engineType.trim() || undefined,
        fuelTankCapacityLiters: fuelTankCapacityLiters.trim() ? Number(fuelTankCapacityLiters) : undefined,
        serviceIntervalHours: serviceIntervalHours.trim() ? Number(serviceIntervalHours) : undefined,
        description: description.trim() || undefined,
      };
      if (isEditing) {
        await onUpdate(existingTemplate!.id, input);
      } else {
        await onCreate(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the template.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addEquipmentTemplateModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Equipment Template' : 'New Equipment Template'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                Common fields for onboarding — not the prediction catalog.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Diesel Generator 500kVA"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Category <span className="text-slate-400 font-normal">(matched during onboarding)</span>
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Diesel Generator"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Manufacturer
              </label>
              <input
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="e.g. Cummins"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Engine Type
              </label>
              <input
                type="text"
                value={engineType}
                onChange={(e) => setEngineType(e.target.value)}
                placeholder="e.g. Diesel, 4-stroke"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Fuel Tank Capacity <span className="text-slate-400 font-normal">(liters)</span>
              </label>
              <input
                type="number"
                value={fuelTankCapacityLiters}
                onChange={(e) => setFuelTankCapacityLiters(e.target.value)}
                placeholder="e.g. 500"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Service Interval <span className="text-slate-400 font-normal">(hours)</span>
              </label>
              <input
                type="number"
                value={serviceIntervalHours}
                onChange={(e) => setServiceIntervalHours(e.target.value)}
                placeholder="e.g. 250"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this kind of equipment typically is..."
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all resize-none leading-relaxed"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? 'Saving…' : (isEditing ? 'Save Template' : 'Create Template')}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
