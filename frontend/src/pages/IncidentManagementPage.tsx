import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Clock3, Info, Settings2, Siren, UserRound } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import { Chip } from '../components/common/Chip';
import { StatusTone, statusTone, severityTone } from '../components/common/statusTone';
import { ListTable } from '../components/common/ListTable';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import { Modal } from '../components/common/Modal';
import {
  ApiError, EquipmentProfile, INCIDENT_SEVERITIES, IncidentDetail, IncidentMachineView,
  IncidentRecord, IncidentSeverity, IncidentSlaPolicy, IncidentStatus, Plant, SlaState, WorkOrderPriority,
  apiAcknowledgeIncident, apiAssignIncident, apiDeleteIncidentSlaPolicy, apiGetIncident, apiListEquipment,
  apiListIncidentRecords, apiListIncidentSlaPolicies, apiListIncidentView, apiListPlants, apiListWorkOrderPeople,
  apiRaiseIncidentWorkOrder, apiResolveIncident, apiSetIncidentSlaPolicy,
} from '../lib/api';

/**
 * Incident Management on the incident entity (3d83cec): one live incident per machine,
 * opened by the first alert the evaluator fires and gathering the rest, owned,
 * acknowledged and resolved here, timed against the account's per-severity response
 * times. Replaces the browser-local mock; ThingsShield links here rather than keeping
 * a copy of its own.
 */

const SEVERITY_TONE = (s: string) => severityTone(s);
const STATUS_TONE: Record<IncidentStatus, StatusTone> = { open: statusTone('open'), acknowledged: statusTone('acknowledged'), resolved: statusTone('resolved') };
const SLA_TONE: Record<SlaState, 'slate' | 'sky' | 'emerald' | 'rose'> = { no_policy: 'slate', on_track: 'sky', met: 'emerald', breached: 'rose' };
// Status, SLA-state, event, severity and priority labels are key maps in incidents.json
// (status.*, sla.*, event.*, severity.*, priority.*), so logic keeps the raw values.
const PRIORITIES: WorkOrderPriority[] = ['low', 'normal', 'high', 'urgent'];

type StatusFilter = 'live' | IncidentStatus;

