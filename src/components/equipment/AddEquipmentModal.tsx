import React, { useState, useEffect, useMemo } from 'react';
import { X, Check, Cpu, Layers, Radio, MapPin, Sparkles } from 'lucide-react';
import { EquipmentItem, ToolMappingItem, SensorItem, CategoryItem } from '../../types';

interface AddEquipmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (equipment: EquipmentItem) => void;
  categories: (CategoryItem | string)[];
  plants: string[];
  toolMappings: ToolMappingItem[];
  sensors: SensorItem[];
}

export const AddEquipmentModal: React.FC<AddEquipmentModalProps> = ({
  isOpen,
  onClose,
  onSave,
  categories,
  plants,
  toolMappings,
  sensors,
}) => {
  // Normalize categories to handle both CategoryItem objects and string identifiers
  const categoryItems = useMemo<CategoryItem[]>(() => {
    return categories.map((cat, idx) => {
      if (typeof cat === 'string') {
        return {
          id: `cat-${idx}`,
          name: cat,
          code: `CAT-${idx + 1}`,
          engineType: 'Diesel (Internal Combustion)',
          fuelTankCapacityLiters: 400,
          description: '',
          createdAt: '',
          active: true,
        };
      }
      return cat;
    });
  }, [categories]);

  const initialCat = categoryItems[0];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(initialCat?.name || '');
  const [maintPlant, setMaintPlant] = useState(plants[0] || '');
  const [manufacturer, setManufacturer] = useState('');
  const [engineType, setEngineType] = useState(initialCat?.engineType || 'Diesel (Internal Combustion)');
  const [partNo, setPartNo] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [benchmark, setBenchmark] = useState('');
  const [serialNo, setSerialNo] = useState('');
  const [enginePower, setEnginePower] = useState('');
  const [cclNumber, setCclNumber] = useState('');
  const [fuelCapacity, setFuelCapacity] = useState(
    initialCat?.fuelTankCapacityLiters !== undefined && initialCat?.fuelTankCapacityLiters !== null
      ? initialCat.fuelTankCapacityLiters.toString()
      : '400'
  );
  const [justAutoFilled, setJustAutoFilled] = useState(false);

  // Active category object
  const currentSelectedCategory = useMemo(() => {
    return categoryItems.find(c => c.name === category) || categoryItems[0];
  }, [categoryItems, category]);

  // Handle Category selection and automatically prefill Engine Type & Tank Capacity from Admin Category
  const handleCategoryChange = (selectedCategoryName: string) => {
    setCategory(selectedCategoryName);
    const matchedCategory = categoryItems.find(c => c.name === selectedCategoryName);
    if (matchedCategory) {
      if (matchedCategory.engineType) {
        setEngineType(matchedCategory.engineType);
      }
      if (matchedCategory.fuelTankCapacityLiters !== undefined && matchedCategory.fuelTankCapacityLiters !== null) {
        setFuelCapacity(matchedCategory.fuelTankCapacityLiters.toString());
      }
      setJustAutoFilled(true);
      setTimeout(() => setJustAutoFilled(false), 2500);
    }
  };

  // Sync initial category and pre-fill specs when modal opens or category list updates
  useEffect(() => {
    if (isOpen && categoryItems.length > 0) {
      const activeCatName = category || categoryItems[0]?.name || '';
      if (!category) {
        setCategory(categoryItems[0].name);
      }
      const matched = categoryItems.find(c => c.name === activeCatName) || categoryItems[0];
      if (matched) {
        if (matched.engineType) {
          setEngineType(matched.engineType);
        }
        if (matched.fuelTankCapacityLiters !== undefined && matched.fuelTankCapacityLiters !== null) {
          setFuelCapacity(matched.fuelTankCapacityLiters.toString());
        }
      }
    }
  }, [isOpen, categoryItems]);

  useEffect(() => {
    if (!maintPlant && plants.length > 0) {
      setMaintPlant(plants[0]);
    }
  }, [plants, maintPlant]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !cclNumber) return;

    const newItem: EquipmentItem = {
      id: Math.floor(20 + Math.random() * 80),
      name: name.trim(),
      description: description.trim() || 'Heavy industrial equipment onboarded to telematics network',
      category: category || (categories[0] ?? 'Industrial Category'),
      maintPlant: maintPlant || (plants[0] ?? 'Central Plant'),
      cclNumber: cclNumber.trim(),
      manufacturer: manufacturer.trim() || 'OEM Standard',
      modelNumber: modelNumber.trim() || 'HD-2026',
      licensePlate: licensePlate.trim() || 'DL01EQ0001',
      engine: engineType.trim() || 'Diesel Engine',
      status: 'Active',
      onboardStatus: 'Onboarded',
      partNo: partNo.trim(),
      serialNo: serialNo.trim(),
      fuelCapacity: fuelCapacity ? Number(fuelCapacity) : undefined,
    };

    onSave(newItem);
    onClose();
  };

  return (
    <div 
      id="addEquipmentModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
                Add New Equipment Setup
              </h3>
              <span className="px-2.5 py-0.5 bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 text-xs font-medium rounded border border-sky-200 dark:border-sky-800">
                Admin Master Linked
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-sans">
              Selecting a Category automatically pre-fills the Engine Type and Fuel Tank Capacity configured in Admin.
            </p>
          </div>
          <button 
            id="close-equipment-modal"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5 text-sm font-sans">
          
          {/* Admin Master Values Notice Banner */}
          <div className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-between flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-400">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-600" />
              <span>Synced with Admin: <strong className="text-slate-800 dark:text-slate-200">{categories.length} Categories</strong> • <strong className="text-slate-800 dark:text-slate-200">{plants.length} Plants</strong> • <strong className="text-slate-800 dark:text-slate-200">{toolMappings.length} Tool Mappings</strong></span>
            </div>
            <span className="text-xs text-sky-600 dark:text-sky-400 font-medium">Live Bound</span>
          </div>

          {/* Row 1: Name & Description */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Equipment Name <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Komatsu PC210LC" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Description <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Equipment role & function" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>
          </div>

          {/* Row 2: Category & Maintenance Plant (Strictly from Admin) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Category (from Admin) <span className="text-rose-500">*</span>
                </label>
                {currentSelectedCategory && (
                  <span className="text-xs text-sky-600 dark:text-sky-400 flex items-center gap-1 font-medium">
                    <Sparkles className="w-3 h-3 text-sky-500" />
                    <span>Auto-fills Engine & Tank</span>
                  </span>
                )}
              </div>
              <select 
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                {categoryItems.length === 0 ? (
                  <option value="">No categories defined in Admin</option>
                ) : (
                  categoryItems.map((cat) => (
                    <option key={cat.id || cat.name} value={cat.name}>
                      {cat.name} {cat.engineType ? `(${cat.engineType} • ${cat.fuelTankCapacityLiters}L)` : ''}
                    </option>
                  ))
                )}
              </select>
              {currentSelectedCategory && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  <span>Configured in Admin: <strong>{currentSelectedCategory.engineType || 'Standard'}</strong>, <strong>{currentSelectedCategory.fuelTankCapacityLiters}L</strong> tank</span>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Maintenance Plant (from Admin) <span className="text-rose-500">*</span>
                </label>
                <span className="text-[11px] text-sky-600 font-medium">Admin Only</span>
              </div>
              <select 
                value={maintPlant}
                onChange={(e) => setMaintPlant(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                {plants.length === 0 ? (
                  <option value="">No plants defined in Admin</option>
                ) : (
                  plants.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Row 3: Engine Type (Auto-filled from Category) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Engine Type
                </label>
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 flex items-center gap-1">
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span>Pre-filled from Category</span>
                </span>
              </div>
              <input
                type="text"
                value={engineType}
                onChange={(e) => setEngineType(e.target.value)}
                placeholder="e.g. Diesel, Electric Drive"
                className={`w-full px-3 py-2 rounded-lg border text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none transition-all ${
                  justAutoFilled
                    ? 'bg-emerald-50/60 dark:bg-emerald-950/30 border-emerald-400 ring-2 ring-emerald-400/30'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 focus:border-sky-500 focus:ring-1 focus:ring-sky-500'
                }`}
              />
            </div>
          </div>

          {/* Row 5: CCL Number, License Plate, Manufacturer, Model */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                CCL Number <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={cclNumber}
                onChange={(e) => setCclNumber(e.target.value)}
                placeholder="e.g. CCL-LKO-009" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                License Plate
              </label>
              <input 
                type="text" 
                value={licensePlate}
                onChange={(e) => setLicensePlate(e.target.value)}
                placeholder="e.g. UP32CE9136" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Manufacturer
              </label>
              <input 
                type="text" 
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="e.g. Komatsu, Volvo" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Model Number
              </label>
              <input 
                type="text" 
                value={modelNumber}
                onChange={(e) => setModelNumber(e.target.value)}
                placeholder="e.g. EC210" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {/* Row 6: Part No, Serial No, Engine Power, Fuel Tank (L) */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Manufacturer Part No
              </label>
              <input 
                type="text" 
                value={partNo}
                onChange={(e) => setPartNo(e.target.value)}
                placeholder="e.g. PN-9948" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Serial No
              </label>
              <input 
                type="text" 
                value={serialNo}
                onChange={(e) => setSerialNo(e.target.value)}
                placeholder="e.g. SER-4920" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Engine Power
              </label>
              <input 
                type="text" 
                value={enginePower}
                onChange={(e) => setEnginePower(e.target.value)}
                placeholder="e.g. 150 kW" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Fuel Tank Capacity: Pre-filled from selected Category */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Fuel Tank (L)
                </label>
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 flex items-center gap-1">
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span>Pre-filled</span>
                </span>
              </div>
              <input 
                type="number" 
                value={fuelCapacity}
                onChange={(e) => setFuelCapacity(e.target.value)}
                placeholder="e.g. 400" 
                className={`w-full px-3 py-2 rounded-lg border text-slate-800 dark:text-slate-100 text-xs focus:outline-none transition-all ${
                  justAutoFilled 
                    ? 'bg-emerald-50/60 dark:bg-emerald-950/30 border-emerald-400 ring-2 ring-emerald-400/30' 
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 focus:border-sky-500 focus:ring-1 focus:ring-sky-500'
                }`}
              />
            </div>
          </div>

          {/* Action Buttons in ThingsAlive Theme */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button 
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button 
              type="submit"
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer"
            >
              Confirm Setup
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
