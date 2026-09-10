import React from 'react';
import { IndustryTypeItem, PlantItem } from '../../types';
import { MapPin, Plus } from 'lucide-react';

interface IndustryTypeViewProps {
  items: IndustryTypeItem[];
}

export const IndustryTypeView: React.FC<IndustryTypeViewProps> = ({ items }) => {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-lg">Industry Classifications</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Manage industrial sectors, telemetry schemas, and equipment allocations</p>
          </div>
          <span className="text-xs font-semibold px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg border border-slate-200 dark:border-slate-700">
            {items.length} Active Domains
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => (
            <div key={item.id} className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-3 bg-white dark:bg-slate-800/40">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">#{item.code}</span>
                <span className="text-xs font-medium px-2 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 rounded border border-emerald-200 dark:border-emerald-800">
                  {item.status}
                </span>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{item.name}</h4>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-3 border-t border-slate-100 dark:border-slate-800 font-mono">
                <span>{item.totalSensors} Sensors</span>
                <span>{item.totalEquipment} Equipment</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

interface PlantViewProps {
  items: PlantItem[];
  onAddPlant?: (plant: PlantItem) => void;
}

export const PlantView: React.FC<PlantViewProps> = ({ items, onAddPlant }) => {
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [location, setLocation] = React.useState('');
  const [code, setCode] = React.useState('');

  const handleCreatePlant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newPlant: PlantItem = {
      id: `PLANT-${Date.now().toString().slice(-4)}`,
      name: name.trim(),
      location: location.trim() || 'Industrial Complex',
      code: (code.trim() || name.slice(0, 3).toUpperCase()) + `-${Math.floor(10 + Math.random() * 90)}`,
      equipmentCount: 0,
    };

    if (onAddPlant) {
      onAddPlant(newPlant);
    }
    setName('');
    setLocation('');
    setCode('');
    setIsModalOpen(false);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 pb-4 border-b border-slate-200 dark:border-slate-800 gap-3">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-lg">Manufacturing & Infrastructure Plants</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Regional production facilities, maintenance depots, and assembly sites</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg border border-slate-200 dark:border-slate-700">
              {items.length} Registered Plants
            </span>
            {onAddPlant && (
              <button
                onClick={() => setIsModalOpen(true)}
                className="px-3.5 py-1.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Plant</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {items.map((plant) => (
            <div key={plant.id} className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/40 hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">#{plant.code}</span>
                <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <MapPin className="w-3.5 h-3.5 text-rose-500" />
                  {plant.location}
                </span>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{plant.name}</h4>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 font-mono">
                <span>{plant.equipmentCount} Equipment Active</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Plant Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h4 className="font-semibold text-base text-slate-900 dark:text-white">
                Register New Plant / Depot
              </h4>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreatePlant} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Plant Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Hyderabad Central Works"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Location (City, State)
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Hyderabad, Telangana"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Plant Code
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. HYD-WKS"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 font-mono focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[#0B7285] text-white hover:bg-[#095C6B] text-xs font-semibold rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  Register Plant
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
