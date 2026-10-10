import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Plus, AlertCircle, Edit2, Ban, History, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import {
  ApiError, EquipmentInput, EquipmentPlacementEvent, EquipmentProfile, Plant,
} from '../../lib/api';
import { ClientAccount } from '../../types';
import { MasterAddEquipmentModal } from './MasterAddEquipmentModal';

interface MasterEquipmentManagementProps {
  equipment: EquipmentProfile[];
  error?: string;
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

const STATUS_OPTIONS = [
  { label: 'Active', value: 'active' },
  { label: 'Retired', value: 'retired' },
];

export const MasterEquipmentManagement: React.FC<MasterEquipmentManagementProps> = ({
  equipment, error, clients, onCreateEquipment, onUpdateEquipment, onMoveEquipment, onRetireEquipment,
  onGetEquipmentPlacementHistory, onListPlantsForTenant,
}) => {
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
    if (!plantId) return 'No site';
    return plantsByTenant[tenantId]?.find((p) => p.id === plantId)?.name ?? plantId;
  };

  // Pull in a tenant's sites the first time any of its equipment is shown, so the
  // table can resolve a site id to a name without fetching every account's sites
  // up front for a page that may only ever look at one of them.
  useEffect(() => {
    const unknown = [...new Set(equipment.map((e) => e.tenantId))].filter((t) => !(t in plantsByTenant));
    if (!unknown.length) return;
    unknown.forEach((tenantId) => {
      onListPlantsForTenant(tenantId)
        .then((plants) => setPlantsByTenant((prev) => ({ ...prev, [tenantId]: plants })))
        .catch(() => setPlantsByTenant((prev) => ({ ...prev, [tenantId]: [] })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment]);

  const clientOptions = useMemo(
    () => [{ label: 'All clients', value: 'All' }, ...clients.map((c) => ({ label: c.clientName, value: c.id }))],
    [clients],
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
    const reason = window.prompt(`Why is ${item.name ?? item.externalId} being retired?`);
    if (!reason) return;
    setRetiringKey(key(item));
    setActionError(undefined);
    try {
      await onRetireEquipment(item.sourceSystem, item.externalId, reason, item.tenantId);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not retire this machine.');
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
      setActionError(err instanceof ApiError ? err.message : 'Could not load placement history.');
    } finally {
      setHistoryLoading(false);
    }
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
              placeholder="Search machine, code or client..."
              size="sm"
              className="w-full pl-9!"
            />
          </div>
          <SelectPicker
            data={clientOptions}
            value={selectedClientId}
            onChange={(value) => setSelectedClientId(value ?? 'All')}
            searchable={clientOptions.length > 6}
            cleanable={false}
            size="sm"
            className="min-w-[180px]"
          />
          <SelectPicker
            data={[{ label: 'All statuses', value: 'All' }, ...STATUS_OPTIONS]}
            value={selectedStatus}
            onChange={(value) => setSelectedStatus((value ?? 'All') as typeof selectedStatus)}
            searchable={false}
            cleanable={false}
            size="sm"
          />
        </div>

        <button
          onClick={() => { setEditingEquipment(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Register Equipment</span>
        </button>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error ?? actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4">Code</th>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Site</th>
                <th className="py-3 px-4">Tier</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredList.length > 0 ? (
                filteredList.map((item) => {
                  const k = key(item);
                  const busy = retiringKey === k;
                  return (
                    <React.Fragment key={k}>
                      <tr className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{clientName(item.tenantId)}</td>
                        <td className="py-3 px-4 font-mono text-[11px]">{item.externalId}</td>
                        <td className="py-3 px-4 text-slate-900 dark:text-white">{item.name || '—'}</td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{plantName(item.tenantId, item.plantId)}</td>
                        <td className="py-3 px-4 capitalize text-slate-600 dark:text-slate-400">{item.tier}</td>
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                            item.status === 'active'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => { setEditingEquipment(item); setIsModalOpen(true); }}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleHistory(item)}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                              title="Placement history"
                            >
                              {historyKey === k ? <ChevronUp className="w-3.5 h-3.5" /> : <History className="w-3.5 h-3.5" />}
                            </button>
                            {item.status === 'active' && (
                              <button
                                onClick={() => handleRetire(item)}
                                disabled={busy}
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 transition-colors cursor-pointer"
                                title="Retire"
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {historyKey === k && (
                        <tr>
                          <td colSpan={7} className="px-4 pb-3 bg-slate-50/60 dark:bg-slate-800/30">
                            <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                              {historyLoading && <p className="text-[11px] text-slate-400">Loading…</p>}
                              {!historyLoading && history.length === 0 && (
                                <p className="text-[11px] text-slate-400">No placement history for this asset yet.</p>
                              )}
                              {history.map((h) => (
                                <div key={h.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-start justify-between gap-2">
                                  <span>
                                    {plantName(item.tenantId, h.fromPlantId)} → {plantName(item.tenantId, h.toPlantId)}
                                    {h.reason ? `: "${h.reason}"` : ''}
                                  </span>
                                  <span className="text-slate-400 shrink-0">{new Date(h.at).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400 font-sans">
                    No equipment found matching criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 text-xs text-slate-600 dark:text-slate-400">
          Total Rows: <span className="font-semibold text-slate-800 dark:text-slate-200">{filteredList.length}</span>
        </div>
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
      />
    </div>
  );
};
