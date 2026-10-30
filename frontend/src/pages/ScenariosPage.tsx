import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpCircle, CheckCircle2, RefreshCw, Settings } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import { ListTable } from '../components/common/ListTable';
import { LIST_PANEL, TablePagination, usePagination } from '../components/common/TablePagination';
import { ViewModeToggle, useViewMode } from '../components/common/ViewModeToggle';
import { AnchorEditor } from '../components/visual/AnchorEditor';
import { ModelAnchorEditor } from '../components/visual/ModelAnchorEditor';
import {
  ApiError, ClassUpgradePreview, ClientScenario, EditClientScenarioInput, EditMyEquipmentClassInput, MyClassLayoutWidget,
  MyEquipmentClass, ScenarioProvenance, UpgradeAction, UpgradeChange,
  TenantVisual, apiGetMyClassVisual, apiSetMyClassAnchors,
  TenantModel, apiConfirmMyModelAnchor, apiGetMyClassModel, apiSetMyClassModelAnchors,
  apiAdoptLatestScenarioTemplate, apiApplyClassUpgrade, apiPreviewClassUpgrade, apiEditMyCatalogEquipmentClass, apiEditMyCatalogScenario,
  apiGetMyCatalogClassLayout, apiGetMyCatalogEquipmentClass, apiGetMyCatalogScenario, apiListMyCatalogScenarios,
  apiReorderMyCatalogLayout, apiSetMyCatalogWidgetHidden,
} from '../lib/api';

const SEVERITY_TONE: Record<ClientScenario['severity'], 'slate' | 'sky' | 'amber' | 'rose'> = {
  none: 'slate', low: 'sky', medium: 'sky', high: 'amber', critical: 'rose',
};

