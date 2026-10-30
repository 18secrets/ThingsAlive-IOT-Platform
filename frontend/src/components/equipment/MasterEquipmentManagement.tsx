import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Plus, AlertCircle, Edit2, Ban, History, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, EquipmentInput, EquipmentPlacementEvent, EquipmentProfile, Plant,
} from '../../lib/api';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable, ListColumn } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';
import { ClientAccount } from '../../types';
import { MasterAddEquipmentModal } from './MasterAddEquipmentModal';
import { sortRows, useSort } from '../../lib/useSort';

interface MasterEquipmentManagementProps {
  equipment: EquipmentProfile[];
  error?: string;
  /** True until the first answer: the list is unknown then, not empty (test report MAJ-6). */
  loading?: boolean;
  clients: ClientAccount[];
  onCreateEquipment: (input: EquipmentInput) => Promise<EquipmentProfile>;
  onUpdateEquipment: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<EquipmentProfile>;
  onMoveEquipment: (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string, tenantId: string,
  ) => Promise<EquipmentProfile>;
  onRetireEquipment: (
    sourceSystem: string, externalId: string, reason: string, tenantId: string,
  ) => Promise<EquipmentProfile>;
  onGetEquipmentPlacementHistory: (
    sourceSystem: string, externalId: string, tenantId: string,
  ) => Promise<EquipmentPlacementEvent[]>;
  onListPlantsForTenant: (tenantId: string) => Promise<Plant[]>;
}

// Labels are equipment.status.<value> in the devices namespace.
const STATUS_VALUES: EquipmentProfile['status'][] = ['active', 'retired'];

