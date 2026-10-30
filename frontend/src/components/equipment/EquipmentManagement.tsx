import React, { useState, useMemo } from 'react';
import { Search, Plus, AlertCircle, Radio, Edit2, Ban, Download } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, CoverageResult, DiscoveryResult, EquipmentClass, EquipmentInput, EquipmentProfile, EquipmentPlacementEvent,
  ImportResult, MyDevice, Plant, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction, ActivationHistoryEvent, EquipmentRecommendation,
} from '../../lib/api';
import { AddEquipmentModal } from './AddEquipmentModal';
import { EquipmentBindingsModal } from './EquipmentBindingsModal';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable, ListColumn } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

const STATUS_VALUES = ['active', 'retired'];


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
  onGetEquipmentPlacementHistory: (sourceSystem: string, externalId: string) => Promise<EquipmentPlacementEvent[]>;
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
  onGetActivationHistory: (sourceSystem: string, externalId: string) => Promise<ActivationHistoryEvent[]>;
  onGetEquipmentRecommendations: (
    sourceSystem: string, externalId: string,
  ) => Promise<{ equipmentClassSlug: string | null; recommendations: EquipmentRecommendation[] }>;
  onImportEquipmentFromMirror: (sourceSystem: string) => Promise<ImportResult>;
}

