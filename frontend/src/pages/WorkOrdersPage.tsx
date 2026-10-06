import React, { useMemo, useState } from 'react';
import { Plus, ClipboardList, ArrowLeft } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { MOCK_WORK_ORDERS, MockWorkOrder, WorkOrderPriority, WorkOrderStatus } from '../data/clientOpsMockData';
import { FLEET, excursionsFor, findThing, isBreaching } from '../data/fleetMockData';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';

const STATUS_OPTIONS: WorkOrderStatus[] = ['Open', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
const STATUS_STYLE: Record<WorkOrderStatus, string> = {
  Open: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  'In Progress': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  'On Hold': 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  Completed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  Cancelled: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

// One auto-generated order per machine currently past its coolant range —
// same idea as the demo's generatedOrders(), worded from excursionsFor().
const AUTO_ORDERS: MockWorkOrder[] = FLEET.filter(isBreaching).map((t) => ({
  id: `auto-${t.id}`,
  title: 'Inspect cooling system',
  equipmentCode: t.id,
  equipmentName: t.name,
  status: 'Open',
  priority: 'Medium',
  channel: 'Things Service',
  contact: 'Simulation record',
  createdAt: '2026-09-23T16:30:00+05:30',
  notes: `SYNTHETIC: ${excursionsFor(t)} running-hour samples exceeded the assumed ${t.coolantLimitC} °C coolant limit. Review before action.`,
}));

type View = 'list' | 'create';

export const WorkOrdersPage: React.FC = () => {
  const [view, setView] = useState<View>('list');
  usePageHeader(
    view === 'create'
      ? { title: 'Create Work Order', subtitle: 'New Maintenance Task' }
      : { title: 'Work Orders', subtitle: 'Maintenance Tasks' },
  );
  const [orders, setOrders] = useState<MockWorkOrder[]>([...AUTO_ORDERS, ...MOCK_WORK_ORDERS]);
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const matchingIds = useMemo(() => new Set(matching.map((t) => t.id)), [matching]);
  const visible = orders.filter((o) => matchingIds.has(o.equipmentCode) && (selectedId === 'all' || o.equipmentCode === selectedId));

  function setStatus(id: string, status: WorkOrderStatus) {
    setOrders((current) => current.map((o) => (o.id === id ? { ...o, status } : o)));
  }

  function createOrder(order: Omit<MockWorkOrder, 'id' | 'createdAt'>) {
    setOrders((current) => [{ ...order, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...current]);
    setView('list');
  }

  if (view === 'create') {
    return <CreateWorkOrderForm onCancel={() => setView('list')} onCreate={createOrder} />;
  }

  return (
    <div id="work-orders-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-bold">Work Orders</h2>
          <p className="text-sm text-sky-100">Saved in this browser · communications not sent</p>
        </div>
        <button
          onClick={() => setView('create')}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-white text-sky-700 hover:bg-sky-50 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> Create work order
        </button>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={setSelectedId} />

      {visible.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
          <ClipboardList className="w-6 h-6" />
          No work orders for this selection.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((o) => {
            const thing = findThing(o.equipmentCode);
            return (
              <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
                <div className="flex items-center justify-between">
                  <ClipboardList className="w-5 h-5 text-slate-400" />
                  <select
                    value={o.status}
                    onChange={(e) => setStatus(o.id, e.target.value as WorkOrderStatus)}
                    className={`text-[12px] font-medium rounded-lg border px-2 py-1 ${STATUS_STYLE[o.status]}`}
                  >
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <h4 className="font-semibold text-slate-900 dark:text-white text-sm">{o.title}</h4>
                <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing?.name ?? o.equipmentName}</p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500">{o.channel} · {o.contact || 'Contact not specified'}</p>
                {o.notes && <p className="text-[12px] text-slate-500 dark:text-slate-400">{o.notes}</p>}
                <small className="block text-[11px] text-slate-400 dark:text-slate-500 pt-1">{new Date(o.createdAt).toLocaleString()} · Not dispatched</small>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const CreateWorkOrderForm: React.FC<{
  onCancel: () => void;
  onCreate: (order: Omit<MockWorkOrder, 'id' | 'createdAt'>) => void;
}> = ({ onCancel, onCreate }) => {
  const [title, setTitle] = useState('');
  const [equipmentCode, setEquipmentCode] = useState('');
  const [equipmentName, setEquipmentName] = useState('');
  const [priority, setPriority] = useState<WorkOrderPriority>('Medium');
  const [notes, setNotes] = useState('');

  return (
    <div className="space-y-6 max-w-xl">
      <button onClick={onCancel} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft className="w-4 h-4" /> Back to work orders
      </button>

      <form
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 shadow-xs"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !equipmentCode.trim()) return;
          onCreate({ title: title.trim(), equipmentCode: equipmentCode.trim(), equipmentName: equipmentName.trim() || equipmentCode.trim(), status: 'Open', priority, channel: 'Things Service', contact: '', notes: notes.trim() || undefined });
        }}
      >
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Task</span>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" placeholder="e.g. Inspect coolant sensor" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Equipment code</span>
            <input required value={equipmentCode} onChange={(e) => setEquipmentCode(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" placeholder="e.g. 4100460" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Equipment name</span>
            <input value={equipmentName} onChange={(e) => setEquipmentName(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" placeholder="e.g. Diesel Generator Set 320 kVA" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as WorkOrderPriority)} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
        </label>
        <div className="flex items-center gap-2 pt-2">
          <button type="submit" className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">Create work order</button>
          <button type="button" onClick={onCancel} className="px-3.5 py-2 text-sm font-medium rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
        </div>
      </form>
    </div>
  );
};
