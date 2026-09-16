import React, { useState } from 'react';
import { X, Check, Fuel, Info, ToggleLeft, ToggleRight } from 'lucide-react';
import { CategoryItem } from '../../types';

interface AddCategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (category: CategoryItem) => void;
  existingCategory?: CategoryItem | null;
}

export const AddCategoryModal: React.FC<AddCategoryModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingCategory,
}) => {
  const [name, setName] = useState(existingCategory?.name || 'Heavy Earthmovers & Excavation');
  const [code, setCode] = useState(existingCategory?.code || 'CAT-HEE-001');
  const [engineType, setEngineType] = useState(existingCategory?.engineType || 'Diesel (Internal Combustion)');
  const [fuelCapacity, setFuelCapacity] = useState(existingCategory?.fuelTankCapacityLiters || 400);
  const [description, setDescription] = useState(
    existingCategory?.description ||
    'Heavy-duty crawler excavators, motor graders, and bulldozers deployed for surface leveling, deep excavation, and quarry loading operations.'
  );
  const [statusActive, setStatusActive] = useState(existingCategory?.active ?? true);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newCat: CategoryItem = {
      id: existingCategory?.id || `cat-${Date.now()}`,
      name: name.trim() || 'New Equipment Category',
      code: code.trim() || 'CAT-NEW-01',
      engineType: engineType,
      fuelTankCapacityLiters: Number(fuelCapacity) || 0,
      description: description.trim(),
      createdAt: existingCategory?.createdAt || '07 Sep 2026',
      active: statusActive,
      equipmentCount: existingCategory?.equipmentCount || 0,
    };
    onSave(newCat);
    onClose();
  };

  return (
    <div 
      id="addCategoryModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {existingCategory ? 'Edit Equipment Category' : 'Add Equipment Category'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                Define classification specifications, telemetry bounds, and engine configurations
              </p>
            </div>
          </div>
          <button 
            id="close-category-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">
          
          {/* Row 1: Category Name & Category Code */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Category Name <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Infrastructure Earthmovers" 
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Category Code <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. CAT-001" 
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all font-mono"
              />
            </div>
          </div>

          {/* Row 2: Powertrain & Fuel Specifications (HIGHLIGHTED AS IN SCREENSHOT) */}
          <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fuel className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                <span className="text-xs font-bold text-slate-800 dark:text-white">Powertrain & Fuel Specifications</span>
              </div>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-sky-600 dark:text-sky-300 bg-sky-100/80 dark:bg-sky-900/60 px-2 py-0.5 rounded-md">
                New Configuration
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              {/* Engine Type Field */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Engine Type <span className="text-rose-500">*</span>
                </label>
                <select 
                  value={engineType}
                  onChange={(e) => setEngineType(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white appearance-none focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all pr-9 cursor-pointer"
                >
                  <option>Diesel (Internal Combustion)</option>
                  <option>Electric Drive (AC/DC)</option>
                  <option>Hybrid (Diesel-Electric)</option>
                  <option>CNG / Dual Fuel</option>
                  <option>Hydraulic Direct Drive</option>
                  <option>Liebherr 6-Cylinder Diesel</option>
                </select>
                <p className="text-[10px] text-slate-400 mt-1">Used to establish default emission & diagnostic thresholds</p>
              </div>

              {/* Fuel Tank Capacity Field */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Fuel Tank Capacity <span className="text-slate-400 font-normal">(Liters)</span>
                </label>
                <div className="relative">
                  <input 
                    type="number" 
                    value={fuelCapacity}
                    onChange={(e) => setFuelCapacity(Number(e.target.value))}
                    placeholder="e.g. 400" 
                    className="w-full pl-3.5 pr-14 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
                  />
                  <span className="absolute right-3.5 top-2.5 text-[11px] font-semibold text-slate-400">Liters</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">Enables automated telemetry fuel percentage normalization</p>
              </div>
            </div>
          </div>

          {/* Row 4: Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <textarea 
              rows={3} 
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this category, operational scope, and standard equipment specs..." 
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all resize-none leading-relaxed"
            />
          </div>

          {/* Status toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-700/30">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                <Check className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Category Status</div>
                <div className="text-[11px] text-slate-400">Enable this category immediately across equipment assignment</div>
              </div>
            </div>
            
            <button
              type="button"
              onClick={() => setStatusActive(!statusActive)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                statusActive ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  statusActive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Modal Footer Buttons */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" /> 
              Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory
            </span>
            <div className="flex items-center gap-3">
              <button 
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button 
                type="submit"
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Save Category</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
