import React, { useState, useMemo } from 'react';
import { Search, Plus, Eye, Edit3, Settings2, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { ToolMappingItem, SensorItem } from '../../types';
import { MapSensorsModal } from './MapSensorsModal';

interface ToolMappingTableProps {
  mappings: ToolMappingItem[];
  onAddMapping: (mapping: ToolMappingItem) => void;
  availableSensors?: SensorItem[];
}

export const ToolMappingTable: React.FC<ToolMappingTableProps> = ({
  mappings,
  onAddMapping,
  availableSensors,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIndustry, setSelectedIndustry] = useState('All');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ToolMappingItem | null>(null);

  const filteredMappings = useMemo(() => {
    return mappings.filter((item) => {
      const matchSearch = 
        item.toolName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.identifier.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.industryType.toLowerCase().includes(searchTerm.toLowerCase());
      const matchIndustry = selectedIndustry === 'All' || item.industryType === selectedIndustry;
      return matchSearch && matchIndustry;
    });
  }, [mappings, searchTerm, selectedIndustry]);

  const getBadgeStyle = (color: string) => {
    switch (color) {
      case 'teal':
        return 'bg-[#F4F2EA] text-[#121212] border-[#121212]/30 dark:bg-stone-800 dark:text-[#FDFCF5] dark:border-white/20';
      case 'purple':
        return 'bg-[#F4F2EA] text-[#121212] border-[#121212]/30 dark:bg-stone-800 dark:text-[#FDFCF5] dark:border-white/20';
      case 'amber':
        return 'bg-[#F4F2EA] text-[#FF4D00] border-[#FF4D00]/40 dark:bg-stone-800 dark:text-[#FF4D00] dark:border-[#FF4D00]/40';
      case 'emerald':
        return 'bg-[#F4F2EA] text-[#121212] border-[#121212]/30 dark:bg-stone-800 dark:text-[#FDFCF5] dark:border-white/20';
      case 'rose':
        return 'bg-[#FF4D00]/10 text-[#FF4D00] border-[#FF4D00]/30';
      case 'blue':
      default:
        return 'bg-[#F4F2EA] text-[#121212] border-[#121212]/20 dark:bg-stone-800 dark:text-[#FDFCF5] dark:border-white/20';
    }
  };

  return (
    <div id="tool-mapping-view" className="space-y-4">
      {/* Top Filter Bar */}
      <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-4 border border-[#121212]/15 dark:border-white/15 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[#121212]/40 dark:text-[#FDFCF5]/40 absolute left-3 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Tool or Mapping Profile..." 
              className="w-full pl-9 pr-4 py-2 bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 text-xs text-[#121212] dark:text-[#FDFCF5] placeholder-[#121212]/40 dark:placeholder-[#FDFCF5]/40 focus:outline-none focus:border-[#FF4D00] focus:ring-1 focus:ring-[#FF4D00] transition-colors"
            />
          </div>

          {/* Filter Industry */}
          <select
            value={selectedIndustry}
            onChange={(e) => setSelectedIndustry(e.target.value)}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">All Industry Types</option>
            <option value="Cement & Building Materials">Cement & Building Materials</option>
            <option value="Transport">Transport</option>
            <option value="Automotive">Automotive</option>
            <option value="Power & Energy">Power & Energy</option>
          </select>
        </div>

        {/* Create Mapping Button */}
        <button 
          id="create-mapping-btn"
          onClick={() => {
            setEditingMapping(null);
            setIsModalOpen(true);
          }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Create Tool Mapping</span>
        </button>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">Tool Profile / ID</th>
                <th className="py-3 px-4">Industry Type</th>
                <th className="py-3 px-4">Mapped Sensors & Channels</th>
                <th className="py-3 px-4">Parameters</th>
                <th className="py-3 px-4">Updated At</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredMappings.map((item) => (
                <tr 
                  key={item.id} 
                  className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <td className="py-3.5 px-4">
                    <div className="font-semibold text-sm text-slate-900 dark:text-white">
                      {item.toolName}
                    </div>
                    <span className="font-mono text-[11px] text-slate-400">
                      {item.identifier}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                    {item.industryType}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex flex-wrap gap-1.5 max-w-sm">
                      {item.mappedSensors.map((sensor) => (
                        <span 
                          key={sensor.id} 
                          className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                          title={`Parameters: ${sensor.parameters.join(', ')}`}
                        >
                          {sensor.name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-semibold text-[11px] border border-slate-200 dark:border-slate-700">
                      {item.activeParametersCount} Ch
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                    {item.updatedAt}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => {
                          setEditingMapping(item);
                          setIsModalOpen(true);
                        }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                        title="Edit Mapping Configuration"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{filteredMappings.length}</span> Tool Mapping Profiles</div>
          <div className="text-[11px] text-slate-400 font-sans">
            Telemetry channels auto-bind upon device registration
          </div>
        </div>
      </div>

      {/* Map Sensors Modal */}
      <MapSensorsModal 
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingMapping(null);
        }}
        onSave={onAddMapping}
        existingMapping={editingMapping}
        availableSensors={availableSensors}
      />
    </div>
  );
};
