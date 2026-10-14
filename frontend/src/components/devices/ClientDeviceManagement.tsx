import React, { useEffect, useMemo, useState } from 'react';
import { Search, AlertCircle, Unplug, Info, Activity } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { ApiError, DeviceHealthWindow, DeviceLinkState, EquipmentProfile, MyDevice, apiGetDeviceHealth } from '../../lib/api';
import { Chip } from '../common/Chip';
import { Modal } from '../common/Modal';

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
  const [healthOf, setHealthOf] = useState<MyDevice | null>(null);

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
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setHealthOf(d)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Connection health, window by window"
                        >
                          <Activity className="w-3.5 h-3.5" />
                        </button>
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
                      </div>
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

      <Modal
        isOpen={!!healthOf}
        onClose={() => setHealthOf(null)}
        title="Connection health"
        subtitle={healthOf ? `${healthOf.imei}${healthOf.equipmentExternalId ? ` · ${equipmentName(healthOf.equipmentExternalId)}` : ''}` : undefined}
        maxWidth="max-w-2xl"
      >
        {healthOf && <DeviceHealth key={healthOf.imei} imei={healthOf.imei} />}
      </Modal>
    </div>
  );
};

const HEALTH_TONE: Record<DeviceLinkState, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  healthy: 'emerald', 'weak-signal': 'amber', buffering: 'amber', intermittent: 'amber', partial: 'amber',
  dark: 'rose', unknown: 'slate',
};

const minutes = (seconds: number | null) => (seconds == null ? null : `${Math.round(seconds / 60)} min`);

/** The newest windows first (the backend returns up to 50), each with what made it
 *  that state — the per-logger version of the fleet's online/offline filter. */
const DeviceHealth: React.FC<{ imei: string }> = ({ imei }) => {
  const [windows, setWindows] = useState<DeviceHealthWindow[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetDeviceHealth(imei)
      .then((w) => { if (live) setWindows(w); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load connection health.'); });
    return () => { live = false; };
  }, [imei]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!windows) return <p className="text-sm text-slate-500">Loading…</p>;
  if (windows.length === 0) {
    return <p className="text-sm text-slate-400">No health windows recorded yet. They appear once the logger has reported and been assessed.</p>;
  }

  return (
    <ol className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
      {windows.map((w) => (
        <li key={w.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-600 dark:text-slate-300">
              {new Date(w.windowStart).toLocaleString()} – {new Date(w.windowEnd).toLocaleTimeString()}
            </span>
            <Chip tone={HEALTH_TONE[w.state] ?? 'slate'}>{w.state}</Chip>
          </div>
          <p className="text-slate-500 dark:text-slate-400">{w.detail}</p>
          <p className="text-[11px] text-slate-400">
            {w.samples} sample{w.samples === 1 ? '' : 's'}
            {w.signalBand ? ` · signal ${w.signalBand}` : ''}
            {minutes(w.longestGapSeconds) ? ` · longest gap ${minutes(w.longestGapSeconds)}` : ''}
            {minutes(w.medianLagSeconds) ? ` · median lag ${minutes(w.medianLagSeconds)}` : ''}
          </p>
          {w.missingSignals.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">Missing: {w.missingSignals.join(', ')}</p>
          )}
        </li>
      ))}
    </ol>
  );
};
