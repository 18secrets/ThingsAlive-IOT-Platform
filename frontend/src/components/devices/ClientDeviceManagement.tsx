import React, { useMemo, useState } from 'react';
import { Search, AlertCircle, Unplug, Info } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { ApiError, EquipmentProfile, MyDevice } from '../../lib/api';

const STATE_OPTIONS: { label: string; value: MyDevice['state'] }[] = [
  { label: 'In stock', value: 'in-stock' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Retired', value: 'retired' },
];

const STATE_STYLE: Record<MyDevice['state'], string> = {
  'in-stock': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  assigned: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

interface ClientDeviceManagementProps {
  devices: MyDevice[];
  error?: string;
  equipment: EquipmentProfile[];
  onUnclaimDevice: (imei: string, reason?: string) => Promise<MyDevice>;
}

export const ClientDeviceManagement: React.FC<ClientDeviceManagementProps> = ({
  devices, error, equipment, onUnclaimDevice,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedState, setSelectedState] = useState<'All' | MyDevice['state']>('All');
  const [busyImei, setBusyImei] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const equipmentName = useMemo(() => {
    const byExternalId = new Map(equipment.map((e) => [e.externalId, e.name ?? e.externalId]));
    return (externalId: string | null) => (externalId ? byExternalId.get(externalId) ?? externalId : null);
  }, [equipment]);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return devices.filter((d) => {
      const matchesSearch =
        d.imei.toLowerCase().includes(term) ||
        (d.model?.toLowerCase().includes(term) ?? false) ||
        (equipmentName(d.equipmentExternalId)?.toLowerCase().includes(term) ?? false);
      const matchesState = selectedState === 'All' || d.state === selectedState;
      return matchesSearch && matchesState;
    });
  }, [devices, searchTerm, selectedState, equipmentName]);

  const handleUnclaim = async (d: MyDevice) => {
    const reason = window.prompt(`Why is device ${d.imei} being taken off ${equipmentName(d.equipmentExternalId) ?? 'its machine'}?`);
    if (reason === null) return;
    setBusyImei(d.imei);
    setActionError(undefined);
    try {
      await onUnclaimDevice(d.imei, reason || undefined);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not take this device off.');
    } finally {
      setBusyImei(null);
    }
  };

  return (
    <div id="client-device-management-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder="Search IMEI, model or machine..."
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
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span>Fitting a device to a machine happens from that machine's Signal Bindings panel — this is the read-only list, with the one action that belongs here.</span>
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
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">IMEI</th>
                <th className="py-3 px-4">Model</th>
                <th className="py-3 px-4">State</th>
                <th className="py-3 px-4">Fitted To</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filtered.length > 0 ? (
                filtered.map((d) => (
                  <tr key={d.imei} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px]">{d.imei}</td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">{d.model || '—'}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATE_STYLE[d.state]}`}>
                        {d.state}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {equipmentName(d.equipmentExternalId) || <span className="text-slate-400 italic">Not fitted</span>}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {d.state === 'assigned' && d.equipmentExternalId && (
                        <button
                          onClick={() => handleUnclaim(d)}
                          disabled={busyImei === d.imei}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-50"
                          title="Take off this machine"
                        >
                          <Unplug className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400 font-sans">
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
    </div>
  );
};
