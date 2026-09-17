import React, { useMemo, useState } from 'react';
import { Search, Plus, UserPlus, AlertCircle } from 'lucide-react';
import { PooledDevice } from '../../lib/api';
import { ClientAccount } from '../../types';
import { AssignDeviceModal } from './AssignDeviceModal';

interface DevicePoolManagementProps {
  pool: PooledDevice[];
  error?: string;
  clients: ClientAccount[];
  onNavigateToRegister: () => void;
  onAssign: (imei: string, tenantId: string) => Promise<void>;
}

const STATE_STYLE: Record<PooledDevice['state'], string> = {
  'in-stock': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  assigned: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

export const DevicePoolManagement: React.FC<DevicePoolManagementProps> = ({
  pool, error, clients, onNavigateToRegister, onAssign,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedState, setSelectedState] = useState<'All' | PooledDevice['state']>('All');
  const [assigning, setAssigning] = useState<PooledDevice | null>(null);

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
        (d.toolMappingName?.toLowerCase().includes(term) ?? false);
      const matchesState = selectedState === 'All' || d.state === selectedState;
      return matchesSearch && matchesState;
    });
  }, [pool, searchTerm, selectedState]);

  return (
    <div id="device-pool-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search IMEI, model or tool profile..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>
          <select
            value={selectedState}
            onChange={(e) => setSelectedState(e.target.value as 'All' | PooledDevice['state'])}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">All States</option>
            <option value="in-stock">In stock</option>
            <option value="assigned">Assigned</option>
            <option value="retired">Retired</option>
          </select>
        </div>

        <button
          id="register-device-btn"
          onClick={onNavigateToRegister}
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
                      {d.state === 'in-stock' && (
                        <button
                          onClick={() => setAssigning(d)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
                          title="Assign to a client"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                        </button>
                      )}
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
    </div>
  );
};
