import React, { useEffect, useMemo, useState } from 'react';
import { Plus, ClipboardList, AlertCircle, Clock3, Wrench, UserRound } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import {
  ApiError, AssetForecast, EditWorkOrderInput, EquipmentProfile, FleetLinkRow, Plant, RaiseWorkOrderInput,
  ServiceStatus, TenantUser, WorkOrder, WorkOrderEvent, WorkOrderEventKind, WorkOrderPriority, WorkOrderStatus,
  apiActOnWorkOrder, apiAssignWorkOrder, apiEditWorkOrder, apiGetDeviceHealthFleet, apiGetServiceForecast,
  apiGetWorkOrderHistory, apiListEquipment, apiListPlants, apiListTenantUsers, apiListWorkOrders, apiRaiseWorkOrder,
} from '../lib/api';

const SERVICE_STATUS_TONE: Record<ServiceStatus, 'rose' | 'amber' | 'sky' | 'emerald'> = {
  overdue: 'rose', due: 'amber', approaching: 'sky', ok: 'emerald',
};
const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  overdue: 'Overdue', due: 'Due', approaching: 'Approaching', ok: 'Ok',
};

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

const EVENT_LABEL: Record<WorkOrderEventKind, string> = {
  raised: 'Raised', assigned: 'Assigned', unassigned: 'Unassigned', started: 'Started',
  completed: 'Completed', cancelled: 'Cancelled', reopened: 'Reopened', edited: 'Edited',
};

const ACTION_BUTTON = 'px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-50 cursor-pointer';

