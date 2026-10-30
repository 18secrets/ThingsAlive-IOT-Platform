import React, { useEffect, useMemo, useState } from 'react';
import { Search, AlertCircle, Unplug, Info, Activity } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';
import { ApiError, DeviceHealthWindow, DeviceLinkState, EquipmentProfile, MyDevice, apiGetDeviceHealth } from '../../lib/api';
import { Chip } from '../common/Chip';
import { Modal } from '../common/Modal';
import { ExportCsvButton } from '../common/ExportCsvButton';
import { sortRows, useSort } from '../../lib/useSort';

const STATE_VALUES: MyDevice['state'][] = ['in-stock', 'assigned', 'retired'];

const STATE_STYLE: Record<MyDevice['state'], string> = {
  'in-stock': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  assigned: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};

interface ClientDeviceManagementProps {
  devices: MyDevice[];
  error?: string;
  /** True until the first answer: the list is unknown then, not empty. */
  loading?: boolean;
  equipment: EquipmentProfile[];
  onUnclaimDevice: (imei: string, reason?: string) => Promise<MyDevice>;
}

export const ClientDeviceManagement: React.FC<ClientDeviceManagementProps> = ({
  devices, error, loading, equipment, onUnclaimDevice,
}) => {
  const { t } = useTranslation('equipment');
  const [viewMode, setViewMode] = useViewMode('client-devices');
  const stateOptions = STATE_VALUES.map((value) => ({ label: t(`deviceState.${value}`), value }));
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
    const reason = window.prompt(t('bindings.unfitPrompt', { imei: d.imei, name: equipmentName(d.equipmentExternalId) ?? t('devices.itsMachine') }));
    if (reason === null) return;
    setBusyImei(d.imei);
    setActionError(undefined);
    try {
      await onUnclaimDevice(d.imei, reason || undefined);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('bindings.unfitFailed'));
    } finally {
      setBusyImei(null);
    }
  };

  // Sortable headers (test report MAJ-9): the whole filtered set is sorted, then paged.
  const { sort, toggle } = useSort<'imei' | 'model' | 'state' | 'fitted'>({ key: 'imei', dir: 'asc' });
  const sorted = useMemo(() => sortRows(filtered, sort, {
    imei: (d) => d.imei,
    model: (d) => d.model,
    state: (d) => d.state,
    fitted: (d) => equipmentName(d.equipmentExternalId),
  }), [filtered, sort, equipmentName]);
  const { pageItems: pagedRows, ...pager } = usePagination(sorted);

  // One definition for both views (cards or list on every list page).
  const viewColumns = [
    { label: 'IMEI', sortKey: 'imei' }, { label: t('devices.col.model'), sortKey: 'model' }, { label: t('devices.col.state'), sortKey: 'state' },
    { label: t('devices.col.fittedTo'), sortKey: 'fitted' }, { label: t('devices.col.action') },
  ];
  const viewCells = (d: (typeof pagedRows)[number]) => [
    <span className="font-mono text-[11px]">{d.imei}</span>,
    <span className="text-slate-600 dark:text-slate-400">{d.model || '—'}</span>,
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATE_STYLE[d.state]}`}>
      {t(`deviceState.${d.state}`, { defaultValue: d.state })}
    </span>,
    <span className="text-slate-600 dark:text-slate-400">
      {equipmentName(d.equipmentExternalId) || <span className="text-slate-400 italic">{t('devices.notFitted')}</span>}
    </span>,
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => setHealthOf(d)}
        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
        title={t('devices.healthTooltip')}
      >
        <Activity className="w-3.5 h-3.5" />
      </button>
      {d.state === 'assigned' && d.equipmentExternalId && (
        <button
          onClick={() => handleUnclaim(d)}
          disabled={busyImei === d.imei}
          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-50"
          title={t('bindings.takeOff')}
        >
          <Unplug className="w-3.5 h-3.5" />
        </button>
      )}
    </div>,
  ];

  return (
    <div id="client-device-management-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('devices.searchPlaceholder')}
              size="sm"
              className="w-full pl-9! pr-4"
            />
          </div>
          <SelectPicker
            data={stateOptions}
            value={selectedState === 'All' ? null : selectedState}
            onChange={(value) => setSelectedState(value ?? 'All')}
            placeholder={t('devices.allStates')}
            searchable={false}
            cleanable={selectedState !== 'All'}
            size="sm"
          />
        </div>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <ExportCsvButton
          name="devices"
          disabled={!filtered.length}
          headers={['IMEI', t('devices.col.model'), t('devices.col.state'), t('devices.col.fittedTo')]}
          rows={() => sorted.map((d) => [d.imei, d.model, t(`deviceState.${d.state}`), equipmentName(d.equipmentExternalId)])}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span>{t('devices.info')}</span>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error ?? actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-slate-400 text-sm">{loading ? t('common.loading') : t('devices.empty')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare sort={sort} onSort={(key) => { toggle(key as typeof sort.key); pager.setPage(1); }} columns={viewColumns} rows={pagedRows} rowKey={(d) => d.imei} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedRows} rowKey={(d) => d.imei} cells={viewCells} actionsIndex={4} /></div>
        )}

        <TablePagination pinToBottom loading={loading} {...pager} />
      </div>

      <Modal
        isOpen={!!healthOf}
        onClose={() => setHealthOf(null)}
        title={t('devices.health')}
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

const minutes = (seconds: number | null, t: TFunction) => (seconds == null ? null : t('devices.minutes', { count: Math.round(seconds / 60) }));

/** The newest windows first (the backend returns up to 50), each with what made it
 *  that state — the per-logger version of the fleet's online/offline filter. */
const DeviceHealth: React.FC<{ imei: string }> = ({ imei }) => {
  const { t } = useTranslation('equipment');
  const [windows, setWindows] = useState<DeviceHealthWindow[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetDeviceHealth(imei)
      .then((w) => { if (live) setWindows(w); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('devices.healthFailed')); });
    return () => { live = false; };
  }, [imei]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!windows) return <p className="text-sm text-slate-500">{t('common.loading')}</p>;
  if (windows.length === 0) {
    return <p className="text-sm text-slate-400">{t('devices.noHealth')}</p>;
  }

  return (
    <ol className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
      {windows.map((w) => (
        <li key={w.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-600 dark:text-slate-300">
              {/* The end's date too when the window crosses midnight (test report COS-4). */}
              {new Date(w.windowStart).toLocaleString()} – {new Date(w.windowStart).toDateString() === new Date(w.windowEnd).toDateString()
                ? new Date(w.windowEnd).toLocaleTimeString() : new Date(w.windowEnd).toLocaleString()}
            </span>
            <Chip tone={HEALTH_TONE[w.state] ?? 'slate'}>{t(`linkState.${w.state}`, { defaultValue: w.state })}</Chip>
          </div>
          <p className="text-slate-500 dark:text-slate-400">{w.detail}</p>
          <p className="text-[11px] text-slate-400">
            {t('devices.samples', { count: w.samples })}
            {w.signalBand ? ` · ${t('devices.signal', { band: w.signalBand })}` : ''}
            {minutes(w.longestGapSeconds, t) ? ` · ${t('devices.longestGap', { value: minutes(w.longestGapSeconds, t) })}` : ''}
            {minutes(w.medianLagSeconds, t) ? ` · ${t('devices.medianLag', { value: minutes(w.medianLagSeconds, t) })}` : ''}
          </p>
          {w.missingSignals.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('devices.missing', { list: w.missingSignals.join(', ') })}</p>
          )}
        </li>
      ))}
    </ol>
  );
};
