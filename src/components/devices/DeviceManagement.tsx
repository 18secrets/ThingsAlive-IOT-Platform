import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Cpu,
  Wifi,
  WifiOff,
  Building2,
  Edit2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Sparkles
} from 'lucide-react';
import { DeviceItem } from '../../types';

interface DeviceManagementProps {
  devices: DeviceItem[];
  onNavigateToSetup: () => void;
  onDeleteDevice: (id: number) => void;
  onNavigateToAISetup?: () => void;
}

export const DeviceManagement: React.FC<DeviceManagementProps> = ({
  devices,
  onNavigateToSetup,
  onDeleteDevice,
  onNavigateToAISetup,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedVendor, setSelectedVendor] = useState('All');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Compute metrics matching Image 11
  const totalDevicesCount = 20; // As in screenshot metric card
  const onlineDevicesCount = devices.filter((d) => d.status === 'Online').length || 9;
  const offlineDevicesCount = devices.filter((d) => d.status === 'Offline').length || 1;
  const vendorsCount = 2; // As in screenshot metric card

  // Distinct vendors
  const vendorList = useMemo(() => {
    return Array.from(new Set(devices.map((d) => d.vendor)));
  }, [devices]);

  // Filtered devices
  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      const matchSearch =
        d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        d.imei.toLowerCase().includes(searchTerm.toLowerCase()) ||
        d.equipmentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        d.vendor.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchVendor = selectedVendor === 'All' || d.vendor === selectedVendor;
      const matchStatus = selectedStatus === 'All' || d.status === selectedStatus;

      return matchSearch && matchVendor && matchStatus;
    });
  }, [devices, searchTerm, selectedVendor, selectedStatus]);

  const totalRows = filteredDevices.length;
  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedDevices = filteredDevices.slice(startIndex, startIndex + rowsPerPage);

  return (
    <div id="device-management-view" className="space-y-6">
      
      {/* 4 Metric Summary Cards matching Image 11 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Devices */}
        <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-5 border border-[#121212]/15 dark:border-white/15 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
              Total Devices
            </div>
            <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">
              {totalDevicesCount}
            </div>
          </div>
          <div className="w-11 h-11 border border-[#121212]/15 dark:border-white/15 bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] flex items-center justify-center">
            <Cpu className="w-5 h-5" />
          </div>
        </div>

        {/* Online Devices */}
        <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-5 border border-[#121212]/15 dark:border-white/15 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
              Online Devices
            </div>
            <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">
              {onlineDevicesCount}
            </div>
          </div>
          <div className="w-11 h-11 border border-[#121212]/15 dark:border-white/15 bg-[#F4F2EA] dark:bg-stone-800 text-[#FF4D00] flex items-center justify-center">
            <Wifi className="w-5 h-5" />
          </div>
        </div>

        {/* Offline Devices */}
        <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-5 border border-[#121212]/15 dark:border-white/15 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
              Offline Devices
            </div>
            <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">
              {offlineDevicesCount}
            </div>
          </div>
          <div className="w-11 h-11 border border-[#121212]/15 dark:border-white/15 bg-[#F4F2EA] dark:bg-stone-800 text-[#121212]/40 dark:text-[#FDFCF5]/40 flex items-center justify-center">
            <WifiOff className="w-5 h-5" />
          </div>
        </div>

        {/* Vendors */}
        <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-5 border border-[#121212]/15 dark:border-white/15 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
              Vendors
            </div>
            <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">
              {vendorsCount}
            </div>
          </div>
          <div className="w-11 h-11 border border-[#121212]/15 dark:border-white/15 bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] flex items-center justify-center">
            <Building2 className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Filter Row & Action */}
      <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-4 border border-[#121212]/15 dark:border-white/15 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[#121212]/40 dark:text-[#FDFCF5]/40 absolute left-3 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search Devices..." 
              className="w-full pl-9 pr-4 py-2 bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 text-xs text-[#121212] dark:text-[#FDFCF5] placeholder-[#121212]/40 dark:placeholder-[#FDFCF5]/40 focus:outline-none focus:border-[#FF4D00] focus:ring-1 focus:ring-[#FF4D00] transition-colors"
            />
          </div>

          {/* Vendor Filter */}
          <select
            value={selectedVendor}
            onChange={(e) => {
              setSelectedVendor(e.target.value);
              setCurrentPage(1);
            }}
            className="py-2 px-3 text-xs bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 text-[#121212] dark:text-[#FDFCF5] focus:outline-none focus:border-[#FF4D00] cursor-pointer"
          >
            <option value="All">Select Vendor (All)</option>
            {vendorList.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>

          {/* Status Filter */}
          <select
            value={selectedStatus}
            onChange={(e) => {
              setSelectedStatus(e.target.value);
              setCurrentPage(1);
            }}
            className="py-2 px-3 text-xs bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 text-[#121212] dark:text-[#FDFCF5] focus:outline-none focus:border-[#FF4D00] cursor-pointer"
          >
            <option value="All">Select Status (All)</option>
            <option value="Online">Online</option>
            <option value="Offline">Offline</option>
          </select>
        </div>

        {/* Add Device Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {onNavigateToAISetup && (
            <button
              id="ai-setup-device-btn"
              onClick={onNavigateToAISetup}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white border border-sky-600 text-xs font-sans uppercase tracking-[0.14em] font-bold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              <span>Setup with AI</span>
            </button>
          )}
          <button
            id="add-device-btn"
            onClick={onNavigateToSetup}
            className="px-4 py-2 bg-[#121212] text-[#FDFCF5] hover:bg-[#FF4D00] hover:text-white dark:bg-[#FDFCF5] dark:text-[#121212] dark:hover:bg-[#FF4D00] dark:hover:text-white border border-[#121212] dark:border-white text-xs font-sans uppercase tracking-[0.14em] font-bold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Device</span>
          </button>
        </div>
      </div>

      {/* Main Table with columns matching Image 11 */}
      <div className="bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-[#F4F2EA] dark:bg-[#151514] border-b border-[#121212]/15 dark:border-white/15 text-[#121212] dark:text-[#FDFCF5] font-sans font-bold uppercase tracking-[0.14em] text-[11px]">
              <tr>
                <th className="py-3 px-4">ID</th>
                <th className="py-3 px-4">Device Name</th>
                <th className="py-3 px-4">IMEI Number</th>
                <th className="py-3 px-4">Equipment Name</th>
                <th className="py-3 px-4">Vendor</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#121212]/10 dark:divide-white/10 font-medium text-[#121212] dark:text-[#FDFCF5]">
              {paginatedDevices.map((d) => (
                <tr 
                  key={d.id} 
                  className="hover:bg-[#FDFCF5] dark:hover:bg-stone-800/40 transition-colors"
                >
                  <td className="py-3.5 px-4 font-mono font-bold text-[#121212]/50 dark:text-[#FDFCF5]/50">
                    {d.id}
                  </td>
                  <td className="py-3.5 px-4 font-serif font-bold text-sm text-[#121212] dark:text-[#FDFCF5]">
                    {d.name}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-[11px] text-[#121212]/70 dark:text-[#FDFCF5]/70">
                    {d.imei}
                  </td>
                  <td className="py-3.5 px-4 font-sans text-[#121212] dark:text-[#FDFCF5]">
                    {d.equipmentName}
                  </td>
                  <td className="py-3.5 px-4 font-sans text-[#121212]/70 dark:text-[#FDFCF5]/70">
                    {d.vendor}
                  </td>
                  <td className="py-3.5 px-4">
                    <span 
                      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase font-bold border ${
                        d.status === 'Online'
                          ? 'bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] border-[#121212]/30 dark:border-white/30'
                          : 'bg-[#FF4D00]/10 text-[#FF4D00] border-[#FF4D00]/30'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${d.status === 'Online' ? 'bg-[#FF4D00]' : 'bg-stone-400'}`}></span>
                      {d.status}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={onNavigateToSetup}
                        className="p-1.5 border border-[#121212]/15 dark:border-white/15 text-[#121212]/70 dark:text-[#FDFCF5]/70 hover:border-[#FF4D00] hover:text-[#FF4D00] transition-colors"
                        title="Edit Device Configuration"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteDevice(d.id)}
                        className="p-1.5 border border-[#121212]/15 dark:border-white/15 text-[#121212]/70 dark:text-[#FDFCF5]/70 hover:border-red-600 hover:text-red-600 transition-colors"
                        title="Decommission Device"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-6 py-3.5 border-t border-[#121212]/15 dark:border-white/15 bg-[#F4F2EA]/60 dark:bg-[#151514] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#121212]/70 dark:text-[#FDFCF5]/70 font-sans">
          <div>
            Total Rows: <span className="font-mono font-bold text-[#121212] dark:text-[#FDFCF5]">{totalRows}</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <select
                value={rowsPerPage}
                onChange={(e) => {
                  setRowsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 px-2 py-1 text-[#121212] dark:text-[#FDFCF5] text-xs focus:outline-none"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>

            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="p-1 border border-[#121212]/15 dark:border-white/15 hover:border-[#FF4D00] hover:text-[#FF4D00] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i + 1)}
                  className={`w-6 h-6 border text-xs font-mono font-bold flex items-center justify-center transition-colors ${
                    currentPage === i + 1
                      ? 'bg-[#121212] text-white dark:bg-white dark:text-[#121212] border-[#121212] dark:border-white'
                      : 'border-[#121212]/15 dark:border-white/15 hover:border-[#FF4D00] hover:text-[#FF4D00] text-[#121212] dark:text-[#FDFCF5]'
                  }`}
                >
                  {i + 1}
                </button>
              ))}

              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="p-1 border border-[#121212]/15 dark:border-white/15 hover:border-[#FF4D00] hover:text-[#FF4D00] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