export const ScenariosPage: React.FC = () => {
  const { t } = useTranslation('scenarios');
  const { t: ts } = useTranslation('shared');
  const [viewMode, setViewMode] = useViewMode('scenarios');
  usePageHeader({ title: t('page.title'), subtitle: t('page.subtitle') });
  const [scenarios, setScenarios] = useState<ClientScenario[]>([]);
  const [classFilter, setClassFilter] = useState('all');
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientScenario | null>(null);
  const [managingClass, setManagingClass] = useState<string | null>(null);

  const refresh = () => apiListMyCatalogScenarios().then(setScenarios);

  useEffect(() => {
    let live = true;
    apiListMyCatalogScenarios()
      .then((s) => { if (live) { setScenarios(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('page.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const classes = useMemo(
    () => [...new Set(scenarios.map((s) => s.clientEquipmentClassSlug))].sort(),
    [scenarios],
  );
  const visible = useMemo(
    () => scenarios.filter((s) => classFilter === 'all' || s.clientEquipmentClassSlug === classFilter),
    [scenarios, classFilter],
  );

  async function toggle(scenario: ClientScenario) {
    setBusySlug(scenario.slug);
    try {
      await apiEditMyCatalogScenario(scenario.slug, { enabled: !scenario.enabled });
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('page.toggleFailed'));
    } finally {
      setBusySlug(null);
    }
  }

  async function save(slug: string, input: EditClientScenarioInput) {
    try {
      await apiEditMyCatalogScenario(slug, input);
      setEditing(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('page.saveFailed'));
    }
  }

  // Paged like every other list, in both views.
  const { pageItems, ...pager } = usePagination(visible);
  type Scenario = (typeof visible)[number];
  // The card's controls, shared with the list row.
  const enabledToggle = (s: Scenario) => (
                  <button
                    disabled={busySlug === s.slug}
                    onClick={() => toggle(s)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 ${s.enabled ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                    title={s.enabled ? t('page.disable') : t('page.enable')}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
                  </button>
  );
  const tagChips = (s: Scenario) => (
    <>
                  <Chip tone={SEVERITY_TONE[s.severity]}>{t(`severity.${s.severity}`, { defaultValue: s.severity })}</Chip>
                  <Chip tone="slate">{t('page.tier', { tier: s.tier })}</Chip>
                  <Chip tone="slate">{s.clientEquipmentClassSlug}</Chip>
                  {s.templateSlug ? (
                    <Chip tone="slate" title={t('page.fromTemplateTitle')}>
                      {t('page.fromTemplate', { template: `${s.templateSlug}${s.templateVersion != null ? ` v${s.templateVersion}` : ''}` })}
                    </Chip>
                  ) : (
                    <Chip tone="slate" title={t('page.selfAuthoredTitle')}>{t('page.selfAuthored')}</Chip>
                  )}
    </>
  );
  const editButton = (s: Scenario) => (
                <button onClick={() => setEditing(s)} className="text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                  {t('page.edit')}
                </button>
  );

  return (
    <div id="scenarios-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">{t('page.heading')}</h2>
        <p className="text-sm text-sky-100">{t('page.intro')}</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <SelectPicker
          data={[{ label: t('page.allClasses'), value: 'all' }, ...classes.map((c) => ({ label: c, value: c }))]}
          value={classFilter}
          onChange={(value) => setClassFilter(value ?? 'all')}
          searchable={false}
          cleanable={false}
          size="sm"
          className="w-64"
        />
        {classFilter !== 'all' && (
          <button
            onClick={() => setManagingClass(classFilter)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" /> {t('page.manageClass')}
          </button>
        )}
        <div className="ml-auto"><ViewModeToggle mode={viewMode} onChange={setViewMode} /></div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className={LIST_PANEL}>
          {loading ? (
            <p className="p-4 text-sm text-slate-500">{t('page.loading')}</p>
          ) : visible.length === 0 ? (
            <p className="p-4 text-sm text-slate-400">{t('page.empty')}</p>
          ) : viewMode === 'list' ? (
            <ListTable bare
              columns={[
                { label: ts('listCol.name') }, { label: ts('listCol.details') }, { label: ts('listCol.needs') },
                { label: ts('listCol.enabled') }, { label: ts('listCol.actions') },
              ]}
              rows={pageItems}
              rowKey={(s) => s.id}
              cells={(s) => [
                <span className="font-medium">{s.name}</span>,
                <div className="flex items-center gap-1.5 flex-wrap">{tagChips(s)}</div>,
                <span className="text-[11px] text-slate-500">{t('page.needs', { signals: s.requiredSignals.join(', ') || t('page.noSignals'), days: s.minimumHistoryDays })}</span>,
                enabledToggle(s),
                editButton(s),
              ]}
            />
          ) : (
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {pageItems.map((s) => (
                <div key={s.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{s.name}</h4>
                    {enabledToggle(s)}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {tagChips(s)}
                  </div>
                  {s.description && <p className="text-xs text-slate-400 dark:text-slate-500">{s.description}</p>}
                  <p className="text-[11px] text-slate-400">
                    {t('page.needs', { signals: s.requiredSignals.join(', ') || t('page.noSignals'), days: s.minimumHistoryDays })}
                  </p>
                  {editButton(s)}
                </div>
              ))}
            </div>
          )}
          {!loading && visible.length > 0 && <TablePagination pinToBottom {...pager} />}
        </div>
      </div>

      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} title={t('edit.title')} subtitle={t('edit.subtitle')} maxWidth="max-w-xl">
        {editing && <ScenarioEditForm scenario={editing} onCancel={() => setEditing(null)} onSave={(input) => save(editing.slug, input)} />}
      </Modal>

      <Modal isOpen={managingClass !== null} onClose={() => setManagingClass(null)} title={t('manage.title')} subtitle={t('manage.subtitle')} maxWidth="max-w-2xl">
        {managingClass && <ClassManageModal slug={managingClass} onClose={() => setManagingClass(null)} />}
      </Modal>
    </div>
  );
};

const ClassManageModal: React.FC<{ slug: string; onClose: () => void }> = ({ slug, onClose }) => {
  const { t } = useTranslation('scenarios');
  const [cls, setCls] = useState<MyEquipmentClass | null>(null);
  const [widgets, setWidgets] = useState<MyClassLayoutWidget[]>([]);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  const refreshLayout = () => apiGetMyCatalogClassLayout(slug).then(({ fallback: f, widgets: w }) => {
    setFallback(f);
    setWidgets(w.slice().sort((a, b) => a.position - b.position));
  });

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([apiGetMyCatalogEquipmentClass(slug), apiGetMyCatalogClassLayout(slug)])
      .then(([c, layout]) => {
        if (!live) return;
        setCls(c);
        setName(c.name);
        setDescription(c.description ?? '');
        setCategory(c.category ?? '');
        setFallback(layout.fallback);
        setWidgets(layout.widgets.slice().sort((a, b) => a.position - b.position));
        setError(undefined);
      })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('manage.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [slug]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiEditMyCatalogEquipmentClass(slug, {
        name: name.trim(), description: description.trim() || undefined, category: category.trim() || undefined,
      } as EditMyEquipmentClassInput);
      onClose();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('manage.saveFailed'));
    }
  }

  async function toggleHidden(widget: MyClassLayoutWidget) {
    setBusyKey(widget.widgetKey);
    try {
      await apiSetMyCatalogWidgetHidden(slug, widget.widgetKey, !widget.hidden);
      await refreshLayout();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('manage.widgetFailed'));
    } finally {
      setBusyKey(null);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= widgets.length) return;
    const reordered = widgets.slice();
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setWidgets(reordered);
    setBusyKey(widgets[index].widgetKey);
    try {
      await apiReorderMyCatalogLayout(slug, reordered.map((w) => w.widgetKey));
      await refreshLayout();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('manage.reorderFailed'));
      await refreshLayout();
    } finally {
      setBusyKey(null);
    }
  }

  // After an upgrade the class's own fields may have followed the library too, so the
  // form is reloaded along with the layout rather than left showing the old values.
  async function reloadAfterUpgrade() {
    const c = await apiGetMyCatalogEquipmentClass(slug);
    setCls(c);
    setName(c.name);
    setDescription(c.description ?? '');
    setCategory(c.category ?? '');
    await refreshLayout();
  }

  if (loading) return <p className="text-sm text-slate-500">{t('page.loading')}</p>;
  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!cls) return null;

  return (
    <div className="space-y-5">
      <ClassUpgradeSection slug={slug} onUpgraded={reloadAfterUpgrade} />

      <form onSubmit={saveDetails} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.name')}</span>
          <Input required value={name} onChange={(value) => setName(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.description')}</span>
          <Input as="textarea" rows={2} value={description} onChange={(value) => setDescription(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.category')}</span>
          <Input value={category} onChange={(value) => setCategory(value)} />
        </label>
        <div className="flex items-center justify-end gap-3">
          <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer">
            {t('manage.saveDetails')}
          </button>
        </div>
      </form>

      <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('manage.layout')}</h4>
          {fallback && <span className="text-[11px] text-slate-400">{t('manage.fallback')}</span>}
        </div>
        <div className="space-y-1.5">
          {widgets.map((w, i) => (
            <div key={w.widgetKey} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{w.title ?? w.widgetKey}</p>
                <p className="text-[11px] text-slate-400">{w.widgetType}{w.positionCustom ? ` · ${t('manage.reordered')}` : ''}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button disabled={fallback || busyKey === w.widgetKey || i === 0} onClick={() => move(i, -1)} className="p-1.5 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed">
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button disabled={fallback || busyKey === w.widgetKey || i === widgets.length - 1} onClick={() => move(i, 1)} className="p-1.5 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed">
                  <ArrowDown className="w-3 h-3" />
                </button>
                <button
                  disabled={fallback || busyKey === w.widgetKey}
                  onClick={() => toggleHidden(w)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${!w.hidden ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                  title={fallback ? t('manage.noSavedLayout') : w.hidden ? t('manage.show') : t('manage.hide')}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${!w.hidden ? 'translate-x-4.5' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          ))}
          {widgets.length === 0 && <p className="text-xs text-slate-400">{t('manage.noWidgets')}</p>}
        </div>
      </div>

      <MyClassMarkers slug={slug} />
      <MyClassModelMarkers slug={slug} />
    </div>
  );
};

/** The account's copy of the class's 3-D model markers (QTWIN1 §3): the model is the
 *  library's; markers can be moved or added here, and a marker the library's geometry
 *  changed under waits in amber until someone confirms it is still right. */
const MyClassModelMarkers: React.FC<{ slug: string }> = ({ slug }) => {
  const { t } = useTranslation('scenarios');
  const [model, setModel] = useState<TenantModel | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetMyClassModel(slug)
      .then((m) => { if (live) setModel(m); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('model.loadFailed')); });
    return () => { live = false; };
  }, [slug]);

  const recheck = model?.tray.filter((x) => x.needsRecheck).length ?? 0;
  return (
    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('model.title')}</h4>
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {!model ? (
        !error && <p className="text-xs text-slate-400">{t('page.loading')}</p>
      ) : model.state === 'assets_unavailable' ? (
        <p className="text-xs text-slate-400">{t('markers.noStorage')}</p>
      ) : model.state !== 'ready' || !model.modelUrl ? (
        <p className="text-xs text-slate-400">{t('model.noModel')}</p>
      ) : (
        <>
          {recheck > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t('model.recheckWaiting', { count: recheck })}</p>}
          <ModelAnchorEditor
            key={`${model.geometryVersion}-${model.anchors.length}-${recheck}`}
            modelUrl={model.modelUrl}
            bounds={model.bounds}
            anchors={model.anchors}
            unplacedSignals={model.tray.filter((x) => !x.needsRecheck).map((x) => x.signal)}
            onSave={async (anchors) => { setModel(await apiSetMyClassModelAnchors(slug, anchors)); }}
            onConfirm={async (signal) => { setModel(await apiConfirmMyModelAnchor(slug, signal)); }}
            note={t('markers.note')}
          />
        </>
      )}
    </div>
  );
};

/** The account's copy of the class schematic: the image is the library's, the markers
 *  can be moved or added here, and a moved one stays put through later upgrades. */
const MyClassMarkers: React.FC<{ slug: string }> = ({ slug }) => {
  const { t } = useTranslation('scenarios');
  const [visual, setVisual] = useState<TenantVisual | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetMyClassVisual(slug)
      .then((v) => { if (live) setVisual(v); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('markers.loadFailed')); });
    return () => { live = false; };
  }, [slug]);

  return (
    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('markers.title')}</h4>
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {!visual ? (
        !error && <p className="text-xs text-slate-400">{t('page.loading')}</p>
      ) : visual.state === 'assets_unavailable' ? (
        <p className="text-xs text-slate-400">{t('markers.noStorage')}</p>
      ) : visual.state !== 'ready' || !visual.imageUrl ? (
        <p className="text-xs text-slate-400">{t('markers.noImage')}</p>
      ) : (
        <AnchorEditor
          imageUrl={visual.imageUrl}
          anchors={visual.anchors}
          unplacedSignals={visual.unplacedSignals}
          onSave={async (anchors) => { setVisual(await apiSetMyClassAnchors(slug, anchors)); }}
          note={t('markers.note')}
        />
      )}
    </div>
  );
};


