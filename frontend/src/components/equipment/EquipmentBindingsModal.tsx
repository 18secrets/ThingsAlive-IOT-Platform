import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, AlertCircle, CheckCircle2, Radio, Unplug, Link2, Gauge, Zap, ExternalLink, History, ChevronDown, ChevronUp, MapPin } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import {
  ApiError, CoverageResult, DiscoveryCandidate, DiscoveryResult, EquipmentProfile,
  MyDevice, ProposeOrActivateBindingInput, SignalBindingDiscoveredBy, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction, ActivationHistoryEvent, EquipmentRecommendation,
  Plant, EquipmentPlacementEvent,
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
  onListEquipmentKpis: (sourceSystem: string, externalId: string) => Promise<KpiEnvelope[]>;
  onListMyCatalogScenarios: (equipmentClassSlug?: string) => Promise<ClientScenario[]>;
  onListActivations: (sourceSystem: string, externalId: string) => Promise<ActivationView[]>;
  onActivationTransition: (
    action: ActivationAction,
    input: { sourceSystem: string; externalId: string; clientScenarioSlug: string; reason?: string },
  ) => Promise<ActivationView>;
  onGetActivationHistory: (sourceSystem: string, externalId: string) => Promise<ActivationHistoryEvent[]>;
  onGetEquipmentRecommendations: (
    sourceSystem: string, externalId: string,
  ) => Promise<{ equipmentClassSlug: string | null; recommendations: EquipmentRecommendation[] }>;
  plants: Plant[];
  onGetEquipmentPlacementHistory: (sourceSystem: string, externalId: string) => Promise<EquipmentPlacementEvent[]>;
}

const BUCKET_STYLE: Record<EquipmentRecommendation['bucket'], string> = {
  availableNow: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
  availableLater: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
  notApplicable: 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300',
};

const BUCKET_LABEL: Record<EquipmentRecommendation['bucket'], string> = {
  availableNow: 'ready',
  availableLater: 'not yet',
  notApplicable: 'not applicable',
};

const reasonLabel: Record<string, string> = {
  unbound: 'Unbound',
  mapping_required: 'Mapping required',
  stale: 'Stale',
  no_readings: 'No readings',
};

const kpiReasonLabel: Record<string, string> = {
  unbound: 'Unbound',
  stale: 'Stale',
  no_readings: 'No readings',
  mapping_required: 'Mapping required',
  baseline_not_established: 'Baseline not established',
  insufficient_coverage: 'Insufficient coverage',
  undefined_result: 'Undefined result',
  parameter_not_set: 'Parameter not set',
  site_boundary_not_set: 'Site boundary not set',
};

/** `Blocker.code` is the only field every variant shares, so this is the generic
 *  fallback the few codes with extra detail (missing-signals, insufficient-history,
 *  tier-too-low) sit on top of — good enough for a badge, not a full explanation. */
function blockerLabel(blocker: ActivationView['blockersAtActivation'][number]): string {
  switch (blocker.code) {
    case 'missing-signals': return `Missing signals: ${blocker.signals.join(', ')}`;
    case 'insufficient-history': return `Needs ${blocker.needDays}d history, have ${blocker.haveDays}d`;
    case 'tier-too-low': return `Tier ${blocker.have} too low, needs tier ${blocker.needs}`;
    case 'unclassified': return 'Equipment not classified';
    case 'class-not-in-account': return 'Class not entitled to this account';
    case 'scenario-disabled': return 'Scenario disabled';
    case 'no-device': return 'No device fitted';
  }
}