export const MasterEquipmentManagement: React.FC<MasterEquipmentManagementProps> = ({
  equipment, error, loading, clients, onCreateEquipment, onUpdateEquipment, onMoveEquipment, onRetireEquipment,
  onGetEquipmentPlacementHistory, onListPlantsForTenant,
}) => {
  const { t } = useTranslation(['devices', 'shared']);
  const [viewMode, setViewMode] = useViewMode('admin-equipment');
  const STATUS_OPTIONS = STATUS_VALUES.map((value) => ({ label: t(`equipment.status.${value}`), value }));
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('All');
  const [selectedStatus, setSelectedStatus] = useState<'All' | EquipmentProfile['status']>('active');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<EquipmentProfile | null>(null);
  const [retiringKey, setRetiringKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<EquipmentPlacementEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [plantsByTenant, setPlantsByTenant] = useState<Record<string, Plant[]>>({});

  const clientName = useMemo(() => {
    const byId = new Map(clients.map((c) => [c.id, c.clientName]));
    return (tenantId: string) => byId.get(tenantId) ?? tenantId;
  }, [clients]);

  const plantName = (tenantId: string, plantId: string | null) => {
    if (!plantId) return t('equipment.noSite');
    return plantsByTenant[tenantId]?.find((p) => p.id === plantId)?.name ?? plantId;
  };

  // Pull in a tenant's sites the first time any of its equipment is shown, so the
  // table can resolve a site id to a name without fetching every account's sites
  // up front for a page that may only ever look at one of them.
  useEffect(() => {
    const unknown = [...new Set(equipment.map((e) => e.tenantId))].filter((tid) => !(tid in plantsByTenant));
    if (!unknown.length) return;
    unknown.forEach((tenantId) => {
      onListPlantsForTenant(tenantId)
        .then((plants) => setPlantsByTenant((prev) => ({ ...prev, [tenantId]: plants })))
        .catch(() => setPlantsByTenant((prev) => ({ ...prev, [tenantId]: [] })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment]);

  const clientOptions = useMemo(
    () => [{ label: t('equipment.allClients'), value: 'All' }, ...clients.map((c) => ({ label: c.clientName, value: c.id }))],
    [clients, t],
  );

  const filteredList = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return equipment.filter((item) => {
      const matchesClient = selectedClientId === 'All' || item.tenantId === selectedClientId;
      const matchesStatus = selectedStatus === 'All' || item.status === selectedStatus;
      const matchesSearch =
        (item.name ?? '').toLowerCase().includes(term) ||
        item.externalId.toLowerCase().includes(term) ||
        clientName(item.tenantId).toLowerCase().includes(term);
      return matchesClient && matchesStatus && matchesSearch;
    });
  }, [equipment, searchTerm, selectedClientId, selectedStatus, clientName]);

  const key = (item: EquipmentProfile) => `${item.tenantId}:${item.sourceSystem}:${item.externalId}`;

  const handleRetire = async (item: EquipmentProfile) => {
    const reason = window.prompt(t('equipment.retirePrompt', { name: item.name ?? item.externalId }));
    if (!reason) return;
    setRetiringKey(key(item));
    setActionError(undefined);
    try {
      await onRetireEquipment(item.sourceSystem, item.externalId, reason, item.tenantId);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('equipment.retireFailed'));
    } finally {
      setRetiringKey(null);
    }
  };

  const handleToggleHistory = async (item: EquipmentProfile) => {
    const k = key(item);
    if (historyKey === k) { setHistoryKey(null); return; }
    setHistoryKey(k);
    setHistoryLoading(true);
    setHistory([]);
    try {
      setHistory(await onGetEquipmentPlacementHistory(item.sourceSystem, item.externalId, item.tenantId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('equipment.historyFailed'));
    } finally {
      setHistoryLoading(false);
    }
  };

  // Sortable headers (test report MAJ-9): the whole filtered set is sorted, then paged.
  const { sort, toggle } = useSort<'client' | 'code' | 'name' | 'site' | 'tier' | 'status'>({ key: 'client', dir: 'asc' });
  const sorted = useMemo(() => sortRows(filteredList, sort, {
    client: (e) => clientName(e.tenantId),
    code: (e) => e.externalId,
    name: (e) => e.name ?? e.externalId,
    site: (e) => e.plantId ? plantName(e.tenantId, e.plantId) : null,
    tier: (e) => e.tier,
    status: (e) => e.status,
  }), [filteredList, sort, clientName, plantsByTenant]);
  const { pageItems: pagedRows, ...pager } = usePagination(sorted);
  const historyItem = historyKey ? equipment.find((item) => key(item) === historyKey) : undefined;
  const historyPanel = useRef<HTMLDivElement>(null);
  // The panel sits under the whole list, so on a full page it would open out of sight.
  useEffect(() => {
    if (historyKey) historyPanel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [historyKey]);

  // One definition for both views (cards or list on every list page).
  const viewColumns: ListColumn[] = [
    { label: t('translation:common.client'), sortKey: 'client' },
    { label: t('equipment.col.code'), sortKey: 'code' },
    { label: t('equipment.col.name'), sortKey: 'name' },
    { label: t('equipment.col.site'), sortKey: 'site' },
    { label: t('equipment.col.tier'), sortKey: 'tier' },
    { label: t('list.col.status'), sortKey: 'status' },
    { label: t('equipment.col.actions'), width: 130 },
  ];
  const viewCells = (item: EquipmentProfile) => {
    const k = key(item);
    const busy = retiringKey === k;
    return [
      <span className="text-slate-600 dark:text-slate-400">{clientName(item.tenantId)}</span>,
      <span className="font-mono text-[11px]">{item.externalId}</span>,
      <span className="text-slate-900 dark:text-white">{item.name || '—'}</span>,
      <span className="text-slate-600 dark:text-slate-400">{plantName(item.tenantId, item.plantId)}</span>,
      <span className="capitalize text-slate-600 dark:text-slate-400">{t(`equipment.tier.${item.tier}`, { defaultValue: item.tier })}</span>,
      <><span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                            item.status === 'active'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                          }`}>
                            {t(`equipment.status.${item.status}`, { defaultValue: item.status })}
                          </span></>,
      <><div className="flex items-center gap-1.5">
                            <button
                              onClick={() => { setEditingEquipment(item); setIsModalOpen(true); }}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                              title={t('equipment.edit')}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleHistory(item)}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                              title={t('equipment.placementHistory')}
                            >
                              {historyKey === k ? <ChevronUp className="w-3.5 h-3.5" /> : <History className="w-3.5 h-3.5" />}
                            </button>
                            {item.status === 'active' && (
                              <button
                                onClick={() => handleRetire(item)}
                                disabled={busy}
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 transition-colors cursor-pointer"
                                title={t('equipment.retire')}
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div></>,
    ];
  };

  return (
    <div id="master-equipment-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('equipment.searchPlaceholder')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <SelectPicker
              data={clientOptions}
              value={selectedClientId}
              onChange={(value) => setSelectedClientId(value ?? 'All')}
              searchable={clientOptions.length > 6}
              cleanable={false}
              size="sm"
              block
              className="w-full sm:w-48"
            />
            <SelectPicker
              data={[{ label: t('equipment.allStatuses'), value: 'All' }, ...STATUS_OPTIONS]}
              value={selectedStatus}
              onChange={(value) => setSelectedStatus((value ?? 'All') as typeof selectedStatus)}
              searchable={false}
              cleanable={false}
              size="sm"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          <button
          onClick={() => { setEditingEquipment(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('equipment.register')}</span>
        </button>
        </div>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error ?? actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        {filteredList.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm">{loading ? t('shared:loading') : t('equipment.empty')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare sort={sort} onSort={(key) => { toggle(key as typeof sort.key); pager.setPage(1); }} columns={viewColumns} rows={pagedRows} rowKey={key} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedRows} rowKey={key} cells={viewCells} actionsIndex={6} /></div>
        )}

        {/* Placement history opened as a row under its machine before the switch to rsuite's
            table, which has no room for that; one panel under the list serves both views. */}
        {historyItem && (
          <div ref={historyPanel} className="px-4 pb-3 pt-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 space-y-1.5">
            <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              {t('equipment.placementHistory')}: {historyItem.name || historyItem.externalId}
            </p>
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                              {historyLoading && <p className="text-[11px] text-slate-400">{t('shared:loading')}</p>}
                              {!historyLoading && history.length === 0 && (
                                <p className="text-[11px] text-slate-400">{t('equipment.noHistory')}</p>
                              )}
                              {history.map((h) => (
                                <div key={h.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-start justify-between gap-2">
                                  <span>
                                    {plantName(historyItem.tenantId, h.fromPlantId)} → {plantName(historyItem.tenantId, h.toPlantId)}
                                    {h.reason ? `: "${h.reason}"` : ''}
                                  </span>
                                  <span className="text-slate-400 shrink-0">{new Date(h.at).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
          </div>
        )}

        <TablePagination pinToBottom loading={loading} {...pager} />
      </div>

      <MasterAddEquipmentModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingEquipment(null); }}
        onCreate={onCreateEquipment}
        onUpdate={onUpdateEquipment}
        onMove={onMoveEquipment}
        clients={clients}
        onListPlantsForTenant={onListPlantsForTenant}
        existingEquipment={editingEquipment}
        allEquipment={equipment}
      />
    </div>
  );
};
