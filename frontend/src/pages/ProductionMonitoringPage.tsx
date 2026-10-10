import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronLeft, ChevronRight, Clock3, Info } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RingGauge } from '../components/common/RingGauge';
import { Chip } from '../components/common/Chip';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentConnection, EquipmentFilters } from '../components/common/EquipmentFilters';
import {
  ApiError, EquipmentProfile, FleetAvailability, FleetLinkRow, Plant,
  apiGetDeviceHealthFleet, apiGetFleetAvailability, apiListEquipment, apiListPlants,
} from '../lib/api';

const PAGE_SIZE = 12;
const DAYS = 7;

function periodLastNDays(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export const ProductionMonitoringPage: React.FC = () => {
  usePageHeader({ title: 'Production Monitoring', subtitle: 'Availability & Utilization' });
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [availability, setAvailability] = useState<FleetAvailability | null>(null);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');

  useEffect(() => {
    let live = true;
    const { from, to } = periodLastNDays(DAYS);
    apiListEquipment().then((e) => { if (live) setEquipment(e); }).catch(() => {});
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetDeviceHealthFleet({ days: DAYS }).then((rows) => { if (live) setLinkHealth(rows); }).catch(() => {});
    apiGetFleetAvailability(from, to)
      .then((a) => { if (live) { setAvailability(a); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load availability.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const name = (sourceSystem: string, externalId: string) => profileOf(sourceSystem, externalId)?.name ?? externalId;
  /** `dark` is offline; any other recorded link state is reporting, so online.
   *  A machine with no device-health row at all matches neither filter value. */
  const connectionOf = (externalId: string): EquipmentConnection | null => {
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

  const machines = useMemo(() => {
    const all = availability?.machines ?? [];
    const term = scope.query.trim().toLowerCase();
    return all.filter((m) => {
      const profile = profileOf(m.sourceSystem, m.externalId);
      const key = `${m.sourceSystem}|${m.externalId}`;
      const matchesSelected = selectedKey === 'all' || key === selectedKey;
      const matchesPlant = scope.plantId === 'all' || profile?.plantId === scope.plantId;
      const matchesClass = scope.classSlug === 'all' || profile?.equipmentClassSlug === scope.classSlug;
      const matchesConnection = scope.connection === 'all' || connectionOf(m.externalId) === scope.connection;
      const matchesQuery = !term
        || name(m.sourceSystem, m.externalId).toLowerCase().includes(term)
        || m.externalId.toLowerCase().includes(term);
      return matchesSelected && matchesPlant && matchesClass && matchesConnection && matchesQuery;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, equipment, linkHealth, scope, selectedKey]);

  const pageCount = Math.max(1, Math.ceil(machines.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = machines.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  return (
    <div id="production-monitoring-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Last {DAYS} days</span>
          <span title="Availability is uptime against scheduled shift hours — not OEE, which also needs a performance and quality figure this platform does not compute.">
            <Info className="w-4 h-4 text-sky-200" />
          </span>
        </div>
        <h2 className="text-xl font-bold">Production Monitoring &amp; Availability</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <EquipmentFilters
        scope={scope}
        onChange={(next) => { setScope(next); setPage(1); }}
        plants={plants}
        classes={equipmentClasses}
        equipmentOptions={equipmentOptions}
        selectedKey={selectedKey}
        onSelect={(key) => { setSelectedKey(key); setPage(1); }}
      />

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiTile label="Machines measured" value={String(availability?.machinesMeasured ?? 0)} />
            <KpiTile label="Fleet availability" value={availability?.availability != null ? `${availability.availability.toFixed(0)}%` : '—'} />
            <KpiTile label="Uptime" value={availability?.uptimeHours != null ? `${availability.uptimeHours.toFixed(0)}h` : '—'} />
            <KpiTile label="Downtime" value={availability?.downtimeHours != null ? `${availability.downtimeHours.toFixed(0)}h` : '—'} tone="warn" />
          </div>
          {(availability?.excluded.noShiftSchedule || availability?.excluded.noReadings) ? (
            <p className="text-xs text-slate-400">
              Excluded from the totals above: {availability.excluded.noShiftSchedule} with no shift schedule, {availability.excluded.noReadings} with no readings.
            </p>
          ) : null}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-900 dark:text-white text-base">Machines</h3>
              <span className="text-sm text-slate-400 dark:text-slate-500">{machines.length} machines</span>
            </div>

            {pageItems.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
                No machines to show.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pageItems.map((m) => (
                  <ProductionCard
                    key={`${m.sourceSystem}/${m.externalId}`}
                    machine={m}
                    name={name(m.sourceSystem, m.externalId)}
                    onOpen={() => navigate(`/production-monitoring/${encodeURIComponent(m.sourceSystem)}/${encodeURIComponent(m.externalId)}`)}
                  />
                ))}
              </div>
            )}

            <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400 mt-4">
              <span>Page {pageSafe} of {pageCount}</span>
              <div className="flex items-center gap-2">
                <button disabled={pageSafe <= 1} onClick={() => setPage((p) => p - 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer">
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <button disabled={pageSafe >= pageCount} onClick={() => setPage((p) => p + 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer">
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'warn' }> = ({ label, value, tone }) => (
  <div className={`border rounded-xl p-4 shadow-xs ${tone === 'warn' ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'}`}>
    <div className={`text-2xl font-bold ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
    <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
  </div>
);

const READINESS_STYLE = {
  ready: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-white dark:bg-slate-900', gauge: 'text-sky-500 dark:text-sky-400' },
  not_configured: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-800/20', gauge: 'text-slate-400' },
  not_available: { ring: 'border-slate-200 dark:border-slate-800', bg: 'bg-slate-50/60 dark:bg-slate-800/20', gauge: 'text-slate-400' },
} as const;

const REASON_TEXT: Record<string, string> = {
  no_shift_schedule: 'No shift schedule configured',
  no_readings: 'No readings in this period',
};

const ProductionCard: React.FC<{ machine: FleetAvailability['machines'][number]; name: string; onOpen: () => void }> = ({ machine, name, onOpen }) => {
  const style = READINESS_STYLE[machine.readiness];
  const gaugeValue = machine.readiness === 'ready' ? machine.availability : null;
  return (
    <button onClick={onOpen} className={`text-left w-full border ${style.ring} ${style.bg} rounded-xl p-4 shadow-xs space-y-3 hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-center gap-3">
        <RingGauge value={gaugeValue} size={60} colorClass={style.gauge} />
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate" title={name}>{name}</h4>
          <p className="text-sm text-slate-400 dark:text-slate-500 truncate">{machine.sourceSystem}/{machine.externalId}</p>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
        {machine.readiness === 'ready' ? (
          <div className="flex items-center gap-1.5">
            <Chip icon={Clock3} title="Uptime hours" size="md">{(machine.uptimeHours ?? 0).toFixed(0)}h up</Chip>
            <Chip tone={(machine.downtimeHours ?? 0) > 0 ? 'amber' : 'slate'} title="Downtime hours" size="md">{(machine.downtimeHours ?? 0).toFixed(0)}h down</Chip>
          </div>
        ) : (
          <span className="text-xs text-slate-400">{machine.reason ? REASON_TEXT[machine.reason] : 'Not available'}</span>
        )}
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 group-hover:gap-1.5 transition-all">
          Details <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </button>
  );
};
