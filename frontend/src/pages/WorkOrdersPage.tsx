import React, { useEffect, useMemo, useState } from 'react';
import { Plus, ClipboardList, AlertCircle, Clock3 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import {
  ApiError, EquipmentProfile, FleetLinkRow, Plant, RaiseWorkOrderInput, WorkOrder, WorkOrderPriority, WorkOrderStatus,
  apiActOnWorkOrder, apiGetDeviceHealthFleet, apiListEquipment, apiListPlants, apiListWorkOrders, apiRaiseWorkOrder,
} from '../lib/api';

const STATUS_OPTIONS: WorkOrderStatus[] = ['created', 'in-progress', 'completed', 'cancelled'];
const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  created: 'Open', 'in-progress': 'In progress', completed: 'Completed', cancelled: 'Cancelled',
};
const STATUS_STYLE: Record<WorkOrderStatus, string> = {
  created: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  'in-progress': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  completed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  cancelled: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};
const PRIORITY_OPTIONS: WorkOrderPriority[] = ['low', 'normal', 'high', 'urgent'];

export const WorkOrdersPage: React.FC = () => {
  usePageHeader({ title: 'Work Orders', subtitle: 'Maintenance Tasks' });

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setOrders(await apiListWorkOrders());
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load work orders.');
    }
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Independent, not Promise.all — equipment still populates the create form
    // even if listing work orders itself fails (and vice versa).
    apiListEquipment().then((e) => { if (live) setEquipment(e); }).catch(() => {});
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetDeviceHealthFleet().then((rows) => { if (live) setLinkHealth(rows); }).catch(() => {});
    apiListWorkOrders()
      .then((o) => { if (live) { setOrders(o); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load work orders.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const equipmentName = (sourceSystem: string, externalId: string) => profileOf(sourceSystem, externalId)?.name ?? externalId;
  const connectionOf = (externalId: string): 'online' | 'offline' | null => {
    const row = linkHealth.find((r) => r.externalId === externalId);
    if (!row) return null;
    return row.state === 'dark' ? 'offline' : 'online';
  };

  const equipmentClasses = useMemo(
    () => [...new Set(equipment.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))].sort(),
    [equipment],
  );

  const equipmentOptions = useMemo(
    () => equipment.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId, label: `${e.name ?? e.externalId} (${e.externalId})` })),
    [equipment],
  );

  const visible = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return orders.filter((o) => {
      const profile = profileOf(o.sourceSystem, o.externalId);
      const key = `${o.sourceSystem}|${o.externalId}`;
      const matchesSelected = selectedKey === 'all' || key === selectedKey;
      const matchesStatus = statusFilter === 'all' || o.status === statusFilter;
      const matchesPlant = scope.plantId === 'all' || profile?.plantId === scope.plantId;
      const matchesClass = scope.classSlug === 'all' || profile?.equipmentClassSlug === scope.classSlug;
      const matchesConnection = scope.connection === 'all' || connectionOf(o.externalId) === scope.connection;
      const matchesQuery = !term || o.title.toLowerCase().includes(term) || equipmentName(o.sourceSystem, o.externalId).toLowerCase().includes(term);
      return matchesSelected && matchesStatus && matchesPlant && matchesClass && matchesConnection && matchesQuery;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, equipment, linkHealth, statusFilter, scope, selectedKey]);

  async function act(order: WorkOrder, action: 'start' | 'complete' | 'cancel' | 'reopen') {
    let note: string | undefined;
    if (action !== 'start') {
      const prompt = { complete: 'What was done?', cancel: 'Why is this being cancelled?', reopen: 'Why is this being reopened?' }[action];
      const entered = window.prompt(prompt);
      if (!entered?.trim()) return;
      note = entered.trim();
    }
    setBusyId(order.id);
    try {
      await apiActOnWorkOrder(order.id, action, note);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update this job.');
    } finally {
      setBusyId(null);
    }
  }

  async function createOrder(input: RaiseWorkOrderInput) {
    try {
      await apiRaiseWorkOrder(input);
      setCreating(false);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not raise this job.');
    }
  }

  return (
    <div id="work-orders-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-bold">Work Orders</h2>
          <p className="text-sm text-sky-100">Jobs raised against your equipment</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-white text-sky-700 hover:bg-sky-50 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Create work order
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <EquipmentFilters
          scope={scope}
          onChange={setScope}
          plants={plants}
          classes={equipmentClasses}
          equipmentOptions={equipmentOptions}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
        <SelectPicker
          data={[{ label: 'All statuses', value: 'all' }, ...STATUS_OPTIONS.map((s) => ({ label: STATUS_LABEL[s], value: s }))]}
          value={statusFilter}
          onChange={(value) => setStatusFilter((value ?? 'all') as 'all' | WorkOrderStatus)}
          searchable={false}
          cleanable={false}
          className="min-w-[180px]"
        />
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
          <ClipboardList className="w-6 h-6" />
          No work orders for this selection.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((o) => (
            <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-slate-400">{o.reference}</span>
                <Chip tone={o.status === 'completed' ? 'emerald' : o.status === 'cancelled' ? 'rose' : o.status === 'in-progress' ? 'amber' : 'sky'}>
                  {STATUS_LABEL[o.status]}
                </Chip>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base">{o.title}</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400">{equipmentName(o.sourceSystem, o.externalId)}</p>
              {o.description && <p className="text-sm text-slate-500 dark:text-slate-400">{o.description}</p>}
              {o.resolution && <p className="text-xs text-slate-400 dark:text-slate-500">Resolution: {o.resolution}</p>}
              <small className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 pt-1">
                <Clock3 className="w-3.5 h-3.5" />{new Date(o.createdAt).toLocaleString()}
                {o.dueAt ? ` · due ${new Date(o.dueAt).toLocaleDateString()}` : ''}
              </small>
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                {(o.status === 'created' || o.status === 'in-progress') && (
                  <>
                    {o.status === 'created' && (
                      <button disabled={busyId === o.id} onClick={() => act(o, 'start')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
                        Start
                      </button>
                    )}
                    <button disabled={busyId === o.id} onClick={() => act(o, 'complete')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-300 disabled:opacity-50 cursor-pointer">
                      Complete
                    </button>
                    <button disabled={busyId === o.id} onClick={() => act(o, 'cancel')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-50 cursor-pointer">
                      Cancel
                    </button>
                  </>
                )}
                {(o.status === 'completed' || o.status === 'cancelled') && (
                  <button disabled={busyId === o.id} onClick={() => act(o, 'reopen')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
                    Reopen
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={creating} onClose={() => setCreating(false)} title="Create work order" subtitle="New Maintenance Task" maxWidth="max-w-xl">
        <CreateWorkOrderForm equipment={equipment} onCancel={() => setCreating(false)} onCreate={createOrder} />
      </Modal>
    </div>
  );
};

const CreateWorkOrderForm: React.FC<{
  equipment: EquipmentProfile[];
  onCancel: () => void;
  onCreate: (input: RaiseWorkOrderInput) => void;
}> = ({ equipment, onCancel, onCreate }) => {
  const [title, setTitle] = useState('');
  const [equipmentKey, setEquipmentKey] = useState<string | null>(null);
  const [priority, setPriority] = useState<WorkOrderPriority>('normal');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !equipmentKey) return;
        const [sourceSystem, externalId] = equipmentKey.split('|');
        onCreate({
          sourceSystem, externalId, title: title.trim(), priority,
          description: description.trim() || undefined,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Task</span>
        <Input required value={title} onChange={(value) => setTitle(value)} placeholder="e.g. Inspect coolant sensor" />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Equipment</span>
        <SelectPicker
          data={equipment.map((e) => ({ label: `${e.name ?? e.externalId} (${e.externalId})`, value: `${e.sourceSystem}|${e.externalId}` }))}
          value={equipmentKey}
          onChange={(value) => setEquipmentKey(value ?? null)}
          placeholder="Select equipment"
          block
          searchable
          cleanable={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Priority</span>
          <SelectPicker
            data={PRIORITY_OPTIONS.map((p) => ({ label: p, value: p }))}
            value={priority}
            onChange={(value) => setPriority((value ?? 'normal') as WorkOrderPriority)}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Due date</span>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Description</span>
        <Input as="textarea" rows={3} value={description} onChange={(value) => setDescription(value)} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!equipmentKey} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          Create work order
        </button>
      </div>
    </form>
  );
};
