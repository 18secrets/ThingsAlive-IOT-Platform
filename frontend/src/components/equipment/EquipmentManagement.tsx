import React, { useState, useMemo } from 'react';
import { Search, Plus, ChevronLeft, ChevronRight, AlertCircle, Radio, Edit2, Ban } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import {
  ApiError, CoverageResult, DiscoveryResult, EquipmentClass, EquipmentInput, EquipmentProfile,
  MyDevice, Plant, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction,
} from '../../lib/api';
import { AddEquipmentModal } from './AddEquipmentModal';
import { EquipmentBindingsModal } from './EquipmentBindingsModal';

const STATUS_OPTIONS = [
  { label: 'Active', value: 'active' },
  { label: 'Retired', value: 'retired' },
];

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50].map((n) => ({ label: String(n), value: n }));

interface EquipmentManagementProps {
  equipment: EquipmentProfile[];
  error?: string;
  onCreateEquipment: (input: EquipmentInput) => Promise<EquipmentProfile>;
  onUpdateEquipment: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<EquipmentProfile>;
  onMoveEquipment: (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string,
  ) => Promise<EquipmentProfile>;
  onRetireEquipment: (sourceSystem: string, externalId: string, reason: string) => Promise<EquipmentProfile>;
  equipmentClasses: EquipmentClass[];
  equipmentClassesError?: string;
  plants: Plant[];
  devices: MyDevice[];
  devicesError?: string;
  onClaimDevice: (imei: string, equipmentExternalId: string, sourceSystem: string) => Promise<MyDevice>;
  onUnclaimDevice: (imei: string, reason?: string) => Promise<MyDevice>;
  onGetCoverage: (sourceSystem: string, externalId: string) => Promise<CoverageResult>;
  onGetDiscovery: (sourceSystem: string, externalId: string) => Promise<DiscoveryResult>;
  onProposeOrActivateBinding: (
    sourceSystem: string, externalId: string, input: ProposeOrActivateBindingInput,
  ) => Promise<SignalBindingVersion>;
  onListEquipmentKpis: (sourceSystem: string, externalId: string) => Promise<KpiEnvelope[]>;
  onListMyCatalogScenarios: (equipmentClassSlug?: string) => Promise<ClientScenario[]>;
  onListActivations: (sourceSystem: string, externalId: string) => Promise<ActivationView[]>;
  onActivationTransition: (
    action: ActivationAction,
    input: { sourceSystem: string; externalId: string; clientScenarioSlug: string; reason?: string },
  ) => Promise<ActivationView>;
}

