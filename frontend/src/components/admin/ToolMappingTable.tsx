import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, AlertCircle } from 'lucide-react';
import { Sensor, ToolMapping, ToolMappingInput } from '../../lib/api';
import { MapSensorsModal } from './MapSensorsModal';

interface ToolMappingTableProps {
  mappings: ToolMapping[];
  error?: string;
  onCreateMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
  availableSensors: Sensor[];
}

export const ToolMappingTable: React.FC<ToolMappingTableProps> = ({
  mappings, error, onCreateMapping, onUpdateMapping, availableSensors,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ToolMapping | null>(null);

  const filteredMappings = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return mappings.filter((item) =>
      item.toolName.toLowerCase().includes(term) ||
      (item.industryType?.toLowerCase().includes(term) ?? false));
  }, [mappings, searchTerm]);

  return (
    <div id="tool-mapping-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Tool or Mapping Profile..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>
        </div>

        <button
          id="create-mapping-btn"
          onClick={() => { setEditingMapping(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Create Tool Mapping</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">Tool Profile</th>
                <th className="py-3 px-4">Industry Type</th>
                <th className="py-3 px-4">Mapped Sensors & Channels</th>
                <th className="py-3 px-4">Parameters</th>
                <th className="py-3 px-4">Updated At</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredMappings.map((item) => {
                const activeParametersCount = item.mappedSensors.reduce((acc, s) => acc + s.parameters.length, 0);
                return (
                  <tr key={item.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-sm text-slate-900 dark:text-white">{item.toolName}</div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {item.industryType || '—'}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex flex-wrap gap-1.5 max-w-sm">
                        {item.mappedSensors.map((sensor) => (
                          <span
                            key={sensor.sensorId}
                            className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                            title={`Parameters: ${sensor.parameters.join(', ')}`}
                          >
                            {sensor.sensorName}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-semibold text-[11px] border border-slate-200 dark:border-slate-700">
                        {activeParametersCount} Ch
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => { setEditingMapping(item); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Edit Mapping Configuration"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{filteredMappings.length}</span> Tool Mapping Profiles</div>
          <div className="text-[11px] text-slate-400 font-sans">
            Telemetry channels auto-bind upon device registration
          </div>
        </div>
      </div>

      <MapSensorsModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingMapping(null); }}
        onCreate={onCreateMapping}
        onUpdate={onUpdateMapping}
        existingMapping={editingMapping}
        availableSensors={availableSensors}
      />
    </div>
  );
};
