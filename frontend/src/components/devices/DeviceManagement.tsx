import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Sparkles
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { DeviceItem } from '../../types';

const STATUS_OPTIONS = [
  { label: 'Online', value: 'Online' },
  { label: 'Offline', value: 'Offline' },
];

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50].map((n) => ({ label: String(n), value: n }));

interface DeviceManagementProps {
  devices: DeviceItem[];
  onNavigateToSetup: () => void;
  onDeleteDevice: (id: number) => void;
}

export const DeviceManagement: React.FC<DeviceManagementProps> = ({
  devices,
  onNavigateToSetup,
  onDeleteDevice,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Filtered devices
  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      const matchSearch =
        d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        d.imei.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (d.toolProfile?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);

      const matchStatus = selectedStatus === 'All' || d.status === selectedStatus;

      return matchSearch && matchStatus;
    });
  }, [devices, searchTerm, selectedStatus]);

  const totalRows = filteredDevices.length;
  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedDevices = filteredDevices.slice(startIndex, startIndex + rowsPerPage);

  return (
    <div id="device-management-view" className="space-y-4">

      {/* Filter Row & Action */}
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">

        <div className="flex flex-1 items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => {
                setSearchTerm(value);
                setCurrentPage(1);
              }}
              placeholder="Search Devices..."
              size="sm"
              className="w-full pl-9! pr-4"
            />
          </div>

          {/* Status Filter */}
          <SelectPicker
            data={STATUS_OPTIONS}
            value={selectedStatus === 'All' ? null : selectedStatus}
            onChange={(value) => {
              setSelectedStatus(value ?? 'All');
              setCurrentPage(1);
            }}
            placeholder="Select Status (All)"
            searchable={false}
            cleanable={selectedStatus !== 'All'}
            size="sm"
          />
        </div>

        {/* Add Device Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            id="add-device-btn"
            onClick={onNavigateToSetup}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Device</span>
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4 text-center">ID</th>
                <th className="py-3 px-4">Device Name</th>
                <th className="py-3 px-4">IMEI Number</th>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {paginatedDevices.length > 0 ? (
                paginatedDevices.map((d) => (
                  <tr
                    key={d.id}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-4 text-center font-mono font-medium text-slate-400">
                      {d.id}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                      {d.name}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {d.imei}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {d.clientName || <span className="text-slate-400 italic">Unassigned</span>}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                          d.status === 'Online'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                            : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${d.status === 'Online' ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                        {d.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={onNavigateToSetup}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Edit Device Configuration"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteDevice(d.id)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                          title="Decommission Device"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                    No devices found matching criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>
            Total Rows: <span className="font-semibold text-slate-800 dark:text-slate-200">{totalRows}</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <SelectPicker
                data={ROWS_PER_PAGE_OPTIONS}
                value={rowsPerPage}
                onChange={(value) => {
                  setRowsPerPage(Number(value ?? 10));
                  setCurrentPage(1);
                }}
                searchable={false}
                cleanable={false}
                size="sm"
              />
            </div>

            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i + 1)}
                  className={`w-7 h-7 rounded text-xs font-semibold flex items-center justify-center transition-colors ${
                    currentPage === i + 1
                      ? 'bg-[#0B7285] text-white border border-[#0B7285]'
                      : 'border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {i + 1}
                </button>
              ))}

              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};
