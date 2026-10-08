import React, { useEffect, useMemo, useState } from 'react';
import { X, AlertCircle, CheckCircle2, Radio, Unplug, Link2 } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import {
  ApiError, CoverageResult, DiscoveryCandidate, DiscoveryResult, EquipmentProfile,
  MyDevice, ProposeOrActivateBindingInput, SignalBindingDiscoveredBy, SignalBindingVersion,
} from '../../lib/api';

interface EquipmentBindingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  equipment: EquipmentProfile | null;
  devices: MyDevice[];
  devicesError?: string;
  onClaimDevice: (imei: string, equipmentExternalId: string, sourceSystem: string) => Promise<MyDevice>;
  onUnclaimDevice: (imei: string, reason?: string) => Promise<MyDevice>;
  onGetCoverage: (sourceSystem: string, externalId: string) => Promise<CoverageResult>;
  onGetDiscovery: (sourceSystem: string, externalId: string) => Promise<DiscoveryResult>;
  onProposeOrActivateBinding: (
    sourceSystem: string, externalId: string, input: ProposeOrActivateBindingInput,
  ) => Promise<SignalBindingVersion>;
}

const reasonLabel: Record<string, string> = {
  unbound: 'Unbound',
  mapping_required: 'Mapping required',
  stale: 'Stale',
  no_readings: 'No readings',
};