export const EquipmentBindingsModal: React.FC<EquipmentBindingsModalProps> = ({
  isOpen, onClose, equipment, devices, devicesError,
  onClaimDevice, onUnclaimDevice, onGetCoverage, onGetDiscovery, onProposeOrActivateBinding,
  onListEquipmentKpis, onListMyCatalogScenarios, onListActivations, onActivationTransition,
  onGetActivationHistory, onGetEquipmentRecommendations, plants, onGetEquipmentPlacementHistory,
}) => {
  const navigate = useNavigate();
  const [coverage, setCoverage] = useState<CoverageResult | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [kpis, setKpis] = useState<KpiEnvelope[]>([]);
  const [scenarios, setScenarios] = useState<ClientScenario[]>([]);
  const [activations, setActivations] = useState<ActivationView[]>([]);
  const [recommendations, setRecommendations] = useState<EquipmentRecommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [claimImei, setClaimImei] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ActivationHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);
  const [placementsOpen, setPlacementsOpen] = useState(false);
  const [placements, setPlacements] = useState<EquipmentPlacementEvent[]>([]);
  const [placementsLoading, setPlacementsLoading] = useState(false);
  const [placementsError, setPlacementsError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isOpen || !equipment) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    (async () => {
      try {
        const [cov, disc, kpiList, scenarioList, activationList, recs] = await Promise.all([
          onGetCoverage(equipment.sourceSystem, equipment.externalId),
          onGetDiscovery(equipment.sourceSystem, equipment.externalId),
          onListEquipmentKpis(equipment.sourceSystem, equipment.externalId),
          onListMyCatalogScenarios(equipment.equipmentClassSlug ?? undefined),
          onListActivations(equipment.sourceSystem, equipment.externalId),
          onGetEquipmentRecommendations(equipment.sourceSystem, equipment.externalId),
        ]);
        if (!live) return;
        setCoverage(cov);
        setDiscovery(disc);
        setKpis(kpiList);
        setScenarios(scenarioList);
        setActivations(activationList);
        setRecommendations(recs.recommendations);
      } catch (err) {
        if (live) setError(err instanceof ApiError ? err.message : 'Could not load bindings.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, equipment?.sourceSystem, equipment?.externalId, equipment?.equipmentClassSlug]);

  useEffect(() => {
    setHistoryOpen(false);
    setHistory([]);
    setHistoryError(undefined);
    setPlacementsOpen(false);
    setPlacements([]);
    setPlacementsError(undefined);
  }, [isOpen, equipment?.sourceSystem, equipment?.externalId]);

  const plantName = useMemo(() => {
    const byId = new Map(plants.map((p) => [p.id, p.name]));
    return (plantId: string | null) => (plantId ? byId.get(plantId) ?? plantId : 'No site');
  }, [plants]);

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
    const [cov, disc, kpiList, activationList, recs] = await Promise.all([
      onGetCoverage(equipment.sourceSystem, equipment.externalId),
      onGetDiscovery(equipment.sourceSystem, equipment.externalId),
      onListEquipmentKpis(equipment.sourceSystem, equipment.externalId),
      onListActivations(equipment.sourceSystem, equipment.externalId),
      onGetEquipmentRecommendations(equipment.sourceSystem, equipment.externalId),
    ]);
    setCoverage(cov);
    setDiscovery(disc);
    setKpis(kpiList);
    setActivations(activationList);
    setRecommendations(recs.recommendations);
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

  // `pause` and `deactivate` require a reason on the backend; `propose`,
  // `activate` and `resume` don't ask for one.
  const handleActivation = async (action: ActivationAction, clientScenarioSlug: string) => {
    let reason: string | undefined;
    if (action === 'pause' || action === 'deactivate') {
      const verb = action === 'pause' ? 'paused' : 'deactivated';
      const entered = window.prompt(`Why is ${clientScenarioSlug} being ${verb} on ${equipment.name ?? equipment.externalId}?`);
      if (entered === null) return;
      reason = entered || undefined;
    }
    const key = `${action}-${clientScenarioSlug}`;
    setBusyKey(key);
    setError(undefined);
    try {
      await onActivationTransition(action, {
        sourceSystem: equipment.sourceSystem,
        externalId: equipment.externalId,
        clientScenarioSlug,
        reason,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${action} this scenario.`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleHistory = async () => {
    if (historyOpen) { setHistoryOpen(false); return; }
    setHistoryOpen(true);
    if (history.length || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      setHistory(await onGetActivationHistory(equipment.sourceSystem, equipment.externalId));
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : 'Could not load activation history.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleTogglePlacements = async () => {
    if (placementsOpen) { setPlacementsOpen(false); return; }
    setPlacementsOpen(true);
    if (placements.length || placementsLoading) return;
    setPlacementsLoading(true);
    setPlacementsError(undefined);
    try {
      setPlacements(await onGetEquipmentPlacementHistory(equipment.sourceSystem, equipment.externalId));
    } catch (err) {
      setPlacementsError(err instanceof ApiError ? err.message : 'Could not load placement history.');
    } finally {
      setPlacementsLoading(false);
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
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                onClose();
                navigate(`/admin/equipment/${encodeURIComponent(equipment.sourceSystem)}/${encodeURIComponent(equipment.externalId)}/page`);
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300 transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" /> View full page
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
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

              {/* Placement history */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-sky-600" /> Site
                  </h4>
                  <button
                    onClick={handleTogglePlacements}
                    className="text-[11px] font-medium text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <span>{plantName(equipment.plantId)}</span>
                    <span className="text-slate-300 dark:text-slate-600">·</span>
                    <span>History</span>
                    {placementsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </div>

                {placementsOpen && (
                  <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/40 p-2.5 space-y-1.5 max-h-48 overflow-y-auto">
                    {placementsLoading && <p className="text-[11px] text-slate-400">Loading…</p>}
                    {placementsError && <p className="text-[11px] text-rose-600 dark:text-rose-400">{placementsError}</p>}
                    {!placementsLoading && !placementsError && placements.length === 0 && (
                      <p className="text-[11px] text-slate-400">No placement history for this asset yet.</p>
                    )}
                    {placements.map((p) => (
                      <div key={p.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-start justify-between gap-2">
                        <span>
                          {plantName(p.fromPlantId)} → {plantName(p.toPlantId)}
                          {p.reason ? `: "${p.reason}"` : ''}
                        </span>
                        <span className="text-slate-400 shrink-0">{new Date(p.at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
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

              {/* Scenarios */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-sky-600" /> Scenarios
                  </h4>
                  <button
                    onClick={handleToggleHistory}
                    className="text-[11px] font-medium text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <History className="w-3.5 h-3.5" />
                    <span>History</span>
                    {historyOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </div>

                {historyOpen && (
                  <div className="mb-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/40 p-2.5 space-y-1.5 max-h-48 overflow-y-auto">
                    {historyLoading && <p className="text-[11px] text-slate-400">Loading…</p>}
                    {historyError && <p className="text-[11px] text-rose-600 dark:text-rose-400">{historyError}</p>}
                    {!historyLoading && !historyError && history.length === 0 && (
                      <p className="text-[11px] text-slate-400">No activation history for this asset yet.</p>
                    )}
                    {history.map((h) => (
                      <div key={h.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex items-start justify-between gap-2">
                        <span>
                          <span className="font-medium text-slate-800 dark:text-slate-100">{h.clientScenarioSlug}</span>
                          {' — '}
                          {h.action}
                          {h.fromState ? ` (${h.fromState} → ${h.toState})` : ` (→ ${h.toState})`}
                          {h.reason ? `: "${h.reason}"` : ''}
                        </span>
                        <span className="text-slate-400 shrink-0">{new Date(h.at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}

                {scenarios.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    {equipment.equipmentClassSlug ? 'No scenarios adopted for this class.' : 'Not classified — no scenarios to activate.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {scenarios.map((s) => {
                      const activation = activations.find((a) => a.clientScenarioSlug === s.slug);
                      const state = activation?.state;
                      const recommendation = recommendations.find((r) => r.scenarioSlug === s.slug);
                      return (
                        <li key={s.slug} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-xs space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {!state && recommendation && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${BUCKET_STYLE[recommendation.bucket]}`}>
                                  {BUCKET_LABEL[recommendation.bucket]}
                                </span>
                              )}
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  state === 'active'
                                    ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                                    : state === 'paused'
                                      ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                                      : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300'
                                }`}
                              >
                                {state ?? 'not requested'}
                              </span>
                            </div>
                          </div>
                          {!!activation?.blockersAtActivation.length && (
                            <ul className="space-y-0.5">
                              {activation.blockersAtActivation.map((b, i) => (
                                <li key={i} className="text-[11px] text-amber-700 dark:text-amber-400">{blockerLabel(b)}</li>
                              ))}
                            </ul>
                          )}
                          {!state && !!recommendation?.blockedBy.length && (
                            <ul className="space-y-0.5">
                              {recommendation.blockedBy.map((b, i) => (
                                <li key={i} className="text-[11px] text-amber-700 dark:text-amber-400">{blockerLabel(b)}</li>
                              ))}
                            </ul>
                          )}
                          <div className="flex items-center gap-1.5">
                            {!state && (
                              <button
                                onClick={() => handleActivation('propose', s.slug)}
                                disabled={busyKey === `propose-${s.slug}`}
                                className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-sky-300 hover:text-sky-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busyKey === `propose-${s.slug}` ? 'Proposing…' : 'Propose'}
                              </button>
                            )}
                            {(!state || state === 'proposed' || state === 'deactivated') && (
                              <button
                                onClick={() => handleActivation('activate', s.slug)}
                                disabled={busyKey === `activate-${s.slug}`}
                                className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busyKey === `activate-${s.slug}` ? 'Activating…' : 'Activate'}
                              </button>
                            )}
                            {state === 'active' && (
                              <button
                                onClick={() => handleActivation('pause', s.slug)}
                                disabled={busyKey === `pause-${s.slug}`}
                                className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-amber-300 hover:text-amber-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busyKey === `pause-${s.slug}` ? 'Pausing…' : 'Pause'}
                              </button>
                            )}
                            {state === 'paused' && (
                              <button
                                onClick={() => handleActivation('resume', s.slug)}
                                disabled={busyKey === `resume-${s.slug}`}
                                className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busyKey === `resume-${s.slug}` ? 'Resuming…' : 'Resume'}
                              </button>
                            )}
                            {(state === 'active' || state === 'paused') && (
                              <button
                                onClick={() => handleActivation('deactivate', s.slug)}
                                disabled={busyKey === `deactivate-${s.slug}`}
                                className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:text-rose-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busyKey === `deactivate-${s.slug}` ? 'Deactivating…' : 'Deactivate'}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* KPIs */}
              <div>
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5 text-sky-600" /> KPIs
                </h4>
                {kpis.length === 0 ? (
                  <p className="text-xs text-slate-400">No KPIs declared for this equipment's class.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {kpis.map((k) => {
                      const seriesPoint = Array.isArray(k.value) ? k.value.at(-1) ?? null : null;
                      const display = Array.isArray(k.value) ? seriesPoint?.v ?? null : k.value;
                      return (
                        <li key={k.formulaKey} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-xs">
                          <span className="font-mono text-slate-700 dark:text-slate-200">{k.formulaKey}</span>
                          {k.readiness === 'ready' ? (
                            <span className="font-semibold text-slate-800 dark:text-slate-100">
                              {display ?? '—'} {k.unit}
                            </span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-300 font-medium">
                              {k.reason ? kpiReasonLabel[k.reason] ?? k.reason : k.readiness}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