/** "3 updated from the library, 1 kept (yours)" — empty when nothing of that kind moves. */
function summarise(t: TFunction<'scenarios'>, changes: UpgradeChange[]): string {
  const counts = new Map<UpgradeAction, number>();
  for (const c of changes) {
    // An inherited row the library didn't touch is "replaced" with itself; not news.
    if (c.action === 'replace' && c.upstream === 'unchanged') continue;
    counts.set(c.action, (counts.get(c.action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, n]) => t(`upgrade.action.${action}`, { count: n })).join(', ');
}

/** The library's newer version of this class, what taking it would change, and the
 *  button that applies exactly the version shown (QUPGRADE1). */
const ClassUpgradeSection: React.FC<{ slug: string; onUpgraded: () => Promise<void> }> = ({ slug, onUpgraded }) => {
  const { t } = useTranslation('scenarios');
  const [preview, setPreview] = useState<ClassUpgradePreview | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = () => apiPreviewClassUpgrade(slug)
    .then((p) => { setPreview(p); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('upgrade.checkFailed')));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [slug]);

  async function apply() {
    if (!preview) return;
    if (!window.confirm(t('upgrade.confirm', { version: preview.toVersion }))) return;
    setApplying(true);
    setNotice(undefined);
    try {
      const result = await apiApplyClassUpgrade(slug, preview.toVersion);
      setNotice(result.upgraded ? t('upgrade.upgraded', { version: result.toVersion }) : t('upgrade.alreadyOn', { version: result.toVersion }));
      await onUpgraded();
      await load();
    } catch (err) {
      // Most likely a newer version published after this preview: show the fresh one.
      setError(err instanceof ApiError ? err.message : t('upgrade.failed'));
      await load();
    } finally {
      setApplying(false);
    }
  }

  if (error) return <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>;
  if (!preview) return <p className="text-xs text-slate-400">{t('upgrade.checking')}</p>;

  if (preview.upToDate) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>{t('upgrade.upToDate', { version: preview.toVersion })}</span>
        {notice && <span className="text-slate-400">{notice}</span>}
      </div>
    );
  }

  const lines: [string, string][] = [
    // The preview says whether the fields follow the library, not whether v-next changed
    // them, so this states the rule rather than claiming a change.
    [t('upgrade.classDetails'), preview.classFields.action === 'keep' ? t('upgrade.keptYours') : t('upgrade.followLibrary')],
    [t('upgrade.formulas'), summarise(t, preview.formulas)],
    [t('upgrade.failureModes'), summarise(t, preview.failureModes)],
    [t('upgrade.recommendations'), summarise(t, preview.recommendations)],
    [t('upgrade.pageWidgets'), [
      preview.layout.added.length ? t('upgrade.added', { count: preview.layout.added.length }) : '',
      preview.layout.removed.length ? t('upgrade.removed', { count: preview.layout.removed.length }) : '',
      preview.layout.keptCustom.length ? t('upgrade.arrangementsKept', { count: preview.layout.keptCustom.length }) : '',
    ].filter(Boolean).join(', ')],
    [t('upgrade.schematicAnchors'), [
      preview.anchors.added.length ? t('upgrade.added', { count: preview.anchors.added.length }) : '',
      preview.anchors.removed.length ? t('upgrade.removed', { count: preview.anchors.removed.length }) : '',
      preview.anchors.needsRecheck.length ? t('upgrade.toRecheck', { count: preview.anchors.needsRecheck.length }) : '',
    ].filter(Boolean).join(', ')],
  ];

  return (
    <div className="bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-sky-800 dark:text-sky-300">
          {t('upgrade.available', { version: preview.toVersion })} <span className="font-normal">{t('upgrade.youHave', { version: preview.fromVersion })}</span>
        </p>
        <button
          onClick={apply}
          disabled={applying}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer shrink-0"
        >
          <ArrowUpCircle className="w-3.5 h-3.5" /> {applying ? t('upgrade.upgrading') : t('upgrade.upgradeTo', { version: preview.toVersion })}
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {lines.filter(([, text]) => text).map(([label, text]) => (
          <React.Fragment key={label}>
            <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="text-slate-700 dark:text-slate-200">{text}</dd>
          </React.Fragment>
        ))}
      </dl>
      {lines.slice(1).every(([, text]) => !text) && (
        <p className="text-[11px] text-slate-500">{t('upgrade.noChanges')}</p>
      )}
      {notice && <p className="text-[11px] text-slate-500">{notice}</p>}
    </div>
  );
};