export const EquipmentManagement: React.FC<EquipmentManagementProps> = ({
  equipment,
  error,
  onCreateEquipment,
  onUpdateEquipment,
  onMoveEquipment,
  onRetireEquipment,
  onGetEquipmentPlacementHistory,
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
  onGetActivationHistory,
  onGetEquipmentRecommendations,
  onImportEquipmentFromMirror,
}) => {
  const { t } = useTranslation('equipment');
  const { t: ts } = useTranslation('shared');
  const statusOptions = STATUS_VALUES.map((value) => ({ label: t(`status.${value}`), value }));
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [viewMode, setViewMode] = useViewMode('client-equipment');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<EquipmentProfile | null>(null);
  const [bindingsEquipment, setBindingsEquipment] = useState<EquipmentProfile | null>(null);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);

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

  const { pageItems: paginatedList, ...pager } = usePagination(filteredList);

  // One definition for both views (cards or list on every list page).
  const viewColumns: ListColumn[] = [
    // Ten columns: past these widths the list scrolls sideways, as the table before it did.
    { label: t('equipmentList.col.code'), minWidth: 110 },
    { label: t('equipmentList.col.name'), minWidth: 170 },
    { label: t('equipmentList.col.class'), minWidth: 190 },
    { label: t('equipmentList.col.plant'), minWidth: 170 },
    { label: t('equipmentList.col.manufacturer'), minWidth: 130 },
    { label: t('equipmentList.col.model'), minWidth: 110 },
    { label: t('equipmentList.col.serial'), minWidth: 120 },
    { label: t('equipmentList.col.tier') },
    { label: t('equipmentList.col.status') },
    { label: ts('listCol.actions'), width: 130 },
  ];
  const viewCells = (item: EquipmentProfile) => [
    <span className="font-mono text-slate-500 dark:text-slate-400">{item.externalId}</span>,
    <span className="font-semibold text-slate-900 dark:text-white">{item.name ?? <span className="text-slate-400 italic">{t('common.unnamed')}</span>}</span>,
    <span className="text-slate-700 dark:text-slate-300">{item.equipmentClassSlug ? (
                        <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800/60">
                          {classBySlug.get(item.equipmentClassSlug)?.name ?? item.equipmentClassSlug}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">{t('common.unclassified')}</span>
                      )}</span>,
    <span className="text-slate-600 dark:text-slate-400 font-sans">{item.plantId ? (plantById.get(item.plantId)?.name ?? '—') : <span className="text-slate-400 italic">{t('common.unassigned')}</span>}</span>,
    <>{item.manufacturer ?? '—'}</>,
    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{item.modelNumber ?? '—'}</span>,
    <span className="font-mono text-xs text-slate-700 dark:text-slate-300">{item.serialNumber ?? '—'}</span>,
    <span className="capitalize text-slate-600 dark:text-slate-400">{t(`tier.${item.tier}`, { defaultValue: item.tier })}</span>,
    <><span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                        item.status === 'active'
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          : 'bg-slate-50 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}>
                        {t(`status.${item.status}`, { defaultValue: item.status })}
                      </span></>,
    <><div className="flex items-center gap-1.5">
                        <button
                          onClick={() => { setEditingEquipment(item); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title={t('common.edit')}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setBindingsEquipment(item)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title={t('bindings.title')}
                        >
                          <Radio className="w-3.5 h-3.5" />
                        </button>
                        {item.status === 'active' && (
                          <button
                            onClick={() => handleRetire(item)}
                            disabled={retiringId === item.id}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                            title={t('equipmentList.retire')}
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div></>,
  ];

  const handleCreate = async (input: EquipmentInput) => {
    await onCreateEquipment(input);
  };

  const handleUpdate = async (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => {
    await onUpdateEquipment(sourceSystem, externalId, input);
  };

  const handleMove = async (sourceSystem: string, externalId: string, toPlantId: string | null) => {
    const reason = window.prompt(t('equipmentList.moveReasonPrompt'));
    if (reason === null) throw new Error('cancelled');
    if (!reason.trim()) {
      window.alert(t('equipmentList.moveReasonRequired'));
      throw new Error('cancelled');
    }
    await onMoveEquipment(sourceSystem, externalId, toPlantId, reason.trim());
  };

  const handleRetire = async (item: EquipmentProfile) => {
    const reason = window.prompt(t('equipmentList.retireReasonPrompt', { name: item.name ?? item.externalId }));
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert(t('equipmentList.retireReasonRequired'));
      return;
    }
    setRetiringId(item.id);
    setRetireError(undefined);
    try {
      await onRetireEquipment(item.sourceSystem, item.externalId, reason.trim());
    } catch (err) {
      setRetireError(err instanceof ApiError ? err.message : t('equipmentList.retireFailed'));
    } finally {
      setRetiringId(null);
    }
  };

  const handleImport = async () => {
    const sourceSystem = window.prompt(
      t('equipmentList.importPrompt'),
      'iot-platform-1',
    );
    if (!sourceSystem?.trim()) return;
    setImporting(true);
    setImportError(undefined);
    try {
      const result = await onImportEquipmentFromMirror(sourceSystem.trim());
      window.alert(
        `${t('equipmentList.imported', { count: result.imported })}\n`
        + `${t('equipmentList.alreadyKnown', { count: result.alreadyKnown })}\n`
        + t('equipmentList.importedUnplaced', { count: result.unplaced }),
      );
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : t('equipmentList.importFailed'));
    } finally {
      setImporting(false);
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
                pager.setPage(1);
              }}
              placeholder={t('equipmentList.searchPlaceholder')}
              size="sm"
              className="w-full pl-9! pr-4"
            />
          </div>

          {/* Status Filter */}
          <SelectPicker
            data={statusOptions}
            value={selectedStatus === 'All' ? null : selectedStatus}
            onChange={(value) => {
              setSelectedStatus(value ?? 'All');
              pager.setPage(1);
            }}
            placeholder={t('common.selectStatusAll')}
            searchable={false}
            cleanable={selectedStatus !== 'All'}
            size="sm"
          />
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          <button
            id="import-equipment-btn"
            disabled={importing}
            onClick={handleImport}
            title={t('equipmentList.importTitle')}
            className="px-4 py-2 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>{importing ? t('equipmentList.importing') : t('equipmentList.importFromLegacy')}</span>
          </button>

          {/* Add Equipment Button */}
          <button
            id="add-equipment-btn"
            onClick={() => { setEditingEquipment(null); setIsModalOpen(true); }}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t('equipmentList.addEquipment')}</span>
          </button>
        </div>
      </div>

      {(error || equipmentClassesError || retireError || importError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error || equipmentClassesError || retireError || importError}</span>
        </div>
      )}

      {/* Main Equipment Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        {filteredList.length === 0 ? (
          <div className="py-8 text-center text-slate-400 text-sm">{t('equipmentList.empty')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={viewColumns} rows={paginatedList} rowKey={(item) => item.id} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={paginatedList} rowKey={(item) => item.id} cells={viewCells} actionsIndex={9} /></div>
        )}

        <TablePagination pinToBottom {...pager} />
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
        onGetActivationHistory={onGetActivationHistory}
        plants={plants}
        onGetEquipmentPlacementHistory={onGetEquipmentPlacementHistory}
        onGetEquipmentRecommendations={onGetEquipmentRecommendations}
      />
    </div>
  );
};
