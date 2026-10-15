import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, UserPlus, AlertCircle, Undo2, Archive, RotateCcw, History, Edit2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import {
  ApiError, DeviceInventoryEvent, InventoryAction, PooledDevice, RegisterDeviceInput, ToolMapping, apiGetDeviceHistory,
} from '../../lib/api';
import { ClientAccount } from '../../types';
import { Modal } from '../common/Modal';
import { AssignDeviceModal } from './AssignDeviceModal';
import { RegisterDevicesModal } from './RegisterDevicesModal';

const STATE_OPTIONS: { label: string; value: PooledDevice['state'] }[] = [
  { label: 'In stock', value: 'in-stock' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Retired', value: 'retired' },
];

interface DevicePoolManagementProps {
  pool: PooledDevice[];
  error?: string;
  clients: ClientAccount[];
  toolMappings: ToolMapping[];
  onRegister: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
  onAssign: (imei: string, tenantId: string) => Promise<void>;
  onRelease: (imei: string) => Promise<void>;
  onRetire: (imei: string) => Promise<void>;
  onReturnToStock: (imei: string) => Promise<void>;
  onUpdate: (imei: string, input: DeviceEdit) => Promise<void>;
}

type DeviceEdit = { model?: string | null; toolMappingId?: string | null; batchRef?: string | null; notes?: string | null };

const STATE_STYLE: Record<PooledDevice['state'], string> = {
  'in-stock': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  assigned: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

export const DevicePoolManagement: React.FC<DevicePoolManagementProps> = ({
  pool, error, clients, toolMappings, onRegister, onAssign, onRelease, onRetire, onReturnToStock, onUpdate,
}) => {
  const [editing, setEditing] = useState<PooledDevice | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedState, setSelectedState] = useState<'All' | PooledDevice['state']>('All');
  const [assigning, setAssigning] = useState<PooledDevice | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [busyImei, setBusyImei] = useState<string | null>(null);
  const [historyImei, setHistoryImei] = useState<string | null>(null);

  const withBusy = async (imei: string, action: () => Promise<void>) => {
    setBusyImei(imei);
    try {
      await action();
    } finally {
      setBusyImei(null);
    }
  };

  const clientName = useMemo(() => {
    const byId = new Map(clients.map((c) => [c.id, c.clientName]));
    return (tenantId: string | null) => (tenantId ? byId.get(tenantId) ?? tenantId : null);
  }, [clients]);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return pool.filter((d) => {
      const matchesSearch =
        d.imei.toLowerCase().includes(term) ||
        (d.model?.toLowerCase().includes(term) ?? false) ||
        (d.toolMappingName?.toLowerCase().includes(term) ?? false) ||
        (clientName(d.tenantId)?.toLowerCase().includes(term) ?? false);
      const matchesState = selectedState === 'All' || d.state === selectedState;
      return matchesSearch && matchesState;
    });
  }, [pool, searchTerm, selectedState, clientName]);

  return (
    <div id="device-pool-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder="Search IMEI, model, tool profile or client..."
              size="sm"
              className="w-full pl-9! pr-4"
            />
          </div>
          <SelectPicker
            data={STATE_OPTIONS}
            value={selectedState === 'All' ? null : selectedState}
            onChange={(value) => setSelectedState(value ?? 'All')}
            placeholder="All States"
            searchable={false}
            cleanable={selectedState !== 'All'}
            size="sm"
          />
        </div>

        <button
          id="register-device-btn"
          onClick={() => setIsRegisterOpen(true)}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Register Device</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">IMEI</th>
                <th className="py-3 px-4">Model</th>
                <th className="py-3 px-4">Tool Profile</th>
                <th className="py-3 px-4">State</th>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filtered.length > 0 ? (
                filtered.map((d) => (
                  <tr key={d.imei} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px]">{d.imei}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{d.model || '—'}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{d.toolMappingName || '—'}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATE_STYLE[d.state]}`}>
                        {d.state}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {clientName(d.tenantId) || <span className="text-slate-400 italic">Unassigned</span>}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setHistoryImei(d.imei)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
                          title="History: every account and machine it has been on"
                        >
                          <History className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setEditing(d)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
                          title="Edit model, tool profile, batch or notes"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {d.state === 'in-stock' && (
                          <>
                            <button
                              onClick={() => setAssigning(d)}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title="Assign to a client"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => withBusy(d.imei, () => onRetire(d.imei))}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title="Retire: dead, lost or written off"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {d.state === 'assigned' && (
                          <>
                            <button
                              onClick={() => withBusy(d.imei, () => onRelease(d.imei))}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-amber-600 hover:border-amber-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title="Take back into stock"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => withBusy(d.imei, () => onRetire(d.imei))}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title="Retire: dead, lost or written off"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {d.state === 'retired' && (
                          <button
                            onClick={() => withBusy(d.imei, () => onReturnToStock(d.imei))}
                            disabled={busyImei === d.imei}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                            title="Repaired — bring back into stock"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
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

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 text-xs text-slate-600 dark:text-slate-400">
          Total Rows: <span className="font-semibold text-slate-800 dark:text-slate-200">{filtered.length}</span>
        </div>
      </div>

      <AssignDeviceModal
        device={assigning}
        clients={clients}
        onClose={() => setAssigning(null)}
        onAssign={onAssign}
      />

      <RegisterDevicesModal
        isOpen={isRegisterOpen}
        onClose={() => setIsRegisterOpen(false)}
        toolMappings={toolMappings}
        onRegister={onRegister}
      />

      {editing && (
        <EditDeviceModal
          key={editing.imei}
          device={editing}
          toolMappings={toolMappings}
          onClose={() => setEditing(null)}
          onSave={async (input) => { await onUpdate(editing.imei, input); setEditing(null); }}
        />
      )}

      <Modal isOpen={!!historyImei} onClose={() => setHistoryImei(null)} title="Device history" subtitle={historyImei ?? undefined} maxWidth="max-w-xl">
        {historyImei && <DeviceHistory key={historyImei} imei={historyImei} clientName={clientName} />}
      </Modal>
    </div>
  );
};

const ACTION_LABEL: Record<InventoryAction, string> = {
  register: 'Registered', assign: 'Assigned to client', release: 'Taken back into stock', retire: 'Retired',
  'return-to-stock': 'Returned to stock', claim: 'Fitted to a machine', unclaim: 'Taken off its machine',
};

/** Oldest first, as the backend returns it — a device's life reads top to bottom. */
const DeviceHistory: React.FC<{ imei: string; clientName: (tenantId: string | null) => string | null }> = ({ imei, clientName }) => {
  const [events, setEvents] = useState<DeviceInventoryEvent[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetDeviceHistory(imei)
      .then((e) => { if (live) setEvents(e); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load the history.'); });
    return () => { live = false; };
  }, [imei]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!events) return <p className="text-sm text-slate-500">Loading…</p>;
  if (events.length === 0) return <p className="text-sm text-slate-400">No history recorded.</p>;

  return (
    <ol className="space-y-2">
      {events.map((ev) => (
        <li key={ev.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-xs space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{ACTION_LABEL[ev.action] ?? ev.action}</span>
            <span className="text-slate-400">{new Date(ev.at).toLocaleString()}</span>
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            {ev.fromState ? `${ev.fromState} → ` : ''}{ev.toState}
            {ev.tenantId && ` · ${clientName(ev.tenantId) || ev.tenantId}`}
            {ev.equipmentExternalId && ` · machine ${ev.equipmentExternalId}`}
          </p>
          {ev.reason && <p className="text-slate-600 dark:text-slate-300">“{ev.reason}”</p>}
        </li>
      ))}
    </ol>
  );
};

/** Corrects what was typed at registration. Fields are sent only when changed, so an
 *  untouched tool profile on a device that has left stock is never refused. */
const EditDeviceModal: React.FC<{
  device: PooledDevice; toolMappings: ToolMapping[];
  onClose: () => void; onSave: (input: DeviceEdit) => Promise<void>;
}> = ({ device, toolMappings, onClose, onSave }) => {
  const [model, setModel] = useState(device.model ?? '');
  const [toolMappingId, setToolMappingId] = useState<string | null>(device.toolMappingId);
  const [batchRef, setBatchRef] = useState(device.batchRef ?? '');
  const [notes, setNotes] = useState(device.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inStock = device.state === 'in-stock';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input: DeviceEdit = {};
    if (model.trim() !== (device.model ?? '')) input.model = model;
    if (batchRef.trim() !== (device.batchRef ?? '')) input.batchRef = batchRef;
    if (notes.trim() !== (device.notes ?? '')) input.notes = notes;
    if (toolMappingId !== device.toolMappingId) input.toolMappingId = toolMappingId;
    if (!Object.keys(input).length) { onClose(); return; }
    setBusy(true);
    setError(undefined);
    try {
      await onSave(input);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this device.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5';
  return (
    <Modal isOpen onClose={onClose} title="Edit device" subtitle={`IMEI ${device.imei}`}>
      <form onSubmit={submit} className="px-6 py-5 space-y-4">
        <div>
          <label className={field}>Model</label>
          <Input size="sm" value={model} onChange={setModel} placeholder="e.g. FMB120" />
        </div>
        <div>
          <label className={field}>Tool profile</label>
          <SelectPicker
            block
            size="sm"
            disabled={!inStock}
            data={toolMappings.map((t) => ({ label: t.toolName, value: t.id }))}
            value={toolMappingId}
            onChange={(v) => setToolMappingId(v ?? null)}
            placeholder="None"
          />
          {!inStock && (
            <p className="text-[11px] text-slate-400 mt-1">
              Fixed while the device is {device.state}: a client machine may already be bound to the signals this profile declares.
            </p>
          )}
        </div>
        <div>
          <label className={field}>Batch / delivery note</label>
          <Input size="sm" value={batchRef} onChange={setBatchRef} />
        </div>
        <div>
          <label className={field}>Notes</label>
          <Input size="sm" as="textarea" rows={2} value={notes} onChange={setNotes} />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-xs font-semibold cursor-pointer disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