const ScenarioEditForm: React.FC<{
  scenario: ClientScenario;
  onCancel: () => void;
  onSave: (input: EditClientScenarioInput) => void;
}> = ({ scenario, onCancel, onSave }) => {
  const { t } = useTranslation('scenarios');
  const [name, setName] = useState(scenario.name);
  const [description, setDescription] = useState(scenario.description ?? '');
  const [severity, setSeverity] = useState(scenario.severity);
  const [tier, setTier] = useState<1 | 2 | 3>(scenario.tier);
  const [minimumHistoryDays, setMinimumHistoryDays] = useState(scenario.minimumHistoryDays);
  const [provenance, setProvenance] = useState<ScenarioProvenance | null>(null);
  const [adopting, setAdopting] = useState(false);

  useEffect(() => {
    let live = true;
    apiGetMyCatalogScenario(scenario.slug).then((full) => { if (live) setProvenance(full.provenance); }).catch(() => {});
    return () => { live = false; };
  }, [scenario.slug]);

  async function adopt() {
    setAdopting(true);
    try {
      await apiAdoptLatestScenarioTemplate(scenario.slug);
      onCancel();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('edit.adoptFailed'));
    } finally {
      setAdopting(false);
    }
  }

  return (
    <div className="space-y-4">
      {provenance?.newerTemplateAvailable && (
        <div className="flex items-center justify-between gap-3 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900 rounded-lg px-3 py-2.5">
          <p className="text-xs text-sky-700 dark:text-sky-300">
            {t('edit.newerTemplate', { newer: provenance.newerTemplateVersion, current: provenance.templateVersion })}
          </p>
          <button onClick={adopt} disabled={adopting} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer shrink-0">
            <RefreshCw className={`w-3.5 h-3.5 ${adopting ? 'animate-spin' : ''}`} /> {t('edit.adoptLatest')}
          </button>
        </div>
      )}
      {provenance && !provenance.unchangedSinceCopy && (
        <p className="text-xs text-slate-400">{t('edit.editedLocally', { template: provenance.templateSlug ?? t('edit.itsTemplate') })}</p>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name: name.trim(), description: description.trim() || undefined, severity, tier, minimumHistoryDays });
        }}
      >
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.name')}</span>
          <Input required value={name} onChange={(value) => setName(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.description')}</span>
          <Input as="textarea" rows={2} value={description} onChange={(value) => setDescription(value)} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.severity')}</span>
            <SelectPicker
              data={['none', 'low', 'medium', 'high', 'critical'].map((s) => ({ label: t(`severity.${s}`), value: s }))}
              value={severity}
              onChange={(value) => setSeverity((value ?? 'medium') as ClientScenario['severity'])}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.tier')}</span>
            <SelectPicker
              data={[1, 2, 3].map((n) => ({ label: t('page.tier', { tier: n }), value: n }))}
              value={tier}
              onChange={(value) => setTier((value ?? 1) as 1 | 2 | 3)}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('form.minHistory')}</span>
            <InputNumber min={0} max={365} value={minimumHistoryDays} onChange={(value) => setMinimumHistoryDays(Number(value) || 0)} />
          </div>
        </div>
        <p className="text-[11px] text-slate-400">{t('form.requiredSignals', { signals: scenario.requiredSignals.join(', ') || t('form.none') })}</p>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
            {t('form.cancel')}
          </button>
          <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer">
            {t('form.saveChanges')}
          </button>
        </div>
      </form>
    </div>
  );
};