export const EquipmentBindingsModal: React.FC<EquipmentBindingsModalProps> = ({
  isOpen, onClose, equipment, devices, devicesError,
  onClaimDevice, onUnclaimDevice, onGetCoverage, onGetDiscovery, onProposeOrActivateBinding,
}) => {
  const [coverage, setCoverage] = useState<CoverageResult | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [claimImei, setClaimImei] = useState('');

  useEffect(() => {
    if (!isOpen || !equipment) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    (async () => {
      try {
        const [cov, disc] = await Promise.all([
          onGetCoverage(equipment.sourceSystem, equipment.externalId),
          onGetDiscovery(equipment.sourceSystem, equipment.externalId),
        ]);
        if (!live) return;
        setCoverage(cov);
        setDiscovery(disc);
      } catch (err) {
        if (live) setError(err instanceof ApiError ? err.message : 'Could not load bindings.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, equipment?.sourceSystem, equipment?.externalId]);

  const fittedDevices = useMemo(
    () => (equipment ? devices.filter((d) => d.equipmentExternalId === equipment.externalId) : []),
    [devices, equipment],
  );
  const claimableDevices = useMemo(
    () => (equipment ? devices.filter((d) => d.equipmentExternalId !== equipment.externalId && d.state === 'assigned') : []),
    [devices, equipment],
  );
  const claimableOptions = useMemo(
    () => claimableDevices.map((d) => ({ label: `${d.imei}${d.model ? ` — ${d.model}` : ''}`, value: d.imei })),
    [claimableDevices],
  );

  if (!isOpen || !equipment) return null;

  const refresh = async () => {
    const [cov, disc] = await Promise.all([
      onGetCoverage(equipment.sourceSystem, equipment.externalId),
      onGetDiscovery(equipment.sourceSystem, equipment.externalId),
    ]);
    setCoverage(cov);
    setDiscovery(disc);
  };

  const handleClaim = async () => {
    if (!claimImei) return;
    setBusyKey('claim');
    setError(undefined);
    try {
      await onClaimDevice(claimImei, equipment.externalId, equipment.sourceSystem);
      setClaimImei('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not fit this device.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleUnclaim = async (imei: string) => {
    const reason = window.prompt(`Why is device ${imei} being taken off ${equipment.name ?? equipment.externalId}?`);
    if (reason === null) return;
    setBusyKey(`unclaim-${imei}`);
    setError(undefined);
    try {
      await onUnclaimDevice(imei, reason || undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take this device off.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleBind = async (
    action: 'propose' | 'activate',
    candidate: DiscoveryCandidate,
    discoveredBy: SignalBindingDiscoveredBy,
  ) => {
    const key = `${action}-${candidate.signalKey}-${candidate.imei ?? ''}`;
    setBusyKey(key);
    setError(undefined);
    try {
      await onProposeOrActivateBinding(equipment.sourceSystem, equipment.externalId, {
        action,
        signalKey: candidate.signalKey,
        measurementRole: candidate.measurementRole,
        origin: 'physical',
        imei: candidate.imei ?? undefined,
        canonicalUnit: candidate.unit ?? '',
        validFrom: new Date().toISOString(),
        discoveredBy,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this binding.');
    } finally {
      setBusyKey(null);
    }
  };

  const renderCandidateRow = (candidate: DiscoveryCandidate, discoveredBy: SignalBindingDiscoveredBy) => {
    const proposeKey = `propose-${candidate.signalKey}-${candidate.imei ?? ''}`;
    const activateKey = `activate-${candidate.signalKey}-${candidate.imei ?? ''}`;
    return (
      <li
        key={`${discoveredBy}-${candidate.signalKey}-${candidate.imei ?? ''}`}
        className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40"
      >
        <div className="min-w-0">
          <p className="font-mono text-xs text-slate-800 dark:text-slate-100 truncate">{candidate.signalKey}</p>
          <p className="text-[11px] text-slate-400 truncate">
            {candidate.imei ? `IMEI ${candidate.imei}` : 'No device'}
            {candidate.sensorName ? ` • ${candidate.sensorName}` : ''}
            {candidate.unit ? ` • ${candidate.unit}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => handleBind('propose', candidate, discoveredBy)}
            disabled={busyKey === proposeKey || !candidate.imei}
            className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-sky-300 hover:text-sky-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busyKey === proposeKey ? 'Proposing…' : 'Propose'}
          </button>
          <button
            onClick={() => handleBind('activate', candidate, discoveredBy)}
            disabled={busyKey === activateKey || !candidate.imei}
            className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busyKey === activateKey ? 'Activating…' : 'Activate'}
          </button>
        </div>
      </li>
    );
  };

  return (
    <div
      id="equipmentBindingsModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <div>
            <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">Signal Bindings</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">{equipment.name ?? equipment.externalId}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-sm overflow-y-auto">
          {(error || devicesError) && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error || devicesError}</span>
            </div>
          )}

          {loading ? (
            <p className="text-xs text-slate-400">Loading coverage and discovery…</p>
          ) : (
            <>
              {/* Coverage */}
              <div>
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">Coverage</h4>
                {!coverage || (coverage.covered.length === 0 && coverage.missing.length === 0) ? (
                  <p className="text-xs text-slate-400">
                    {equipment.equipmentClassSlug ? 'No required signals on this class.' : 'Not classified — no coverage to compute.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {coverage.missing.map((m) => (
                      <li key={`${m.measurementRole}-${m.componentScope}`} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-xs">
                        <span className="font-mono text-slate-700 dark:text-slate-200">{m.measurementRole}</span>
                        <span className="text-amber-700 dark:text-amber-300 font-medium">{reasonLabel[m.reason] ?? m.reason}</span>
                      </li>
                    ))}
                    {coverage.covered.map((c) => (
                      <li key={`${c.measurementRole}-${c.componentScope}`} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-xs">
                        <span className="font-mono text-slate-700 dark:text-slate-200">{c.measurementRole}</span>
                        <span className="text-emerald-700 dark:text-emerald-300 font-medium flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Covered
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Devices fitted to this machine */}
              <div>
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">Devices on this machine</h4>
                {fittedDevices.length === 0 ? (
                  <p className="text-xs text-slate-400">No device fitted yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {fittedDevices.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-xs">
                        <span className="font-mono text-slate-700 dark:text-slate-200">{d.imei}</span>
                        <button
                          onClick={() => handleUnclaim(d.imei)}
                          disabled={busyKey === `unclaim-${d.imei}`}
                          className="p-1 rounded border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-50"
                          title="Take off this machine"
                        >
                          <Unplug className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <SelectPicker
                    data={claimableOptions}
                    value={claimImei || null}
                    onChange={(value) => setClaimImei(value ?? '')}
                    placeholder="Fit a device from stock…"
                    className="flex-1"
                    searchable={claimableOptions.length > 6}
                    cleanable
                    size="sm"
                  />
                  <button
                    onClick={handleClaim}
                    disabled={!claimImei || busyKey === 'claim'}
                    className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    <span>{busyKey === 'claim' ? 'Fitting…' : 'Fit'}</span>
                  </button>
                </div>
              </div>

              {/* Discovery */}
              {discovery && (discovery.matched.length > 0 || discovery.expectedNotMapped.length > 0 || discovery.mappedNotExpected.length > 0) && (
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-sky-600" /> Candidate channels
                  </h4>
                  {discovery.matched.length > 0 && (
                    <div>
                      <p className="text-[11px] text-slate-400 mb-1.5">Matched — expected and reporting</p>
                      <ul className="space-y-1.5">{discovery.matched.map((c) => renderCandidateRow(c, 'both'))}</ul>
                    </div>
                  )}
                  {discovery.expectedNotMapped.length > 0 && (
                    <div>
                      <p className="text-[11px] text-slate-400 mb-1.5">Expected, not yet reporting</p>
                      <ul className="space-y-1.5">{discovery.expectedNotMapped.map((c) => renderCandidateRow(c, 'tool-mapping'))}</ul>
                    </div>
                  )}
                  {discovery.mappedNotExpected.length > 0 && (
                    <div>
                      <p className="text-[11px] text-slate-400 mb-1.5">Reporting, not expected by this class</p>
                      <ul className="space-y-1.5">{discovery.mappedNotExpected.map((c) => renderCandidateRow(c, 'sensor-map'))}</ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