export const WorkOrdersPage: React.FC = () => {
  usePageHeader({ title: 'Work Orders', subtitle: 'Maintenance Tasks' });

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [serviceDue, setServiceDue] = useState<AssetForecast[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<{ equipmentKey: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // null, not [], when the list can't be read: GET /identity/users needs user.manage,
  // which a manager who may assign jobs (action.assign) doesn't necessarily hold — the
  // assign form has to tell "nobody to pick" apart from "not allowed to see who".
  const [users, setUsers] = useState<TenantUser[] | null>(null);
  const [editing, setEditing] = useState<WorkOrder | null>(null);
  const [assigning, setAssigning] = useState<WorkOrder | null>(null);
  const [historyOf, setHistoryOf] = useState<WorkOrder | null>(null);

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
    apiGetServiceForecast().then((r) => { if (live) setServiceDue(r.assets); }).catch(() => {});
    apiListTenantUsers().then((u) => { if (live) setUsers(u); }).catch(() => {});
    apiListWorkOrders()
      .then((o) => { if (live) { setOrders(o); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load work orders.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const equipmentName = (sourceSystem: string, externalId: string) => profileOf(sourceSystem, externalId)?.name ?? externalId;
  const userName = (id: string) => users?.find((u) => u.id === id)?.fullName ?? 'a user';
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

  // Ok and incomplete (no status at all — missing an interval, a meter, or a rate)
  // forecasts aren't worth a fitter's attention here; only the three that call for
  // action, already sorted overdue-first by the backend.
  const dueAssets = useMemo(
    () => serviceDue.filter((a): a is AssetForecast & { status: Exclude<ServiceStatus, 'ok'> } => !!a.status && a.status !== 'ok'),
    [serviceDue],
  );

  function raiseForService(asset: AssetForecast) {
    setPrefill({
      equipmentKey: `${asset.sourceSystem}|${asset.externalId}`,
      title: `Service — ${asset.name ?? asset.externalId}`,
    });
    setCreating(true);
  }

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

  async function editOrder(order: WorkOrder, input: EditWorkOrderInput) {
    try {
      await apiEditWorkOrder(order.id, input);
      setEditing(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not save this job.');
    }
  }

  async function assignOrder(order: WorkOrder, userId: string | null, note?: string) {
    try {
      await apiAssignWorkOrder(order.id, userId, note);
      setAssigning(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not assign this job.');
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
          onClick={() => { setPrefill(null); setCreating(true); }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-white text-sky-700 hover:bg-sky-50 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Create work order
        </button>
      </div>

      {dueAssets.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 rounded-xl p-4 shadow-xs space-y-2">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Service due</h3>
          </div>
          <div className="space-y-1.5">
            {dueAssets.map((a) => (
              <div key={`${a.sourceSystem}/${a.externalId}`} className="flex items-center justify-between gap-2 text-xs border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
                <div className="min-w-0">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">{a.name ?? a.externalId}</span>
                  <span className="text-slate-400 ml-1.5">
                    {a.status === 'overdue' && a.hoursRemaining != null
                      ? `${Math.abs(a.hoursRemaining)}h overdue`
                      : a.hoursRemaining != null ? `${a.hoursRemaining}h remaining` : 'interval or meter not set'}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Chip tone={SERVICE_STATUS_TONE[a.status]}>{SERVICE_STATUS_LABEL[a.status]}</Chip>
                  <button
                    onClick={() => raiseForService(a)}
                    className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer"
                  >
                    Raise work order
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
              <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <UserRound className="w-3.5 h-3.5" />
                {o.assignedToUserId ? userName(o.assignedToUserId) : 'Unassigned'}
                <span className="text-slate-300 dark:text-slate-600">·</span>
                <span className="capitalize">{o.priority}</span>
              </p>
              <small className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 pt-1">
                <Clock3 className="w-3.5 h-3.5" />{new Date(o.createdAt).toLocaleString()}
                {o.dueAt ? ` · due ${new Date(o.dueAt).toLocaleDateString()}` : ''}
              </small>
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                {(o.status === 'created' || o.status === 'in-progress') && (
                  <>
                    {o.status === 'created' && (
                      <button disabled={busyId === o.id} onClick={() => act(o, 'start')} className={`${ACTION_BUTTON} hover:border-sky-300`}>
                        Start
                      </button>
                    )}
                    <button disabled={busyId === o.id} onClick={() => act(o, 'complete')} className={`${ACTION_BUTTON} hover:border-emerald-300`}>
                      Complete
                    </button>
                    <button disabled={busyId === o.id} onClick={() => act(o, 'cancel')} className={`${ACTION_BUTTON} hover:border-rose-300`}>
                      Cancel
                    </button>
                    {/* Open and in-progress only: the backend refuses to reassign a
                        closed job until it is reopened. */}
                    <button disabled={busyId === o.id} onClick={() => setAssigning(o)} className={`${ACTION_BUTTON} hover:border-sky-300`}>
                      Assign
                    </button>
                  </>
                )}
                {(o.status === 'completed' || o.status === 'cancelled') && (
                  <button disabled={busyId === o.id} onClick={() => act(o, 'reopen')} className={`${ACTION_BUTTON} hover:border-sky-300`}>
                    Reopen
                  </button>
                )}
                <button disabled={busyId === o.id} onClick={() => setEditing(o)} className={`${ACTION_BUTTON} hover:border-sky-300`}>
                  Edit
                </button>
                <button onClick={() => setHistoryOf(o)} className={`${ACTION_BUTTON} hover:border-sky-300`}>
                  History
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={creating} onClose={() => { setCreating(false); setPrefill(null); }} title="Create work order" subtitle="New Maintenance Task" maxWidth="max-w-xl">
        <CreateWorkOrderForm equipment={equipment} initial={prefill} onCancel={() => { setCreating(false); setPrefill(null); }} onCreate={createOrder} />
      </Modal>

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit work order" subtitle={editing?.reference} maxWidth="max-w-xl">
        {editing && <EditWorkOrderForm key={editing.id} order={editing} onCancel={() => setEditing(null)} onSave={(input) => editOrder(editing, input)} />}
      </Modal>

      <Modal isOpen={!!assigning} onClose={() => setAssigning(null)} title="Assign work order" subtitle={assigning?.reference} maxWidth="max-w-md">
        {assigning && (
          <AssignWorkOrderForm
            key={assigning.id}
            order={assigning}
            users={users}
            onCancel={() => setAssigning(null)}
            onAssign={(userId, note) => assignOrder(assigning, userId, note)}
          />
        )}
      </Modal>

      <Modal isOpen={!!historyOf} onClose={() => setHistoryOf(null)} title="Work order history" subtitle={historyOf ? `${historyOf.reference} · ${historyOf.title}` : undefined} maxWidth="max-w-xl">
        {historyOf && <WorkOrderHistory key={historyOf.id} order={historyOf} userName={userName} />}
      </Modal>
    </div>
  );
};

const EditWorkOrderForm: React.FC<{
  order: WorkOrder;
  onCancel: () => void;
  onSave: (input: EditWorkOrderInput) => void;
}> = ({ order, onCancel, onSave }) => {
  const [title, setTitle] = useState(order.title);
  const [priority, setPriority] = useState<WorkOrderPriority>(order.priority);
  const [description, setDescription] = useState(order.description ?? '');
  const [dueAt, setDueAt] = useState(order.dueAt ? order.dueAt.slice(0, 10) : '');

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSave({
          title: title.trim(),
          priority,
          description: description.trim(),
          // Only sent when set: PATCH /work-orders/:id treats a missing or empty dueAt
          // as "leave it", so a due date can be moved but not removed from here.
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Task</span>
        <Input required value={title} onChange={(value) => setTitle(value)} />
      </label>
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
          {order.dueAt && <span className="block text-[11px] text-slate-400">Left empty, the current due date stays.</span>}
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
        <button type="submit" disabled={!title.trim()} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          Save changes
        </button>
      </div>
    </form>
  );
};

const UNASSIGNED = '__unassigned__';

const AssignWorkOrderForm: React.FC<{
  order: WorkOrder;
  users: TenantUser[] | null;
  onCancel: () => void;
  onAssign: (userId: string | null, note?: string) => void;
}> = ({ order, users, onCancel, onAssign }) => {
  const [choice, setChoice] = useState<string>(order.assignedToUserId ?? UNASSIGNED);
  const [note, setNote] = useState('');
  // Suspended and invited users can't open the job, so they aren't offered; the backend
  // separately refuses anyone whose site/machine access doesn't cover this machine.
  const options = (users ?? []).filter((u) => u.status === 'active');
  const unchanged = choice === (order.assignedToUserId ?? UNASSIGNED);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (unchanged) return;
        onAssign(choice === UNASSIGNED ? null : choice, note.trim() || undefined);
      }}
    >
      {users === null && (
        <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
          Your role can't list this account's users, so only unassigning is available here.
        </p>
      )}
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Assign to</span>
        <SelectPicker
          data={[
            { label: 'Unassigned', value: UNASSIGNED },
            ...options.map((u) => ({ label: `${u.fullName} (${u.email})`, value: u.id })),
          ]}
          value={choice}
          onChange={(value) => setChoice(value ?? UNASSIGNED)}
          block
          searchable
          cleanable={false}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Note (optional)</span>
        <Input value={note} onChange={(value) => setNote(value)} placeholder="e.g. On site Thursday" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={unchanged} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {choice === UNASSIGNED ? 'Unassign' : 'Assign'}
        </button>
      </div>
    </form>
  );
};

const WorkOrderHistory: React.FC<{ order: WorkOrder; userName: (id: string) => string }> = ({ order, userName }) => {
  const [events, setEvents] = useState<WorkOrderEvent[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetWorkOrderHistory(order.id)
      .then((e) => { if (live) setEvents(e); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load history.'); });
    return () => { live = false; };
  }, [order.id]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!events) return <p className="text-sm text-slate-500">Loading…</p>;
  if (events.length === 0) return <p className="text-sm text-slate-400">No history recorded.</p>;

  // Oldest first, as the backend returns it — the story of a job reads top to bottom.
  return (
    <ol className="space-y-2">
      {events.map((ev) => (
        <li key={ev.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-xs space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{EVENT_LABEL[ev.kind]}</span>
            <span className="text-slate-400">{new Date(ev.at).toLocaleString()}</span>
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            by {userName(ev.actorUserId)}
            {ev.fromStatus && ev.toStatus && ev.fromStatus !== ev.toStatus && ` · ${STATUS_LABEL[ev.fromStatus]} → ${STATUS_LABEL[ev.toStatus]}`}
            {ev.kind === 'assigned' && ev.toAssignee && ` · to ${userName(ev.toAssignee)}`}
            {ev.kind === 'unassigned' && ev.fromAssignee && ` · from ${userName(ev.fromAssignee)}`}
          </p>
          {ev.note && ev.kind !== 'raised' && <p className="text-slate-600 dark:text-slate-300">“{ev.note}”</p>}
        </li>
      ))}
    </ol>
  );
};

const CreateWorkOrderForm: React.FC<{
  equipment: EquipmentProfile[];
  initial?: { equipmentKey: string; title: string } | null;
  onCancel: () => void;
  onCreate: (input: RaiseWorkOrderInput) => void;
}> = ({ equipment, initial, onCancel, onCreate }) => {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [equipmentKey, setEquipmentKey] = useState<string | null>(initial?.equipmentKey ?? null);
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
