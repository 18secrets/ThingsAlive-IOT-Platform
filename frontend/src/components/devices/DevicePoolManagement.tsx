import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, UserPlus, AlertCircle, Undo2, Archive, RotateCcw, History, Edit2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, DeviceInventoryEvent, InventoryAction, PooledDevice, RegisterDeviceInput, ToolMapping, apiGetDeviceHistory,
} from '../../lib/api';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ClientAccount } from '../../types';
import { Modal } from '../common/Modal';
import { AssignDeviceModal } from './AssignDeviceModal';
import { RegisterDevicesModal } from './RegisterDevicesModal';

// Labels are state.<value> in the devices namespace.
const STATE_VALUES: PooledDevice['state'][] = ['in-stock', 'assigned', 'retired'];

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
  const { t } = useTranslation(['devices', 'shared']);
  const STATE_OPTIONS = STATE_VALUES.map((value) => ({ label: t(`state.${value}`), value }));
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

  const { pageItems: pagedRows, ...pager } = usePagination(filtered);

  return (
    <div id="device-pool-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('pool.searchPlaceholder')}
              size="sm"
              className="w-full pl-9! pr-4"
            />
          </div>
          <SelectPicker
            data={STATE_OPTIONS}
            value={selectedState === 'All' ? null : selectedState}
            onChange={(value) => setSelectedState(value ?? 'All')}
            placeholder={t('pool.allStates')}
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
          <span>{t('pool.register')}</span>
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
                <th className="py-3 px-4">{t('pool.col.model')}</th>
                <th className="py-3 px-4">{t('pool.col.toolProfile')}</th>
                <th className="py-3 px-4">{t('pool.col.state')}</th>
                <th className="py-3 px-4">{t('translation:common.client')}</th>
                <th className="py-3 px-4 text-center">{t('pool.col.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filtered.length > 0 ? (
                pagedRows.map((d) => (
                  <tr key={d.imei} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px]">{d.imei}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{d.model || '—'}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{d.toolMappingName || '—'}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATE_STYLE[d.state]}`}>
                        {t(`state.${d.state}`, { defaultValue: d.state })}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {clientName(d.tenantId) || <span className="text-slate-400 italic">{t('pool.unassigned')}</span>}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setHistoryImei(d.imei)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
                          title={t('pool.historyHint')}
                        >
                          <History className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setEditing(d)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
                          title={t('pool.editHint')}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {d.state === 'in-stock' && (
                          <>
                            <button
                              onClick={() => setAssigning(d)}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title={t('pool.assignHint')}
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => withBusy(d.imei, () => onRetire(d.imei))}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title={t('pool.retireHint')}
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
                              title={t('pool.releaseHint')}
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => withBusy(d.imei, () => onRetire(d.imei))}
                              disabled={busyImei === d.imei}
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                              title={t('pool.retireHint')}
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
                            title={t('pool.returnHint')}
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
                    {t('pool.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <TablePagination {...pager} />
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

      <Modal isOpen={!!historyImei} onClose={() => setHistoryImei(null)} title={t('history.title')} subtitle={historyImei ?? undefined} maxWidth="max-w-xl">
        {historyImei && <DeviceHistory key={historyImei} imei={historyImei} clientName={clientName} />}
      </Modal>
    </div>
  );
};

// Labels are history.action.<action>; the raw action shows if a new one appears.
const actionKey = (action: InventoryAction) => `history.action.${action}`;

/** Oldest first, as the backend returns it — a device's life reads top to bottom. */
const DeviceHistory: React.FC<{ imei: string; clientName: (tenantId: string | null) => string | null }> = ({ imei, clientName }) => {
  const { t } = useTranslation(['devices', 'shared']);
  const [events, setEvents] = useState<DeviceInventoryEvent[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetDeviceHistory(imei)
      .then((e) => { if (live) setEvents(e); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('history.loadFailed')); });
    return () => { live = false; };
  }, [imei, t]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!events) return <p className="text-sm text-slate-500">{t('shared:loading')}</p>;
  if (events.length === 0) return <p className="text-sm text-slate-400">{t('history.empty')}</p>;

  return (
    <ol className="space-y-2">
      {events.map((ev) => (
        <li key={ev.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-xs space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{t(actionKey(ev.action), { defaultValue: ev.action })}</span>
            <span className="text-slate-400">{new Date(ev.at).toLocaleString()}</span>
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            {ev.fromState ? `${t(`state.${ev.fromState}`, { defaultValue: ev.fromState })} → ` : ''}{t(`state.${ev.toState}`, { defaultValue: ev.toState })}
            {ev.tenantId && ` · ${clientName(ev.tenantId) || ev.tenantId}`}
            {ev.equipmentExternalId && ` · ${t('history.machine', { id: ev.equipmentExternalId })}`}
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
  const { t } = useTranslation(['devices', 'shared']);
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
      setError(err instanceof ApiError ? err.message : t('edit.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const field = 'block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5';
  return (
    <Modal isOpen onClose={onClose} title={t('edit.title')} subtitle={`IMEI ${device.imei}`}>
      <form onSubmit={submit} className="px-6 py-5 space-y-4">
        <div>
          <label className={field}>{t('edit.model')}</label>
          <Input size="sm" value={model} onChange={setModel} placeholder={t('edit.modelPlaceholder')} />
        </div>
        <div>
          <label className={field}>{t('edit.toolProfile')}</label>
          <SelectPicker
            block
            size="sm"
            disabled={!inStock}
            data={toolMappings.map((tm) => ({ label: tm.toolName, value: tm.id }))}
            value={toolMappingId}
            onChange={(v) => setToolMappingId(v ?? null)}
            placeholder={t('edit.none')}
          />
          {!inStock && (
            <p className="text-[11px] text-slate-400 mt-1">
              {t('edit.profileLocked', { state: t(`state.${device.state}`, { defaultValue: device.state }) })}
            </p>
          )}
        </div>
        <div>
          <label className={field}>{t('edit.batch')}</label>
          <Input size="sm" value={batchRef} onChange={setBatchRef} />
        </div>
        <div>
          <label className={field}>{t('edit.notes')}</label>
          <Input size="sm" as="textarea" rows={2} value={notes} onChange={setNotes} />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
            {t('shared:cancel')}
          </button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-xs font-semibold cursor-pointer disabled:opacity-50">
            {busy ? t('shared:saving') : t('shared:save')}
          </button>
        </div>
      </form>
    </Modal>
  );
};
