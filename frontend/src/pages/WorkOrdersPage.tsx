import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, ClipboardList, AlertCircle, Clock3, Wrench } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import { ConnectionBadge } from '../components/common/ConnectionBadge';
import { ListTable } from '../components/common/ListTable';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import { DEFAULT_EQUIPMENT_FILTER_SCOPE, EquipmentFilters } from '../components/common/EquipmentFilters';
import {
  ApiError, AssetForecast, EditWorkOrderInput, EquipmentProfile, FleetLinkRow, Plant, RaiseWorkOrderInput, ServiceStatus,
  WorkOrder, WorkOrderEvent, WorkOrderPriority, WorkOrderStatus, apiActOnWorkOrder, apiAssignWorkOrder, apiEditWorkOrder,
  apiGetDeviceHealthFleet, apiGetServiceForecast, apiGetWorkOrderHistory, apiListEquipment, apiListPlants,
  apiListWorkOrderPeople, apiListWorkOrders, apiRaiseWorkOrder,
} from '../lib/api';

const SERVICE_STATUS_TONE: Record<ServiceStatus, 'rose' | 'amber' | 'sky' | 'emerald'> = {
  overdue: 'rose', due: 'amber', approaching: 'sky', ok: 'emerald',
};

const STATUS_OPTIONS: WorkOrderStatus[] = ['created', 'in-progress', 'completed', 'cancelled'];
const STATUS_STYLE: Record<WorkOrderStatus, string> = {
  created: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  'in-progress': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  completed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  cancelled: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
};
const PRIORITY_OPTIONS: WorkOrderPriority[] = ['low', 'normal', 'high', 'urgent'];