export const EquipmentManagement: React.FC<EquipmentManagementProps> = ({
  equipment,
  error,
  onCreateEquipment,
  onUpdateEquipment,
  onMoveEquipment,
  onRetireEquipment,
  equipmentClasses,
  equipmentClassesError,
  plants,
  devices,
  devicesError,
  onClaimDevice,
  onUnclaimDevice,
  onGetCoverage,
  onGetDiscovery,
  onProposeOrActivateBinding,
  onListEquipmentKpis,
  onListMyCatalogScenarios,
  onListActivations,
  onActivationTransition,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<EquipmentProfile | null>(null);
  const [bindingsEquipment, setBindingsEquipment] = useState<EquipmentProfile | null>(null);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | undefined>(undefined);

  const classBySlug = useMemo(
    () => new Map(equipmentClasses.map((ec) => [ec.slug, ec])),
    [equipmentClasses],
  );
  const plantById = useMemo(() => new Map(plants.map((p) => [p.id, p])), [plants]);

  const filteredList = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return equipment.filter((item) => {
      const className = item.equipmentClassSlug ? (classBySlug.get(item.equipmentClassSlug)?.name ?? item.equipmentClassSlug) : '';
      const matchSearch =
        (item.name ?? '').toLowerCase().includes(term) ||
        item.externalId.toLowerCase().includes(term) ||
        (item.manufacturer ?? '').toLowerCase().includes(term) ||
        (item.modelNumber ?? '').toLowerCase().includes(term) ||
        className.toLowerCase().includes(term);

      const matchStatus = selectedStatus === 'All' || item.status === selectedStatus;

      return matchSearch && matchStatus;
    });
  }, [equipment, searchTerm, selectedStatus, classBySlug]);

  const totalRows = filteredList.length;
  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedList = filteredList.slice(startIndex, startIndex + rowsPerPage);

  const handleCreate = async (input: EquipmentInput) => {
    await onCreateEquipment(input);
  };

  const handleUpdate = async (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => {
    await onUpdateEquipment(sourceSystem, externalId, input);
  };

  const handleMove = async (sourceSystem: string, externalId: string, toPlantId: string | null) => {
    const reason = window.prompt('Why is this machine moving site?');
    if (reason === null) throw new Error('cancelled');
    if (!reason.trim()) {
      window.alert('A reason is required to move equipment.');
      throw new Error('cancelled');
    }
    await onMoveEquipment(sourceSystem, externalId, toPlantId, reason.trim());
  };

  const handleRetire = async (item: EquipmentProfile) => {
    const reason = window.prompt(`Why is "${item.name ?? item.externalId}" being retired?`);
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert('A reason is required to retire a machine.');
      return;
    }
    setRetiringId(item.id);
    setRetireError(undefined);
    try {
      await onRetireEquipment(item.sourceSystem, item.externalId, reason.trim());
    } catch (err) {
      setRetireError(err instanceof ApiError ? err.message : 'Could not retire this machine.');
    } finally {
      setRetiringId(null);
    }
  };

  return (
    <div id="equipment-management-view" className="space-y-4">

      {/* Top Filter Bar */}
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
              placeholder="Search Equipment Details..."
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

        {/* Add Equipment Button */}
        <button
          id="add-equipment-btn"
          onClick={() => { setEditingEquipment(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Equipment</span>
        </button>
      </div>

      {(error || equipmentClassesError || retireError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error || equipmentClassesError || retireError}</span>
        </div>
      )}

      {/* Main Equipment Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-3.5">Code</th>
                <th className="py-3 px-4">Equipment Name</th>
                <th className="py-3 px-4">Equipment Class</th>
                <th className="py-3 px-4">Plant</th>
                <th className="py-3 px-4">Manufacturer</th>
                <th className="py-3 px-4">Model #</th>
                <th className="py-3 px-4">Serial #</th>
                <th className="py-3 px-4">Tier</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {paginatedList.length > 0 ? (
                paginatedList.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-3.5 font-mono text-slate-500 dark:text-slate-400">
                      {item.externalId}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                      {item.name ?? <span className="text-slate-400 italic">Unnamed</span>}
                    </td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-300">
                      {item.equipmentClassSlug ? (
                        <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800/60">
                          {classBySlug.get(item.equipmentClassSlug)?.name ?? item.equipmentClassSlug}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">Unclassified</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 font-sans">
                      {item.plantId ? (plantById.get(item.plantId)?.name ?? '—') : <span className="text-slate-400 italic">Unassigned</span>}
                    </td>
                    <td className="py-3 px-4">
                      {item.manufacturer ?? '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {item.modelNumber ?? '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-300">
                      {item.serialNumber ?? '—'}
                    </td>
                    <td className="py-3 px-4 capitalize text-slate-600 dark:text-slate-400">
                      {item.tier}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                        item.status === 'active'
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          : 'bg-slate-50 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => { setEditingEquipment(item); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Edit"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setBindingsEquipment(item)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Signal bindings"
                        >
                          <Radio className="w-3.5 h-3.5" />
                        </button>
                        {item.status === 'active' && (
                          <button
                            onClick={() => handleRetire(item)}
                            disabled={retiringId === item.id}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                            title="Retire"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-400 font-sans">
                    No equipment found matching criteria.
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

      {/* Add / Edit Equipment Modal */}
      <AddEquipmentModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingEquipment(null); }}
        onSave={handleCreate}
        onUpdate={handleUpdate}
        onMove={handleMove}
        equipmentClasses={equipmentClasses}
        plants={plants}
        existingEquipment={editingEquipment}
      />

      <EquipmentBindingsModal
        isOpen={!!bindingsEquipment}
        onClose={() => setBindingsEquipment(null)}
        equipment={bindingsEquipment}
        devices={devices}
        devicesError={devicesError}
        onClaimDevice={onClaimDevice}
        onUnclaimDevice={onUnclaimDevice}
        onGetCoverage={onGetCoverage}
        onGetDiscovery={onGetDiscovery}
        onProposeOrActivateBinding={onProposeOrActivateBinding}
        onListEquipmentKpis={onListEquipmentKpis}
        onListMyCatalogScenarios={onListMyCatalogScenarios}
        onListActivations={onListActivations}
        onActivationTransition={onActivationTransition}
      />
    </div>
  );
};
