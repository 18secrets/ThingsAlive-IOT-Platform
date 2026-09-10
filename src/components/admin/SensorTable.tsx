import React, { useState, useMemo } from 'react';
import { Search, Plus, Eye, Edit2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown } from 'lucide-react';
import { SensorItem } from '../../types';
import { AddSensorModal } from './AddSensorModal';
import { SensorDetailModal } from './SensorDetailModal';

interface SensorTableProps {
  sensors: SensorItem[];
  onAddSensor: (sensor: SensorItem) => void;
  onUpdateSensor?: (sensor: SensorItem) => void;
}

export const SensorTable: React.FC<SensorTableProps> = ({
  sensors,
  onAddSensor,
  onUpdateSensor,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIndustry, setSelectedIndustry] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [viewingSensor, setViewingSensor] = useState<SensorItem | null>(null);

  // Industry options for filter
  const industryOptions = useMemo(() => {
    const list = Array.from(new Set(sensors.map((s) => s.industryType)));
    return ['All', ...list];
  }, [sensors]);

  // Filtered sensors
  const filteredSensors = useMemo(() => {
    return sensors.filter((s) => {
      const matchesSearch = 
        s.sensorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.industryType.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesIndustry = selectedIndustry === 'All' || s.industryType === selectedIndustry;
      return matchesSearch && matchesIndustry;
    });
  }, [sensors, searchTerm, selectedIndustry]);

  // Pagination calculation
  const totalRows = filteredSensors.length;
  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedSensors = filteredSensors.slice(startIndex, startIndex + rowsPerPage);

  return (
    <div id="sensor-management-view" className="space-y-4">
      {/* Top Filter & Action Bar matching screenshot */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        
        <div className="flex flex-1 items-center gap-3">
          {/* Search Input with search icon on right */}
          <div className="relative flex-1 max-w-sm">
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search Sensor Names" 
              className="w-full pl-3.5 pr-9 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
          </div>

          {/* Industry Type Filter */}
          <div className="relative min-w-[200px]">
            <select
              value={selectedIndustry}
              onChange={(e) => {
                setSelectedIndustry(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full py-2 px-3 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 cursor-pointer"
            >
              <option value="All">Filter by Industry Type</option>
              {industryOptions.filter(i => i !== 'All').map((ind) => (
                <option key={ind} value={ind}>{ind}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Add Sensor Button matching teal-blue in screenshot */}
        <button 
          id="add-sensor-btn"
          onClick={() => setIsAddModalOpen(true)}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center justify-center gap-1.5 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Sensor</span>
        </button>
      </div>

      {/* Main Data Table matching screenshot */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700/80 text-slate-600 dark:text-slate-400 text-xs font-normal">
              <tr>
                <th className="py-3 px-6 font-medium">
                  <div className="flex items-center gap-1 cursor-pointer">
                    <span>Industry Type</span>
                    <ChevronsUpDown className="w-3 h-3 text-slate-400" />
                  </div>
                </th>
                <th className="py-3 px-6 font-medium">
                  <div className="flex items-center gap-1 cursor-pointer">
                    <span>Sensor Name</span>
                    <ChevronsUpDown className="w-3 h-3 text-slate-400" />
                  </div>
                </th>
                <th className="py-3 px-6 font-medium">
                  <div className="flex items-center gap-1 cursor-pointer">
                    <span>Created At</span>
                    <ChevronsUpDown className="w-3 h-3 text-slate-400" />
                  </div>
                </th>
                <th className="py-3 px-6 font-medium">
                  <div className="flex items-center gap-1 cursor-pointer">
                    <span>Updated At</span>
                    <ChevronsUpDown className="w-3 h-3 text-slate-400" />
                  </div>
                </th>
                <th className="py-3 px-4 font-medium text-center">View</th>
                <th className="py-3 px-4 font-medium text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300 text-sm">
              {paginatedSensors.length > 0 ? (
                paginatedSensors.map((sensor) => (
                  <tr 
                    key={sensor.id} 
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3.5 px-6 font-normal">
                      {sensor.industryType}
                    </td>
                    <td className="py-3.5 px-6 font-normal text-slate-800 dark:text-slate-200">
                      {sensor.sensorName}
                    </td>
                    <td className="py-3.5 px-6 text-slate-500 dark:text-slate-400 text-xs">
                      {sensor.createdAt}
                    </td>
                    <td className="py-3.5 px-6 text-slate-500 dark:text-slate-400 text-xs">
                      {sensor.updatedAt}
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
                        onClick={() => setViewingSensor(sensor)}
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

        {/* Table Pagination Footer matching screenshot */}
        <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <div>
            Total Rows: <span className="font-medium text-slate-700 dark:text-slate-300">{totalRows}</span>
          </div>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <select
                value={rowsPerPage}
                onChange={(e) => {
                  setRowsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-transparent border border-slate-200 dark:border-slate-700 rounded px-2 py-0.5 text-slate-700 dark:text-slate-300 text-xs focus:outline-none cursor-pointer"
              >
                <option value={10}>10 / page</option>
                <option value={20}>20 / page</option>
                <option value={50}>50 / page</option>
              </select>
            </div>

            {/* Pagination numbers matching screenshot */}
            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage(1)}
                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="First Page"
              >
                <ChevronsLeft className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="Previous Page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i + 1)}
                  className={`w-6 h-6 rounded text-xs flex items-center justify-center transition-colors cursor-pointer ${
                    currentPage === i + 1
                      ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                      : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {i + 1}
                </button>
              ))}

              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="Next Page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage(totalPages)}
                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="Last Page"
              >
                <ChevronsRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add Sensor Modal */}
      <AddSensorModal 
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSave={onAddSensor}
        industryTypes={industryOptions.filter(i => i !== 'All')}
      />

      {/* Sensor Detail Modal */}
      <SensorDetailModal 
        sensor={viewingSensor}
        onClose={() => setViewingSensor(null)}
      />
    </div>
  );
};