export const WorkOrdersPage: React.FC = () => {
  const { t } = useTranslation('workOrders');
  const [viewMode, setViewMode] = useViewMode('work-orders');
  usePageHeader({ title: t('translation:pages.workOrders.title'), subtitle: t('translation:pages.workOrders.subtitle') });

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [linkHealth, setLinkHealth] = useState<FleetLinkRow[]>([]);
  const [serviceDue, setServiceDue] = useState<AssetForecast[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');
  const [scope, setScope] = useState(DEFAULT_EQUIPMENT_FILTER_SCOPE);
  const [selectedKey, setSelectedKey] = useState('all');
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<{ equipmentKey: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  const [editing, setEditing] = useState<WorkOrder | null>(null);
  const [assigning, setAssigning] = useState<WorkOrder | null>(null);
  const [historyOf, setHistoryOf] = useState<WorkOrder | null>(null);

  const refresh = async () => {
    try {
      setOrders(await apiListWorkOrders());
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.load'));
    }
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Independent, not Promise.all — equipment still populates the create form
    // even if listing work orders itself fails (and vice versa).
    apiListEquipment().then((e) => { if (live) setEquipment(e); }).catch(() => {});
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiGetDeviceHealthFleet().then((rows) => { if (live) setLinkHealth(rows); }).catch(() => {});
    apiGetServiceForecast().then((r) => { if (live) setServiceDue(r.assets); }).catch(() => {});
    apiListWorkOrderPeople().then((p) => { if (live) setPeople(p); }).catch(() => {});
    apiListWorkOrders()
      .then((o) => { if (live) { setOrders(o); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.load')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // Names for ids. Somebody no longer active (suspended, or never joined) still shows
  // up in old history, so an unknown id reads as "someone else" rather than a raw uuid.
  const personName = (userId: string | null) =>
    userId ? people.find((p) => p.id === userId)?.fullName ?? t('people.someoneElse') : t('people.nobody');

  const profileOf = (sourceSystem: string, externalId: string) =>
    equipment.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId);
  const equipmentName = (sourceSystem: string, externalId: string) => profileOf(sourceSystem, externalId)?.name ?? externalId;
  const connectionOf = (externalId: string): 'online' | 'offline' | null => {
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

  // Ok and incomplete (no status at all — missing an interval, a meter, or a rate)
  // forecasts aren't worth a fitter's attention here; only the three that call for
  // action, already sorted overdue-first by the backend.
  const dueAssets = useMemo(
    () => serviceDue.filter((a): a is AssetForecast & { status: Exclude<ServiceStatus, 'ok'> } => !!a.status && a.status !== 'ok'),
    [serviceDue],
  );

  function raiseForService(asset: AssetForecast) {
    setPrefill({
      equipmentKey: `${asset.sourceSystem}|${asset.externalId}`,
      title: t('service.prefillTitle', { name: asset.name ?? asset.externalId }),
    });
    setCreating(true);
  }

  const visible = useMemo(() => {
    const term = scope.query.trim().toLowerCase();
    return orders.filter((o) => {
      const profile = profileOf(o.sourceSystem, o.externalId);
      const key = `${o.sourceSystem}|${o.externalId}`;
      const matchesSelected = selectedKey === 'all' || key === selectedKey;
      const matchesStatus = statusFilter === 'all' || o.status === statusFilter;
      const matchesPlant = scope.plantId === 'all' || profile?.plantId === scope.plantId;
      const matchesClass = scope.classSlug === 'all' || profile?.equipmentClassSlug === scope.classSlug;
      const matchesConnection = scope.connection === 'all' || connectionOf(o.externalId) === scope.connection;
      const matchesQuery = !term || o.title.toLowerCase().includes(term) || equipmentName(o.sourceSystem, o.externalId).toLowerCase().includes(term);
      return matchesSelected && matchesStatus && matchesPlant && matchesClass && matchesConnection && matchesQuery;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, equipment, linkHealth, statusFilter, scope, selectedKey]);

  async function act(order: WorkOrder, action: 'start' | 'complete' | 'cancel' | 'reopen') {
    let note: string | undefined;
    if (action !== 'start') {
      const prompt = { complete: t('prompts.complete'), cancel: t('prompts.cancel'), reopen: t('prompts.reopen') }[action];
      const entered = window.prompt(prompt);
      if (!entered?.trim()) return;
      note = entered.trim();
    }
    setBusyId(order.id);
    try {
      await apiActOnWorkOrder(order.id, action, note);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('errors.update'));
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(order: WorkOrder, input: EditWorkOrderInput) {
    try {
      await apiEditWorkOrder(order.id, input);
      setEditing(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('errors.save'));
    }
  }

  async function saveAssignee(order: WorkOrder, userId: string | null, note?: string) {
    try {
      await apiAssignWorkOrder(order.id, userId, note);
      setAssigning(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('errors.assign'));
    }
  }

  async function createOrder(input: RaiseWorkOrderInput) {
    try {
      await apiRaiseWorkOrder(input);
      setCreating(false);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('errors.raise'));
    }
  }

  // One set of buttons for both views: a job is worked the same way from a card or a row.
  const renderActions = (o: WorkOrder) => (
    <>
      {(o.status === 'created' || o.status === 'in-progress') && (
        <>
          {o.status === 'created' && (
            <button disabled={busyId === o.id} onClick={() => act(o, 'start')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
              {t('actions.start')}
            </button>
          )}
          <button disabled={busyId === o.id} onClick={() => act(o, 'complete')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-300 disabled:opacity-50 cursor-pointer">
            {t('actions.complete')}
          </button>
          <button disabled={busyId === o.id} onClick={() => act(o, 'cancel')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-50 cursor-pointer">
            {t('actions.cancel')}
          </button>
        </>
      )}
      {(o.status === 'completed' || o.status === 'cancelled') && (
        <button disabled={busyId === o.id} onClick={() => act(o, 'reopen')} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
          {t('actions.reopen')}
        </button>
      )}
      {(o.status === 'created' || o.status === 'in-progress') && (
        <>
          <button disabled={busyId === o.id} onClick={() => setEditing(o)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
            {t('actions.edit')}
          </button>
          <button disabled={busyId === o.id} onClick={() => setAssigning(o)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
            {o.assignedToUserId ? t('actions.reassign') : t('actions.assign')}
          </button>
        </>
      )}
      <button onClick={() => setHistoryOf(o)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
        {t('actions.history')}
      </button>
    </>
  );

  return (
    <div id="work-orders-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-bold">{t('translation:sidebar.workOrders')}</h2>
          <p className="text-sm text-sky-100">{t('hero.subtitle')}</p>
        </div>
        <button
          onClick={() => { setPrefill(null); setCreating(true); }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-white text-sky-700 hover:bg-sky-50 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> {t('actions.create')}
        </button>
      </div>

      {dueAssets.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 rounded-xl p-4 shadow-xs space-y-2">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{t('service.heading')}</h3>
          </div>
          <div className="space-y-1.5">
            {dueAssets.map((a) => (
              <div key={`${a.sourceSystem}/${a.externalId}`} className="flex items-center justify-between gap-2 text-xs border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
                <div className="min-w-0">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">{a.name ?? a.externalId}</span>
                  <span className="text-slate-400 ml-1.5">
                    {a.status === 'overdue' && a.hoursRemaining != null
                      ? t('service.hoursOverdue', { hours: Math.abs(a.hoursRemaining) })
                      : a.hoursRemaining != null ? t('service.hoursRemaining', { hours: a.hoursRemaining }) : t('service.notSet')}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Chip tone={SERVICE_STATUS_TONE[a.status]}>{t(`serviceStatus.${a.status}`, { defaultValue: a.status })}</Chip>
                  <button
                    onClick={() => raiseForService(a)}
                    className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer"
                  >
                    {t('actions.raise')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <EquipmentFilters
          scope={scope}
          onChange={setScope}
          plants={plants}
          classes={equipmentClasses}
          equipmentOptions={equipmentOptions}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
        <SelectPicker
          data={[{ label: t('filters.allStatuses'), value: 'all' }, ...STATUS_OPTIONS.map((s) => ({ label: t(`status.${s}`, { defaultValue: s }), value: s }))]}
          value={statusFilter}
          onChange={(value) => setStatusFilter((value ?? 'all') as 'all' | WorkOrderStatus)}
          searchable={false}
          cleanable={false}
          className="min-w-[180px]"
        />
      </div>

      <div className="flex justify-end">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">{t('loading')}</p>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
          <ClipboardList className="w-6 h-6" />
          {t('empty')}
        </div>
      ) : viewMode === 'list' ? (
        <ListTable
          columns={[
            { label: t('listCol.reference') }, { label: t('listCol.title') }, { label: t('listCol.machine') },
            { label: t('listCol.status') }, { label: t('listCol.assignee') }, { label: t('listCol.priority') },
            { label: t('listCol.due') }, { label: t('listCol.actions') },
          ]}
          rows={visible}
          rowKey={(o) => o.id}
          cells={(o) => [
            <span className="font-mono text-slate-400">{o.reference}</span>,
            <span className="font-medium">{o.title}</span>,
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{equipmentName(o.sourceSystem, o.externalId)} <ConnectionBadge state={connectionOf(o.externalId)} /></span>,
            <Chip tone={o.status === 'completed' ? 'emerald' : o.status === 'cancelled' ? 'rose' : o.status === 'in-progress' ? 'amber' : 'sky'}>
              {t(`status.${o.status}`, { defaultValue: o.status })}
            </Chip>,
            o.assignedToUserId ? personName(o.assignedToUserId) : <span className="text-slate-400">{t('card.unassigned')}</span>,
            <span className="capitalize">{t(`priority.${o.priority}`, { defaultValue: o.priority })}</span>,
            o.dueAt ? new Date(o.dueAt).toLocaleDateString() : '—',
            <div className="flex flex-wrap items-center gap-1.5">{renderActions(o)}</div>,
          ]}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((o) => (
            <div key={o.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-slate-400">{o.reference}</span>
                <Chip tone={o.status === 'completed' ? 'emerald' : o.status === 'cancelled' ? 'rose' : o.status === 'in-progress' ? 'amber' : 'sky'}>
                  {t(`status.${o.status}`, { defaultValue: o.status })}
                </Chip>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base">{o.title}</h4>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{equipmentName(o.sourceSystem, o.externalId)}</p>
                <ConnectionBadge state={connectionOf(o.externalId)} />
              </div>
              {o.description && <p className="text-sm text-slate-500 dark:text-slate-400">{o.description}</p>}
              {o.resolution && <p className="text-xs text-slate-400 dark:text-slate-500">{t('card.resolution', { resolution: o.resolution })}</p>}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {o.assignedToUserId
                  ? <Trans t={t} i18nKey="card.assignedTo" values={{ name: personName(o.assignedToUserId) }} components={{ b: <span className="font-semibold" /> }} />
                  : t('card.unassigned')}
                {' · '}<Trans t={t} i18nKey="card.priority" values={{ priority: t(`priority.${o.priority}`, { defaultValue: o.priority }) }} components={{ cap: <span className="capitalize" /> }} />
              </p>
              <small className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 pt-1">
                <Clock3 className="w-3.5 h-3.5" />{new Date(o.createdAt).toLocaleString()}
                {o.dueAt ? ` · ${t('card.due', { date: new Date(o.dueAt).toLocaleDateString() })}` : ''}
              </small>
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                {renderActions(o)}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={t('modals.edit')} subtitle={editing?.reference} maxWidth="max-w-xl">
        {editing && <EditWorkOrderForm order={editing} onCancel={() => setEditing(null)} onSave={(input) => saveEdit(editing, input)} />}
      </Modal>

      <Modal isOpen={!!assigning} onClose={() => setAssigning(null)} title={t('modals.assign')} subtitle={assigning?.reference} maxWidth="max-w-md">
        {assigning && (
          <AssignWorkOrderForm
            order={assigning}
            people={people}
            onCancel={() => setAssigning(null)}
            onSave={(userId, note) => saveAssignee(assigning, userId, note)}
          />
        )}
      </Modal>

      <Modal isOpen={!!historyOf} onClose={() => setHistoryOf(null)} title={t('modals.history')} subtitle={historyOf?.reference} maxWidth="max-w-lg">
        {historyOf && <WorkOrderHistory order={historyOf} personName={personName} />}
      </Modal>

      <Modal isOpen={creating} onClose={() => { setCreating(false); setPrefill(null); }} title={t('modals.create')} subtitle={t('modals.createSubtitle')} maxWidth="max-w-xl">
        <CreateWorkOrderForm equipment={equipment} initial={prefill} onCancel={() => { setCreating(false); setPrefill(null); }} onCreate={createOrder} />
      </Modal>
    </div>
  );
};

const CreateWorkOrderForm: React.FC<{
  equipment: EquipmentProfile[];
  initial?: { equipmentKey: string; title: string } | null;
  onCancel: () => void;
  onCreate: (input: RaiseWorkOrderInput) => void;
}> = ({ equipment, initial, onCancel, onCreate }) => {
  const { t } = useTranslation('workOrders');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [equipmentKey, setEquipmentKey] = useState<string | null>(initial?.equipmentKey ?? null);
  const [priority, setPriority] = useState<WorkOrderPriority>('normal');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !equipmentKey) return;
        const [sourceSystem, externalId] = equipmentKey.split('|');
        onCreate({
          sourceSystem, externalId, title: title.trim(), priority,
          description: description.trim() || undefined,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.task')}</span>
        <Input required value={title} onChange={(value) => setTitle(value)} placeholder={t('form.taskPlaceholder')} />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('translation:sidebar.equipment')}</span>
        <SelectPicker
          data={equipment.map((e) => ({ label: `${e.name ?? e.externalId} (${e.externalId})`, value: `${e.sourceSystem}|${e.externalId}` }))}
          value={equipmentKey}
          onChange={(value) => setEquipmentKey(value ?? null)}
          placeholder={t('form.selectEquipment')}
          block
          searchable
          cleanable={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.priority')}</span>
          <SelectPicker
            data={PRIORITY_OPTIONS.map((p) => ({ label: t(`priority.${p}`, { defaultValue: p }), value: p }))}
            value={priority}
            onChange={(value) => setPriority((value ?? 'normal') as WorkOrderPriority)}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.dueDate')}</span>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.description')}</span>
        <Input as="textarea" rows={3} value={description} onChange={(value) => setDescription(value)} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          {t('actions.cancel')}
        </button>
        <button type="submit" disabled={!equipmentKey} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {t('actions.create')}
        </button>
      </div>
    </form>
  );
};

const FIELD_LABEL = 'text-xs font-medium text-slate-600 dark:text-slate-300';
const CANCEL_BTN = 'px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer';
const SAVE_BTN = 'px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer';

/** Title, description, priority and due date. Status and assignee have their own actions. */
const EditWorkOrderForm: React.FC<{
  order: WorkOrder;
  onCancel: () => void;
  onSave: (input: EditWorkOrderInput) => void;
}> = ({ order, onCancel, onSave }) => {
  const { t } = useTranslation('workOrders');
  const [title, setTitle] = useState(order.title);
  const [description, setDescription] = useState(order.description ?? '');
  const [priority, setPriority] = useState<WorkOrderPriority>(order.priority);
  const [dueAt, setDueAt] = useState(order.dueAt ? order.dueAt.slice(0, 10) : '');

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSave({
          title: title.trim(),
          description: description.trim(),
          priority,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        });
      }}
    >
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>{t('form.task')}</span>
        <Input required value={title} onChange={(value) => setTitle(value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className={FIELD_LABEL}>{t('form.priority')}</span>
          <SelectPicker
            data={PRIORITY_OPTIONS.map((p) => ({ label: t(`priority.${p}`, { defaultValue: p }), value: p }))}
            value={priority}
            onChange={(value) => setPriority((value ?? order.priority) as WorkOrderPriority)}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
        <label className="block space-y-1">
          <span className={FIELD_LABEL}>{t('form.dueDate')}</span>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>{t('form.description')}</span>
        <Input as="textarea" rows={3} value={description} onChange={(value) => setDescription(value)} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className={CANCEL_BTN}>{t('actions.cancel')}</button>
        <button type="submit" disabled={!title.trim()} className={SAVE_BTN}>{t('actions.save')}</button>
      </div>
    </form>
  );
};

/** Pick somebody, or nobody to take the job back. The backend refuses a person who
 *  cannot open this machine, and says so. */
const AssignWorkOrderForm: React.FC<{
  order: WorkOrder;
  people: { id: string; fullName: string }[];
  onCancel: () => void;
  onSave: (userId: string | null, note?: string) => void;
}> = ({ order, people, onCancel, onSave }) => {
  const { t } = useTranslation('workOrders');
  const [userId, setUserId] = useState<string>(order.assignedToUserId ?? '');
  const [note, setNote] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(userId || null, note.trim() || undefined);
      }}
    >
      <div className="block space-y-1">
        <span className={FIELD_LABEL}>{t('form.assignTo')}</span>
        <SelectPicker
          data={[{ label: t('form.nobodyUnassign'), value: '' }, ...people.map((p) => ({ label: p.fullName, value: p.id }))]}
          value={userId}
          onChange={(value) => setUserId(value ?? '')}
          block
          searchable
          cleanable={false}
        />
      </div>
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>{t('form.noteOptional')}</span>
        <Input value={note} onChange={(value) => setNote(value)} placeholder={t('form.notePlaceholder')} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className={CANCEL_BTN}>{t('actions.cancel')}</button>
        <button type="submit" disabled={userId === (order.assignedToUserId ?? '')} className={SAVE_BTN}>
          {userId ? t('actions.assign') : t('actions.unassign')}
        </button>
      </div>
    </form>
  );
};

/** Everything that happened to one job, oldest first, with who did it. */
const WorkOrderHistory: React.FC<{
  order: WorkOrder;
  personName: (userId: string | null) => string;
}> = ({ order, personName }) => {
  const { t } = useTranslation('workOrders');
  const [events, setEvents] = useState<WorkOrderEvent[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetWorkOrderHistory(order.id)
      .then((e) => { if (live) setEvents(e); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('errors.history')); });
    return () => { live = false; };
  }, [order.id]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!events) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  if (events.length === 0) return <p className="text-sm text-slate-500">{t('history.empty')}</p>;

  return (
    <ol className="space-y-3">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-sky-200 dark:border-sky-800 pl-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t(`event.${e.kind}`, { defaultValue: e.kind })}</span>
            <span className="text-[11px] text-slate-400">{new Date(e.at).toLocaleString()}</span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('history.by', { name: personName(e.actorUserId) })}
            {e.kind === 'assigned' && <> · {t('history.to', { name: personName(e.toAssignee) })}</>}
            {e.kind === 'unassigned' && e.fromAssignee && <> · {t('history.from', { name: personName(e.fromAssignee) })}</>}
            {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && <> · {t(`status.${e.fromStatus}`, { defaultValue: e.fromStatus })} → {t(`status.${e.toStatus}`, { defaultValue: e.toStatus })}</>}
          </p>
          {e.note && <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">"{e.note}"</p>}
        </li>
      ))}
    </ol>
  );
};
