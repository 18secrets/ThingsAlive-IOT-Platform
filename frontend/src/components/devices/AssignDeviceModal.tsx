import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { ApiError, PooledDevice } from '../../lib/api';
import { ClientAccount } from '../../types';

interface AssignDeviceModalProps {
  device: PooledDevice | null;
  clients: ClientAccount[];
  onClose: () => void;
  onAssign: (imei: string, tenantId: string) => Promise<void>;
}

export const AssignDeviceModal: React.FC<AssignDeviceModalProps> = ({ device, clients, onClose, onAssign }) => {
  const [tenantId, setTenantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setTenantId('');
    setError(undefined);
  }, [device]);

  if (!device) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAssign(device.imei, tenantId);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assign the device.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Assign Device</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-700 font-mono text-slate-700 dark:text-slate-200">
            {device.imei}
          </div>
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Client <span className="text-red-500">*</span>
            </label>
            <select
              required
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-sky-500 outline-none cursor-pointer"
            >
              <option value="">— Select client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.clientName}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2 rounded-lg bg-[#0077b6] hover:bg-[#023e8a] text-white font-medium shadow-xs flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              {busy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
