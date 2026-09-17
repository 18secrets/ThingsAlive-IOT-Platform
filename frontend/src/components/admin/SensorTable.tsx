import React, { useState, useMemo } from 'react';
import { Search, Plus, Eye, Edit2, AlertCircle, ChevronsUpDown } from 'lucide-react';
import { Sensor, SensorCategory, SensorInput } from '../../lib/api';
import { AddSensorModal } from './AddSensorModal';
import { SensorDetailModal } from './SensorDetailModal';

interface SensorTableProps {
  sensors: Sensor[];
  error?: string;
  categories: SensorCategory[];
  onCreateSensor: (input: SensorInput) => Promise<Sensor>;
  onUpdateSensor: (id: string, input: SensorInput) => Promise<Sensor>;
  onCreateCategory: (name: string) => Promise<SensorCategory>;
}

export const SensorTable: React.FC<SensorTableProps> = ({
  sensors, error, categories, onCreateSensor, onUpdateSensor, onCreateCategory,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingSensor, setEditingSensor] = useState<Sensor | null>(null);
  const [viewingSensor, setViewingSensor] = useState<Sensor | null>(null);

  const categoryName = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? byId.get(id) ?? '—' : '—');
  }, [categories]);

  const filteredSensors = useMemo(() => {
    return sensors.filter((s) => {
      const name = categoryName(s.categoryId);
      const matchesSearch =
        s.sensorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = selectedCategory === 'All' || s.categoryId === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [sensors, searchTerm, selectedCategory, categoryName]);

  return (
    <div id="sensor-management-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Sensor Names..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">Filter by Category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <button
          id="add-sensor-btn"
          onClick={() => { setEditingSensor(null); setIsAddModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Sensor</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700/80 text-slate-600 dark:text-slate-400 text-xs font-normal">
              <tr>
                <th className="py-3 px-6 font-medium">
                  <div className="flex items-center gap-1">
                    <span>Category</span>
                    <ChevronsUpDown className="w-3 h-3 text-slate-400" />
                  </div>
                </th>
                <th className="py-3 px-6 font-medium">Sensor Name</th>
                <th className="py-3 px-6 font-medium">Parameters</th>
                <th className="py-3 px-6 font-medium">Updated At</th>
                <th className="py-3 px-4 font-medium text-center">View</th>
                <th className="py-3 px-4 font-medium text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300 text-sm">
              {filteredSensors.length > 0 ? (
                filteredSensors.map((sensor) => (
                  <tr key={sensor.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-6 font-normal">{categoryName(sensor.categoryId)}</td>
                    <td className="py-3.5 px-6 font-normal text-slate-800 dark:text-slate-200">{sensor.sensorName}</td>
                    <td className="py-3.5 px-6 text-slate-500 dark:text-slate-400 text-xs">
                      {sensor.parameterSpecs.length}
                    </td>
                    <td className="py-3.5 px-6 text-slate-500 dark:text-slate-400 text-xs">
                      {new Date(sensor.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <button
                        onClick={() => setViewingSensor(sensor)}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors inline-flex items-center justify-center cursor-pointer"
                        title="View Sensor Details"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <button
                        onClick={() => { setEditingSensor(sensor); setIsAddModalOpen(true); }}
                        className="p-1 text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300 transition-colors inline-flex items-center justify-center cursor-pointer"
                        title="Edit Sensor"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400 text-sm">
                    No sensors match your search filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-500 dark:text-slate-400">
          Total Rows: <span className="font-medium text-slate-700 dark:text-slate-300">{filteredSensors.length}</span>
        </div>
      </div>

      <AddSensorModal
        isOpen={isAddModalOpen}
        onClose={() => { setIsAddModalOpen(false); setEditingSensor(null); }}
        onCreate={onCreateSensor}
        onUpdate={onUpdateSensor}
        categories={categories}
        onCreateCategory={onCreateCategory}
        existingSensor={editingSensor}
      />

      <SensorDetailModal
        sensor={viewingSensor}
        categoryName={viewingSensor ? categoryName(viewingSensor.categoryId) : undefined}
        onClose={() => setViewingSensor(null)}
      />
    </div>
  );
};