export const IncidentManagementPage: React.FC = () => {
  const { t } = useTranslation('incidents');
  const [viewMode, setViewMode] = useViewMode('incident-management');
  usePageHeader({ title: t('page.title'), subtitle: t('page.subtitle') });
  const [records, setRecords] = useState<IncidentRecord[]>([]);
  const [view, setView] = useState<IncidentMachineView[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('live');
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);

  const loadRecords = (status: StatusFilter) => apiListIncidentRecords({ status })
    .then((r) => { setRecords(r); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('page.loadFailed')));

  useEffect(() => {
    let live = true;
    apiListEquipment().then((e) => { if (live) setEquipment(e); }).catch(() => {});
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    // People for owner names and the assign picker; a role without action.work gets a
    // refusal here and simply sees ids-free "Unassigned / a user" text.
    apiListWorkOrderPeople().then((p) => { if (live) setPeople(p); }).catch(() => {});
    apiListIncidentView().then((v) => { if (live) setView(v.incidents); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    setLoading(true);
    loadRecords(statusFilter).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const machineName = (m: { sourceSystem: string; externalId: string }) => profileOf(m.sourceSystem, m.externalId)?.name ?? m.externalId;
  const personName = (id: string | null) => (id ? people.find((p) => p.id === id)?.fullName ?? t('page.aUser') : null);

  const classes = useMemo(
    () => [...new Set(equipment.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))].sort(),
    [equipment],
  );
  const equipmentOptions = useMemo(
    () => equipment.map((e) => ({ sourceSystem: e.sourceSystem, externalId: e.externalId, label: `${e.name ?? e.externalId} (${e.externalId})` })),
    [equipment],
  );

  const inScope = (m: { sourceSystem: string; externalId: string }) => {
    const profile = profileOf(m.sourceSystem, m.externalId);
    const term = scope.query.trim().toLowerCase();
    return (selectedKey === 'all' || `${m.sourceSystem}|${m.externalId}` === selectedKey)
      && (scope.plantId === 'all' || profile?.plantId === scope.plantId)
      && (scope.classSlug === 'all' || profile?.equipmentClassSlug === scope.classSlug)
      && (!term || machineName(m).toLowerCase().includes(term) || m.externalId.toLowerCase().includes(term));
  };

  const visible = useMemo(
    () => records.filter((r) => inScope(r.machine)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, equipment, scope, selectedKey],
  );
  // Machines with open alerts that no incident gathered (alerts raised outside the
  // evaluator). Shown so they are not invisible just because they have no record.
  const unrecorded = useMemo(
    () => view.filter((v) => v.incident === null && inScope(v.machine)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, equipment, scope, selectedKey],
  );

  const tiles = {
    open: visible.filter((r) => r.status === 'open').length,
    acknowledged: visible.filter((r) => r.status === 'acknowledged').length,
    critical: visible.filter((r) => r.severity === 'critical' && r.status !== 'resolved').length,
    breached: visible.filter((r) => r.sla.acknowledge.state === 'breached' || r.sla.resolve.state === 'breached').length,
  };

  return (
    <div id="incident-management-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('page.eyebrow')}</span>
            <span title={t('page.info')}>
              <Info className="w-4 h-4 text-sky-200" />
            </span>
          </div>
          <h2 className="text-xl font-bold">{t('page.heading')}</h2>
        </div>
        <button
          onClick={() => setPoliciesOpen(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-white text-sky-700 hover:bg-sky-50 shrink-0 cursor-pointer"
        >
          <Settings2 className="w-4 h-4" /> {t('sla.title')}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <EquipmentFilters
        showConnection={false}
          scope={scope}
          onChange={setScope}
          plants={plants}
          classes={classes}
          equipmentOptions={equipmentOptions}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
        <SelectPicker
          data={[
            { label: t('filter.live'), value: 'live' },
            { label: t('status.open'), value: 'open' },
            { label: t('status.acknowledged'), value: 'acknowledged' },
            { label: t('status.resolved'), value: 'resolved' },
          ]}
          value={statusFilter}
          onChange={(value) => setStatusFilter((value ?? 'live') as StatusFilter)}
          searchable={false}
          cleanable={false}
          className="min-w-[220px]"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label={t('tiles.open')} value={tiles.open} tone="bad" loading={loading} />
        <KpiTile label={t('status.acknowledged')} value={tiles.acknowledged} tone="warn" loading={loading} />
        <KpiTile label={t('tiles.critical')} value={tiles.critical} tone="bad" loading={loading} />
        <KpiTile label={t('tiles.breached')} value={tiles.breached} tone="warn" loading={loading} />
      </div>

      <div className="flex justify-end">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">{t('page.loading')}</p>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
          <Siren className="w-6 h-6" />
          {t('page.empty')}
        </div>
      ) : viewMode === 'list' ? (
        <ListTable
          columns={[
            { label: t('listCol.machine') }, { label: t('listCol.severity') }, { label: t('listCol.status') },
            { label: t('listCol.owner') }, { label: t('listCol.ack') }, { label: t('listCol.resolve') }, { label: t('listCol.opened') },
          ]}
          rows={visible}
          rowKey={(r) => r.id}
          cells={(r) => [
            <span className="font-medium">{machineName(r.machine)}</span>,
            <Chip tone={SEVERITY_TONE(r.severity)}>{t(`severity.${r.severity}`, { defaultValue: r.severity })}</Chip>,
            <Chip tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Chip>,
            <span>
              {personName(r.ownerUserId) ?? <span className="text-slate-400">{t('page.unassigned')}</span>}
              {r.escalationLevel > 0 && <span className="text-rose-500 font-semibold"> · {t('page.escalated', { level: r.escalationLevel })}</span>}
            </span>,
            <Chip tone={SLA_TONE[r.sla.acknowledge.state]}>{t(`sla.state.${r.sla.acknowledge.state}`)}</Chip>,
            <Chip tone={SLA_TONE[r.sla.resolve.state]}>{t(`sla.state.${r.sla.resolve.state}`)}</Chip>,
            <span className="text-slate-500 whitespace-nowrap">{new Date(r.openedAt).toLocaleString()}</span>,
          ]}
          onOpen={(r) => setOpenId(r.id)}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((r) => (
            <button
              key={r.id}
              onClick={() => setOpenId(r.id)}
              className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 hover:border-sky-300 cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2">
                <Chip tone={SEVERITY_TONE(r.severity)}>{t(`severity.${r.severity}`, { defaultValue: r.severity })}</Chip>
                <Chip tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Chip>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base truncate">{machineName(r.machine)}</h4>
              <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <UserRound className="w-3.5 h-3.5" />{personName(r.ownerUserId) ?? t('page.unassigned')}
                {r.escalationLevel > 0 && <span className="text-rose-500 font-semibold"> · {t('page.escalated', { level: r.escalationLevel })}</span>}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                <Chip tone={SLA_TONE[r.sla.acknowledge.state]} title={r.sla.acknowledge.dueAt ? t('sla.ackBy', { date: new Date(r.sla.acknowledge.dueAt).toLocaleString() }) : t('sla.noPolicy')}>
                  {t('sla.ackChip', { state: t(`sla.state.${r.sla.acknowledge.state}`) })}
                </Chip>
                <Chip tone={SLA_TONE[r.sla.resolve.state]} title={r.sla.resolve.dueAt ? t('sla.resolveBy', { date: new Date(r.sla.resolve.dueAt).toLocaleString() }) : t('sla.noPolicy')}>
                  {t('sla.resolveChip', { state: t(`sla.state.${r.sla.resolve.state}`) })}
                </Chip>
              </div>
              <small className="flex items-center gap-1 text-xs text-slate-400"><Clock3 className="w-3.5 h-3.5" />{t('page.openedAt', { date: new Date(r.openedAt).toLocaleString() })}</small>
            </button>
          ))}
        </div>
      )}

      {unrecorded.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('unrecorded.title')}</p>
          <p className="text-[11px] text-slate-400">{t('unrecorded.note')}</p>
          {unrecorded.map((v) => (
            <div key={`${v.machine.sourceSystem}/${v.machine.externalId}`} className="flex items-center justify-between gap-2 text-xs border-t border-slate-100 dark:border-slate-800 pt-2">
              <span className="text-slate-700 dark:text-slate-200">{v.machine.name ?? v.machine.externalId}</span>
              <span className="flex items-center gap-1.5">
                <Chip tone={SEVERITY_TONE(v.worstSeverity)}>{t(`severity.${v.worstSeverity}`, { defaultValue: v.worstSeverity })}</Chip>
                <span className="text-slate-400">{t('unrecorded.openAlerts', { count: v.openAlerts.length })}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={!!openId} onClose={() => setOpenId(null)} title={t('panel.title')} subtitle={openId ? machineName(records.find((r) => r.id === openId)?.machine ?? { sourceSystem: '', externalId: '' }) : undefined} maxWidth="max-w-2xl">
        {openId && (
          <IncidentPanel
            key={openId}
            id={openId}
            people={people}
            personName={personName}
            onChanged={() => loadRecords(statusFilter)}
          />
        )}
      </Modal>

      <Modal isOpen={policiesOpen} onClose={() => setPoliciesOpen(false)} title={t('sla.title')} subtitle={t('sla.subtitle')} maxWidth="max-w-xl">
        {policiesOpen && <SlaPolicies />}
      </Modal>
    </div>
  );
};

// A 0 before the first answer reads as "no incidents" — the dash says "not known yet".
const KpiTile: React.FC<{ label: string; value: number; tone?: 'warn' | 'bad'; loading?: boolean }> = ({ label, value, tone, loading }) => {
  const toneClass = tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="border rounded-xl p-4 shadow-xs bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800">
      <div className={`text-2xl font-bold ${toneClass}`}>{loading ? '…' : value}</div>
      <div className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};

const ACTION_BUTTON = 'px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer';

/** One incident: its alerts, the work raised on them, the timeline, and every action. */
const IncidentPanel: React.FC<{
  id: string;
  people: { id: string; fullName: string }[];
  personName: (id: string | null) => string | null;
  onChanged: () => void;
}> = ({ id, people, personName, onChanged }) => {
  const { t } = useTranslation('incidents');
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'resolve' | 'work'>('none');
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<WorkOrderPriority>('high');

  const load = () => apiGetIncident(id)
    .then((d) => { setDetail(d); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('panel.loadFailed')));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setMode('none');
      setNote('');
      setTitle('');
      await load();
      onChanged();
    } catch (err) {
      // e.g. resolving while a work order on its alerts is still open — the backend's reason says which.
      setError(err instanceof ApiError ? err.message : t('panel.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return error ? <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : <p className="text-sm text-slate-500">{t('page.loading')}</p>;

  const live = detail.status !== 'resolved';

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip tone={SEVERITY_TONE(detail.severity)}>{t(`severity.${detail.severity}`, { defaultValue: detail.severity })}</Chip>
        <Chip tone={STATUS_TONE[detail.status]}>{t(`status.${detail.status}`)}</Chip>
        <Chip tone={SLA_TONE[detail.sla.acknowledge.state]}>{t('sla.ackChip', { state: t(`sla.state.${detail.sla.acknowledge.state}`) })}</Chip>
        <Chip tone={SLA_TONE[detail.sla.resolve.state]}>{t('sla.resolveChip', { state: t(`sla.state.${detail.sla.resolve.state}`) })}</Chip>
        <span className="text-slate-500">{t('panel.owner', { name: personName(detail.ownerUserId) ?? t('page.unassigned') })}</span>
      </div>
      {detail.resolutionNote && <p className="text-slate-600 dark:text-slate-300">{t('panel.resolution', { note: detail.resolutionNote })}</p>}

      {error && (
        <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {live && (
        <div className="flex items-center gap-2 flex-wrap">
          {detail.status === 'open' && (
            <button disabled={busy} onClick={() => { if (window.confirm(t('panel.acknowledgeConfirm'))) run(() => apiAcknowledgeIncident(id)); }} className={ACTION_BUTTON}>{t('panel.acknowledge')}</button>
          )}
          <SelectPicker
            size="sm"
            data={[{ label: t('page.unassigned'), value: '__none__' }, ...people.map((p) => ({ label: p.fullName, value: p.id }))]}
            value={detail.ownerUserId ?? '__none__'}
            onChange={(value) => run(() => apiAssignIncident(id, !value || value === '__none__' ? null : value))}
            searchable={people.length > 8}
            cleanable={false}
            disabled={busy}
            placeholder={t('panel.ownerPlaceholder')}
            className="min-w-[180px]"
          />
          <button disabled={busy} onClick={() => setMode(mode === 'work' ? 'none' : 'work')} className={ACTION_BUTTON}>{t('panel.raiseWorkOrder')}</button>
          <button disabled={busy} onClick={() => setMode(mode === 'resolve' ? 'none' : 'resolve')} className={ACTION_BUTTON}>{t('panel.resolve')}</button>
        </div>
      )}

      {mode === 'resolve' && (
        <div className="space-y-2 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
          <span className="text-slate-600 dark:text-slate-300 font-medium">{t('panel.whatWasDone')}</span>
          <Input as="textarea" rows={2} value={note} onChange={(v) => setNote(v)} />
          <button disabled={busy || !note.trim()} onClick={() => run(() => apiResolveIncident(id, note.trim()))} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer">
            {t('panel.resolveIncident')}
          </button>
        </div>
      )}

      {mode === 'work' && (
        <div className="space-y-2 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
          <span className="text-slate-600 dark:text-slate-300 font-medium">{t('panel.workOrderNote')}</span>
          <Input value={title} onChange={(v) => setTitle(v)} placeholder={t('panel.workOrderPlaceholder')} />
          <div className="flex items-center gap-2">
            <SelectPicker size="sm" data={PRIORITIES.map((p) => ({ label: t(`priority.${p}`), value: p }))} value={priority} onChange={(v) => setPriority((v ?? 'high') as WorkOrderPriority)} searchable={false} cleanable={false} />
            <button disabled={busy || !title.trim()} onClick={() => run(() => apiRaiseIncidentWorkOrder(id, { title: title.trim(), priority }))} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer">
              {t('panel.raise')}
            </button>
          </div>
        </div>
      )}

      <section className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('panel.alerts', { count: detail.alerts.length })}</p>
        {detail.alerts.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg px-2.5 py-1.5">
            <span className="text-slate-700 dark:text-slate-200 truncate">{a.summary}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <Chip tone={SEVERITY_TONE((a.severity as IncidentSeverity)) ?? 'slate'}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip>
              <span className="text-slate-400">{t(`alertState.${a.state}`, { defaultValue: a.state })} · {new Date(a.firedAt).toLocaleString()}</span>
            </span>
          </div>
        ))}
      </section>

      <section className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('panel.workOrders', { count: detail.workOrders.length })}</p>
        {detail.workOrders.length === 0 && <p className="text-slate-400">{t('panel.noneRaised')}</p>}
        {detail.workOrders.map((w) => (
          <div key={w.id} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg px-2.5 py-1.5">
            <span className="text-slate-700 dark:text-slate-200 truncate">{w.title}</span>
            <span className="text-slate-400 shrink-0">{t(`workOrderStatus.${w.status}`, { defaultValue: w.status })} · {t(`priority.${w.priority}`, { defaultValue: w.priority })}{w.assignedToUserId ? ` · ${personName(w.assignedToUserId)}` : ''}</span>
          </div>
        ))}
      </section>

      <section className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('panel.timeline')}</p>
        <ol className="space-y-1">
          {detail.timeline.map((ev, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-300">
              <span>{t(`event.${ev.kind}`, { defaultValue: ev.kind })}{ev.actor && ev.actor !== 'system' ? ` · ${personName(ev.actor) ?? ev.actor}` : ''}</span>
              <span className="text-slate-400">{new Date(ev.at).toLocaleString()}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};

/** One row per severity. No row is "no clock", not a default — so clearing is explicit. */
const SlaPolicies: React.FC = () => {
  const { t } = useTranslation('incidents');
  const [policies, setPolicies] = useState<IncidentSlaPolicy[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { ack: number | null; resolve: number | null }>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<IncidentSeverity | null>(null);

  const load = () => apiListIncidentSlaPolicies()
    .then((p) => {
      setPolicies(p);
      setDrafts(Object.fromEntries(INCIDENT_SEVERITIES.map((s) => {
        const row = p.find((x) => x.severity === s);
        return [s, { ack: row?.ackWithinMinutes ?? null, resolve: row?.resolveWithinMinutes ?? null }];
      })));
    })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('sla.loadFailed')));

  useEffect(() => { load(); }, []);

  async function run(severity: IncidentSeverity, action: () => Promise<unknown>) {
    setBusy(severity);
    setError(undefined);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('sla.saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  if (!policies) return error ? <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : <p className="text-sm text-slate-500">{t('page.loading')}</p>;

  return (
    <div className="space-y-2 text-xs">
      {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="grid grid-cols-[90px_1fr_1fr_auto] gap-2 items-center text-[11px] font-semibold text-slate-400 uppercase">
        <span>{t('sla.severity')}</span><span>{t('sla.ackWithin')}</span><span>{t('sla.resolveWithin')}</span><span />
      </div>
      {INCIDENT_SEVERITIES.map((s) => {
        const d = drafts[s] ?? { ack: null, resolve: null };
        const saved = policies.find((p) => p.severity === s);
        const valid = (d.ack ?? 0) >= 1 && (d.resolve ?? 0) >= 1;
        return (
          <div key={s} className="grid grid-cols-[90px_1fr_1fr_auto] gap-2 items-center">
            <Chip tone={SEVERITY_TONE(s)}>{t(`severity.${s}`)}</Chip>
            <InputNumber size="sm" min={1} value={d.ack} placeholder={t('sla.state.no_policy')} onChange={(v) => setDrafts((p) => ({ ...p, [s]: { ...d, ack: v == null || v === '' ? null : Number(v) } }))} />
            <InputNumber size="sm" min={1} value={d.resolve} placeholder={t('sla.state.no_policy')} onChange={(v) => setDrafts((p) => ({ ...p, [s]: { ...d, resolve: v == null || v === '' ? null : Number(v) } }))} />
            <div className="flex items-center gap-1">
              <button
                disabled={!valid || busy === s}
                onClick={() => run(s, () => apiSetIncidentSlaPolicy(s, { ackWithinMinutes: d.ack!, resolveWithinMinutes: d.resolve! }))}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 cursor-pointer"
              >
                {t('sla.save')}
              </button>
              {saved && (
                <button
                  disabled={busy === s}
                  onClick={() => run(s, () => apiDeleteIncidentSlaPolicy(s))}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-40 cursor-pointer"
                  title={t('sla.clearTitle')}
                >
                  {t('sla.clear')}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-slate-400 pt-1">{t('sla.note')}</p>
    </div>
  );
};
