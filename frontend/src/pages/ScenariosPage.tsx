import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, RefreshCw, Settings } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import {
  ApiError, ClientScenario, EditClientScenarioInput, EditMyEquipmentClassInput, MyClassLayoutWidget,
  MyEquipmentClass, ScenarioProvenance,
  apiAdoptLatestScenarioTemplate, apiEditMyCatalogEquipmentClass, apiEditMyCatalogScenario,
  apiGetMyCatalogClassLayout, apiGetMyCatalogEquipmentClass, apiGetMyCatalogScenario, apiListMyCatalogScenarios,
  apiReorderMyCatalogLayout, apiSetMyCatalogWidgetHidden,
} from '../lib/api';

const SEVERITY_TONE: Record<ClientScenario['severity'], 'slate' | 'sky' | 'amber' | 'rose'> = {
  none: 'slate', low: 'sky', medium: 'sky', high: 'amber', critical: 'rose',
};

export const ScenariosPage: React.FC = () => {
  usePageHeader({ title: 'Scenarios', subtitle: "Your Account's Prediction Catalog" });
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load scenarios.'); })
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
      window.alert(err instanceof ApiError ? err.message : 'Could not change this scenario.');
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
      window.alert(err instanceof ApiError ? err.message : 'Could not save this scenario.');
    }
  }

  return (
    <div id="scenarios-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Scenarios</h2>
        <p className="text-sm text-sky-100">Your account's copies of the prediction scenarios it has adopted.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <SelectPicker
          data={[{ label: 'All equipment classes', value: 'all' }, ...classes.map((c) => ({ label: c, value: c }))]}
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
            <Settings className="w-3.5 h-3.5" /> Manage class
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-slate-400">No scenarios adopted yet. Entitlements are granted from Administration, and scenarios copy in from there.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visible.map((s) => (
              <div key={s.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{s.name}</h4>
                  <button
                    disabled={busySlug === s.slug}
                    onClick={() => toggle(s)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 ${s.enabled ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                    title={s.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={SEVERITY_TONE[s.severity]}>{s.severity}</Chip>
                  <Chip tone="slate">Tier {s.tier}</Chip>
                  <Chip tone="slate">{s.clientEquipmentClassSlug}</Chip>
                  {s.templateSlug ? (
                    <Chip tone="slate" title="Copied in when this equipment class was granted to the account">
                      from {s.templateSlug}{s.templateVersion != null ? ` v${s.templateVersion}` : ''}
                    </Chip>
                  ) : (
                    <Chip tone="slate" title="Authored directly in this account, not copied from a template">self-authored</Chip>
                  )}
                </div>
                {s.description && <p className="text-xs text-slate-400 dark:text-slate-500">{s.description}</p>}
                <p className="text-[11px] text-slate-400">
                  Needs {s.requiredSignals.join(', ') || 'no signals'} · {s.minimumHistoryDays}d history
                </p>
                <button onClick={() => setEditing(s)} className="text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} title="Edit scenario" subtitle="Client Scenario" maxWidth="max-w-xl">
        {editing && <ScenarioEditForm scenario={editing} onCancel={() => setEditing(null)} onSave={(input) => save(editing.slug, input)} />}
      </Modal>

      <Modal isOpen={managingClass !== null} onClose={() => setManagingClass(null)} title="Manage equipment class" subtitle="Your Account's Copy" maxWidth="max-w-2xl">
        {managingClass && <ClassManageModal slug={managingClass} onClose={() => setManagingClass(null)} />}
      </Modal>
    </div>
  );
};

const ClassManageModal: React.FC<{ slug: string; onClose: () => void }> = ({ slug, onClose }) => {
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load this class.'); })
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
      window.alert(err instanceof ApiError ? err.message : 'Could not save this class.');
    }
  }

  async function toggleHidden(widget: MyClassLayoutWidget) {
    setBusyKey(widget.widgetKey);
    try {
      await apiSetMyCatalogWidgetHidden(slug, widget.widgetKey, !widget.hidden);
      await refreshLayout();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not change this widget.');
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
      window.alert(err instanceof ApiError ? err.message : 'Could not reorder the layout.');
      await refreshLayout();
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!cls) return null;

  return (
    <div className="space-y-5">
      <form onSubmit={saveDetails} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
          <Input required value={name} onChange={(value) => setName(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Description</span>
          <Input as="textarea" rows={2} value={description} onChange={(value) => setDescription(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Category</span>
          <Input value={category} onChange={(value) => setCategory(value)} />
        </label>
        <div className="flex items-center justify-end gap-3">
          <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer">
            Save details
          </button>
        </div>
      </form>

      <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Machine page layout</h4>
          {fallback && <span className="text-[11px] text-slate-400">Computed fallback — nothing to hide or reorder until this class has a saved layout</span>}
        </div>
        <div className="space-y-1.5">
          {widgets.map((w, i) => (
            <div key={w.widgetKey} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{w.title ?? w.widgetKey}</p>
                <p className="text-[11px] text-slate-400">{w.widgetType}{w.positionCustom ? ' · reordered' : ''}</p>
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
                  title={fallback ? 'No saved layout yet' : w.hidden ? 'Show' : 'Hide'}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${!w.hidden ? 'translate-x-4.5' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          ))}
          {widgets.length === 0 && <p className="text-xs text-slate-400">No widgets on this class's page.</p>}
        </div>
      </div>
    </div>
  );
};

const ScenarioEditForm: React.FC<{
  scenario: ClientScenario;
  onCancel: () => void;
  onSave: (input: EditClientScenarioInput) => void;
}> = ({ scenario, onCancel, onSave }) => {
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
      window.alert(err instanceof ApiError ? err.message : 'Could not adopt the latest template.');
    } finally {
      setAdopting(false);
    }
  }

  return (
    <div className="space-y-4">
      {provenance?.newerTemplateAvailable && (
        <div className="flex items-center justify-between gap-3 bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900 rounded-lg px-3 py-2.5">
          <p className="text-xs text-sky-700 dark:text-sky-300">
            Template version {provenance.newerTemplateVersion} is available (you have {provenance.templateVersion}). Adopting discards local edits.
          </p>
          <button onClick={adopt} disabled={adopting} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 cursor-pointer shrink-0">
            <RefreshCw className={`w-3.5 h-3.5 ${adopting ? 'animate-spin' : ''}`} /> Adopt latest
          </button>
        </div>
      )}
      {provenance && !provenance.unchangedSinceCopy && (
        <p className="text-xs text-slate-400">Edited locally since it was copied from {provenance.templateSlug ?? 'its template'}.</p>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name: name.trim(), description: description.trim() || undefined, severity, tier, minimumHistoryDays });
        }}
      >
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
          <Input required value={name} onChange={(value) => setName(value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Description</span>
          <Input as="textarea" rows={2} value={description} onChange={(value) => setDescription(value)} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Severity</span>
            <SelectPicker
              data={['none', 'low', 'medium', 'high', 'critical'].map((s) => ({ label: s, value: s }))}
              value={severity}
              onChange={(value) => setSeverity((value ?? 'medium') as ClientScenario['severity'])}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Tier</span>
            <SelectPicker
              data={[1, 2, 3].map((t) => ({ label: `Tier ${t}`, value: t }))}
              value={tier}
              onChange={(value) => setTier((value ?? 1) as 1 | 2 | 3)}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Min. history (days)</span>
            <InputNumber min={0} max={365} value={minimumHistoryDays} onChange={(value) => setMinimumHistoryDays(Number(value) || 0)} />
          </div>
        </div>
        <p className="text-[11px] text-slate-400">Required signals: {scenario.requiredSignals.join(', ') || 'none'}</p>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
            Cancel
          </button>
          <button type="submit" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer">
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
};
