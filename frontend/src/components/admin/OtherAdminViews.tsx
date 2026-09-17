import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  AlertCircle,
  Edit2,
  Trash2,
  MapPin,
} from 'lucide-react';
import { IndustryTypeItem } from '../../types';
import { ApiError, Plant, PlantInput } from '../../lib/api';
import { AddIndustryTypeModal } from './AddIndustryTypeModal';
import { AddPlantModal } from './AddPlantModal';

interface IndustryTypeViewProps {
  items: IndustryTypeItem[];
  onAddIndustryType?: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType?: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType?: (id: string) => void;
}

export const IndustryTypeView: React.FC<IndustryTypeViewProps> = ({
  items,
  onAddIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<IndustryTypeItem | null>(null);

  const filteredItems = useMemo(() => {
    return items.filter((i) =>
      i.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      i.code.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [items, searchTerm]);

  return (
    <div id="industry-type-management-view" className="space-y-6">

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Industry Type Names or Codes..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        {onAddIndustryType && (
          <button
            id="add-industry-type-btn"
            onClick={() => {
              setEditingItem(null);
              setIsModalOpen(true);
            }}
            className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Industry Type</span>
          </button>
        )}
      </div>

      {/* Industry Type Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredItems.map((item) => (
          <div
            key={item.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{item.code}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      setEditingItem(item);
                      setIsModalOpen(true);
                    }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Edit Industry Type"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => onDeleteIndustryType?.(item.id)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                    title="Delete Industry Type"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {item.name}
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Created: {item.createdAt}
              </p>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end text-xs text-slate-500 dark:text-slate-400">
              <span className={`font-semibold text-xs ${item.status === 'Active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {item.status === 'Active' ? '• Active' : '• Disabled'}
              </span>
            </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No industry types found.</span>
          </div>
        )}
      </div>

      <AddIndustryTypeModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingItem(null);
        }}
        onSave={(saved) => {
          if (editingItem) {
            onUpdateIndustryType?.(saved);
          } else {
            onAddIndustryType?.(saved);
          }
        }}
        existingIndustryType={editingItem}
      />
    </div>
  );
};

interface PlantViewProps {
  plants: Plant[];
  error?: string;
  onCreatePlant: (input: PlantInput) => Promise<Plant>;
  onUpdatePlant: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  onToggleStatus: (id: string, currentStatus: Plant['status']) => void;
}

export const PlantView: React.FC<PlantViewProps> = ({
  plants, error, onCreatePlant, onUpdatePlant, onToggleStatus,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPlant, setEditingPlant] = useState<Plant | null>(null);

  const filteredItems = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return plants.filter((p) =>
      p.name.toLowerCase().includes(term) ||
      p.code.toLowerCase().includes(term) ||
      (p.address?.toLowerCase().includes(term) ?? false)
    );
  }, [plants, searchTerm]);

  return (
    <div id="plant-management-view" className="space-y-6">

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Plant Names, Codes, or Addresses..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <button
          id="add-plant-btn"
          onClick={() => {
            setEditingPlant(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Plant</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Plant Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredItems.map((plant) => (
          <div
            key={plant.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{plant.code}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onToggleStatus(plant.id, plant.status)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                      plant.status === 'active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={plant.status === 'active' ? 'Retire this site' : 'Reopen this site'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        plant.status === 'active' ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  <button
                    onClick={() => {
                      setEditingPlant(plant);
                      setIsModalOpen(true);
                    }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Edit Plant"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {plant.name}
              </h4>
              {plant.address && (
                <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-rose-500" />
                  {plant.address}
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end text-xs text-slate-500 dark:text-slate-400">
              <span className={`font-semibold text-xs ${plant.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {plant.status === 'active' ? '• Active' : '• Retired'}
              </span>
            </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No plants found.</span>
          </div>
        )}
      </div>

      {/* No delete here — the API only ever retires a site, since anything
          that once stood there (work orders, alerts) still needs it to exist. */}
      <AddPlantModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingPlant(null);
        }}
        onCreate={onCreatePlant}
        onUpdate={onUpdatePlant}
        existingPlant={editingPlant}
      />
    </div>
  );
};
