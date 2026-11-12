import React, { useEffect, useMemo, useState } from 'react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { FILTER_PICKER } from '../../lib/filterPicker';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ClipboardPaste, Copy, Edit2, Gauge, Plus, Search, Trash2, X } from 'lucide-react';
import {
  ApiError, DutyCurvePoint, EquipmentModel, ModelScope, RatingName,
  apiCopyModelFromLibrary, apiCreateModel, apiDeleteMyModel, apiGetDutyCurve, apiGetModelRatings, apiGetRatingNames,
  apiListEquipmentClasses, apiListModels, apiListMyEquipmentClasses, apiReplaceDutyCurve, apiReplaceModelRatings,
  apiUpdateModel,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthProvider';
import { staffMay } from '../../lib/pageAccess';
import { apiMyPermissions } from '../../lib/api';
import { Modal } from '../common/Modal';
import { ListTable } from '../common/ListTable';
import { Skeleton } from '../common/Skeleton';
import { LIST_PANEL, TablePagination, usePagination } from '../common/TablePagination';

/**
 * Models: a machine's make and model, the class it belongs to, and since D57/D58 the rated
 * figures and catalogue duty curve every machine naming it is measured against (Crompton
 * POC, 11 Nov). The library had routes and no screen at all: a 1 HP pump's rated current
 * or its head–flow table could only be loaded through the API.
 *
 * One view for both sides. `library`: Master Admin's models. `account`: the account's own
 * copies, which its machines name; a copy is the account's, and a later library edit does
 * not reach it (D04).
 */
export const ModelsView: React.FC<{ scope: ModelScope; canEdit: boolean }> = ({ scope, canEdit }) => {
  const { t } = useTranslation('catalog');
  const { t: ts } = useTranslation('shared');
  const [models, setModels] = useState<EquipmentModel[] | null>(null);
  const [library, setLibrary] = useState<EquipmentModel[]>([]);
  const [classes, setClasses] = useState<{ slug: string; name: string }[]>([]);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EquipmentModel | 'new' | null>(null);
  const [copyFrom, setCopyFrom] = useState<string | null>(null);

  const load = () => apiListModels(scope)
    .then((m) => { setModels(m); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('models.loadFailed')));

  useEffect(() => {
    void load();
    (scope === 'library' ? apiListEquipmentClasses() : apiListMyEquipmentClasses())
      .then((c) => setClasses(c.map((x) => ({ slug: x.slug, name: x.name })))).catch(() => {});
    if (scope === 'account') apiListModels('library').then(setLibrary).catch(() => setLibrary([]));
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const className = (slug: string | null) => (slug ? classes.find((c) => c.slug === slug)?.name ?? slug : '—');
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (models ?? []).filter((m) => !term || [m.name, m.manufacturer, m.equipmentClassSlug, m.category]
      .some((v) => v?.toLowerCase().includes(term)));
  }, [models, query]);
  const { pageItems, ...pager } = usePagination(visible);

  const copy = async () => {
    if (!copyFrom) return;
    try {
      await apiCopyModelFromLibrary(copyFrom);
      setCopyFrom(null);
      await load();
    } catch { /* the red toast says why */ }
  };

  const remove = async (m: EquipmentModel) => {
    if (!window.confirm(t('models.deleteConfirm', { name: m.name }))) return;
    try { await apiDeleteMyModel(m.id); await load(); } catch { /* toast */ }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
          <Input size="sm" value={query} onChange={(v) => { setQuery(v); pager.setPage(1); }} placeholder={t('models.search')} className="w-full pl-9!" />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {scope === 'account' && canEdit && (
            <>
              <SelectPicker
                size="sm"
                data={library.map((m) => ({ label: [m.manufacturer, m.name].filter(Boolean).join(' '), value: m.id }))}
                value={copyFrom}
                onChange={setCopyFrom}
                placeholder={t('models.copyPick')}
                className={`w-full sm:w-64 ${FILTER_PICKER}`}
              />
              <button
                disabled={!copyFrom}
                onClick={() => void copy()}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <Copy className="w-4 h-4" /> {t('models.copy')}
              </button>
            </>
          )}
          {canEdit && (
            <button
              id="new-model-btn"
              onClick={() => setEditing('new')}
              className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <Plus className="w-4 h-4" /> {t('models.new')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
        <div className={LIST_PANEL}>
          {models === null ? <Skeleton lines={4} className="p-4" /> : visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-400">{scope === 'account' ? t('models.emptyAccount') : t('models.empty')}</p>
          ) : (
            <ListTable bare
              columns={[
                { label: ts('listCol.name') }, { label: t('models.class') }, { label: t('models.manufacturer') },
                { label: ts('listCol.actions') },
              ]}
              rows={pageItems}
              rowKey={(m) => m.id}
              cells={(m) => [
                <span className="font-medium">{m.name}</span>,
                <span className="text-slate-600 dark:text-slate-300">{className(m.equipmentClassSlug)}</span>,
                <span className="text-slate-600 dark:text-slate-300">{m.manufacturer ?? '—'}</span>,
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setEditing(m)} title={canEdit ? t('models.edit') : t('models.view')}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 cursor-pointer">
                    {canEdit ? <Edit2 className="w-3.5 h-3.5" /> : <Gauge className="w-3.5 h-3.5" />}
                  </button>
                  {scope === 'account' && canEdit && (
                    <button onClick={() => void remove(m)} title={t('models.delete')}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>,
              ]}
            />
          )}
          {visible.length > 0 && <TablePagination {...pager} />}
        </div>
      </div>

      {editing && (
        <ModelModal
          scope={scope}
          model={editing === 'new' ? null : editing}
          classes={classes}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
};

/**
 * The Administration tab: who may edit is the server's answer, asked once. Library models
 * are Master Admin's (equipment-template.write); an account's copies are anyone in it with
 * equipment.write. A read-only role sees the figures and no buttons the server would refuse.
 */
export const ModelsTab: React.FC<{ scope: ModelScope }> = ({ scope }) => {
  const { authUser } = useAuth();
  const [accountCanEdit, setAccountCanEdit] = useState(false);
  useEffect(() => {
    if (scope !== 'account') return;
    apiMyPermissions().then((p) => setAccountCanEdit(!!p.capabilities['equipment.write'])).catch(() => setAccountCanEdit(false));
  }, [scope]);
  const canEdit = scope === 'library' ? staffMay(authUser, 'equipment-template.write') : accountCanEdit;
  return <ModelsView scope={scope} canEdit={canEdit} />;
};

type Tab = 'details' | 'ratings' | 'curve';
const label = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1';
const cellInput = 'w-full';

/** One model: its details, then the ratings and the curve, each saved on its own. */
const ModelModal: React.FC<{
  scope: ModelScope;
  model: EquipmentModel | null;
  classes: { slug: string; name: string }[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}> = ({ scope, model, classes, canEdit, onClose, onSaved }) => {
  const { t } = useTranslation('catalog');
  const [current, setCurrent] = useState<EquipmentModel | null>(model);
  const [tab, setTab] = useState<Tab>('details');
  const tabs: Tab[] = current ? ['details', 'ratings', 'curve'] : ['details'];

  return (
    <Modal isOpen onClose={onClose} title={current?.name ?? t('models.new')} subtitle={t('models.subtitle')} maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-2">
          {tabs.map((k) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${tab === k ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              {t(`models.tab.${k}`)}
            </button>
          ))}
          {!current && <span className="text-xs text-slate-400 self-center">{t('models.saveFirst')}</span>}
        </div>
        {tab === 'details' && (
          <DetailsForm scope={scope} model={current} classes={classes} canEdit={canEdit}
            onSaved={(m) => { setCurrent(m); onSaved(); if (!current) setTab('ratings'); }} />
        )}
        {tab === 'ratings' && current && <RatingsEditor scope={scope} modelId={current.id} canEdit={canEdit} />}
        {tab === 'curve' && current && <CurveEditor scope={scope} modelId={current.id} canEdit={canEdit} />}
      </div>
    </Modal>
  );
};

const DetailsForm: React.FC<{
  scope: ModelScope; model: EquipmentModel | null; classes: { slug: string; name: string }[]; canEdit: boolean;
  onSaved: (m: EquipmentModel) => void;
}> = ({ scope, model, classes, canEdit, onSaved }) => {
  const { t } = useTranslation('catalog');
  const [name, setName] = useState(model?.name ?? '');
  const [classSlug, setClassSlug] = useState<string | null>(model?.equipmentClassSlug ?? null);
  const [manufacturer, setManufacturer] = useState(model?.manufacturer ?? '');
  const [description, setDescription] = useState(model?.description ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const input = {
        name: name.trim(), equipmentClassSlug: classSlug ?? undefined,
        manufacturer: manufacturer.trim() || undefined, description: description.trim() || undefined,
      };
      onSaved(model ? await apiUpdateModel(scope, model.id, input) : await apiCreateModel(scope, input));
    } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void save(); }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>{t('models.name')} <span className="text-rose-500">*</span></span>
          <Input value={name} onChange={setName} disabled={!canEdit} placeholder={t('models.namePlaceholder')} />
        </label>
        <label className="block">
          <span className={label}>{t('models.manufacturer')}</span>
          <Input value={manufacturer} onChange={setManufacturer} disabled={!canEdit} />
        </label>
      </div>
      {/* A div: a label hands its click to the picker a second time and it closes again. */}
      <div>
        <span className={label}>{t('models.class')}</span>
        <SelectPicker data={classes.map((c) => ({ label: c.name, value: c.slug }))} value={classSlug} onChange={setClassSlug}
          disabled={!canEdit} block placeholder={t('models.classPlaceholder')} />
        <span className="block text-xs text-slate-400 mt-1">{t('models.classHint')}</span>
      </div>
      <label className="block">
        <span className={label}>{t('models.description')}</span>
        <Input as="textarea" rows={2} value={description} onChange={setDescription} disabled={!canEdit} />
      </label>
      {canEdit && (
        <div className="flex justify-end">
          <button type="submit" disabled={!name.trim() || busy}
            className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
            {model ? t('models.saveDetails') : t('models.create')}
          </button>
        </div>
      )}
    </form>
  );
};

interface RatingRow { name: string | null; value: number | null; source: string }

/** Every rated figure with the page it came from (D57: `source` is required). Saved whole. */
const RatingsEditor: React.FC<{ scope: ModelScope; modelId: string; canEdit: boolean }> = ({ scope, modelId, canEdit }) => {
  const { t } = useTranslation('catalog');
  const [names, setNames] = useState<RatingName[]>([]);
  const [rows, setRows] = useState<RatingRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiGetRatingNames().then(setNames).catch(() => setNames([]));
    apiGetModelRatings(scope, modelId)
      .then((r) => setRows(r.map((x) => ({ name: x.name, value: x.value, source: x.source }))))
      .catch(() => setRows([]));
  }, [scope, modelId]);

  const byName = new Map(names.map((n) => [n.name, n]));
  const used = new Set((rows ?? []).map((r) => r.name).filter(Boolean));
  const complete = (rows ?? []).every((r) => r.name && r.value !== null && Number.isFinite(r.value) && r.source.trim());
  const set = (i: number, patch: Partial<RatingRow>) => { setSaved(false); setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r))); };

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const out = await apiReplaceModelRatings(scope, modelId,
        rows.map((r) => ({ name: r.name!, value: r.value!, source: r.source.trim() })));
      setRows(out.map((x) => ({ name: x.name, value: x.value, source: x.source })));
      setSaved(true);
    } catch { /* toast */ } finally { setBusy(false); }
  };

  if (rows === null) return <Skeleton lines={3} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('models.ratingsHint')}</p>
      {rows.length === 0 && <p className="text-sm text-slate-400">{t('models.noRatings')}</p>}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const meta = r.name ? byName.get(r.name) : undefined;
          return (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[1.4fr_0.8fr_1.4fr_auto] gap-2 items-start rounded-lg border border-slate-100 dark:border-slate-800 p-2">
              <div>
                <SelectPicker
                  size="sm" block disabled={!canEdit}
                  data={names.filter((n) => n.name === r.name || !used.has(n.name)).map((n) => ({ label: n.name, value: n.name }))}
                  value={r.name} onChange={(v) => set(i, { name: v })} placeholder={t('models.pickRating')}
                />
                {meta?.description && <span className="block text-[0.6875rem] text-slate-400 mt-1 leading-snug">{meta.description}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <InputNumber size="sm" className={cellInput} value={r.value ?? ''} disabled={!canEdit}
                  onChange={(v) => set(i, { value: v === '' || v === null ? null : Number(v) })} />
                <span className="text-xs text-slate-500 shrink-0 min-w-8">{meta ? (meta.unit ?? '—') : ''}</span>
              </div>
              <Input size="sm" value={r.source} onChange={(v) => set(i, { source: v })} disabled={!canEdit} placeholder={t('models.sourcePlaceholder')} />
              {canEdit && (
                <button onClick={() => { setSaved(false); setRows((rs) => rs!.filter((_, j) => j !== i)); }} title={t('models.removeRow')}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 cursor-pointer justify-self-end"><X className="w-4 h-4" /></button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => { setSaved(false); setRows((rs) => [...rs!, { name: null, value: null, source: rs!.at(-1)?.source ?? '' }]); }}
            disabled={used.size >= names.length}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
            <Plus className="w-3.5 h-3.5" /> {t('models.addRating')}
          </button>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('models.saved')}</span>}
            {!complete && <span className="text-xs text-amber-600 dark:text-amber-400">{t('models.ratingsIncomplete')}</span>}
            <button onClick={() => void save()} disabled={!complete || busy}
              className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
              {t('models.saveRatings')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

type PointRow = { headM: number | null; flowLpm: number | null; inputKw: number | null };

/**
 * The catalogue's performance table (D58): head (m), flow (L/min) and input power (kW) per
 * printed point. Pasting the rows from a spreadsheet is the usual way in; the server orders
 * them and refuses a curve whose flow does not rise as head falls.
 */
const CurveEditor: React.FC<{ scope: ModelScope; modelId: string; canEdit: boolean }> = ({ scope, modelId, canEdit }) => {
  const { t } = useTranslation('catalog');
  const [source, setSource] = useState('');
  const [rows, setRows] = useState<PointRow[] | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiGetDutyCurve(scope, modelId)
      .then((c) => { setSource(c.source ?? ''); setRows(c.points.map((p) => ({ headM: p.headM, flowLpm: p.flowLpm, inputKw: p.inputKw }))); })
      .catch(() => setRows([]));
  }, [scope, modelId]);

  const complete = (rows ?? []).every((r) => [r.headM, r.flowLpm, r.inputKw].every((v) => v !== null && Number.isFinite(v)));
  // Two points at least, as the database requires; none at all removes the curve.
  const shapeOk = (rows ?? []).length === 0 || ((rows ?? []).length >= 2 && complete && !!source.trim());
  const set = (i: number, patch: Partial<PointRow>) => { setSaved(false); setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r))); };

  const applyPaste = () => {
    const parsed = (paste ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      // Rows copied from a spreadsheet are tab-separated, and a cell may read "4,250": split
      // on tabs when there are any, and only otherwise on commas, semicolons or spaces.
      .map((line) => (line.includes('\t') ? line.split('\t') : line.split(/[,;\s]+/))
        .map((x) => Number(x.replace(/[^0-9.+-]/g, ''))))
      .filter((n) => n.length >= 3 && n.slice(0, 3).every((x) => Number.isFinite(x)))
      .map((n) => ({ headM: n[0], flowLpm: n[1], inputKw: n[2] }));
    if (parsed.length) { setRows(parsed); setSaved(false); }
    setPaste(null);
  };

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const out = await apiReplaceDutyCurve(scope, modelId, {
        source: source.trim(), points: rows.map((r) => ({ headM: r.headM!, flowLpm: r.flowLpm!, inputKw: r.inputKw! }) as DutyCurvePoint),
      });
      setRows(out.points.map((p) => ({ headM: p.headM, flowLpm: p.flowLpm, inputKw: p.inputKw })));
      setSaved(true);
    } catch { /* toast */ } finally { setBusy(false); }
  };

  if (rows === null) return <Skeleton lines={3} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('models.curveHint')}</p>
      <label className="block">
        <span className={label}>{t('models.curveSource')} {rows.length > 0 && <span className="text-rose-500">*</span>}</span>
        <Input size="sm" value={source} onChange={(v) => { setSource(v); setSaved(false); }} disabled={!canEdit} placeholder={t('models.sourcePlaceholder')} />
      </label>
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
        <span>{t('models.headM')}</span><span>{t('models.flowLpm')}</span><span>{t('models.inputKw')}</span><span className="w-7" />
      </div>
      {rows.length === 0 && <p className="text-sm text-slate-400">{t('models.noCurve')}</p>}
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
            {(['headM', 'flowLpm', 'inputKw'] as const).map((k) => (
              <InputNumber key={k} size="sm" value={r[k] ?? ''} disabled={!canEdit}
                onChange={(v) => set(i, { [k]: v === '' || v === null ? null : Number(v) })} />
            ))}
            {canEdit ? (
              <button onClick={() => { setSaved(false); setRows((rs) => rs!.filter((_, j) => j !== i)); }} title={t('models.removeRow')}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 cursor-pointer"><X className="w-4 h-4" /></button>
            ) : <span className="w-7" />}
          </div>
        ))}
      </div>
      {paste !== null && (
        <div className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
          <span className={label}>{t('models.pasteLabel')}</span>
          <Input as="textarea" rows={5} value={paste} onChange={setPaste} placeholder={'6\t70.8\t0.98\n18\t53.3\t1.02\n50\t15\t1.05'} className="font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setPaste(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs cursor-pointer">{t('classRequests.cancel')}</button>
            <button onClick={applyPaste} className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold cursor-pointer">{t('models.usePasted')}</button>
          </div>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setSaved(false); setRows((rs) => [...rs!, { headM: null, flowLpm: null, inputKw: null }]); }}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
              <Plus className="w-3.5 h-3.5" /> {t('models.addPoint')}
            </button>
            <button onClick={() => setPaste('')}
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
              <ClipboardPaste className="w-3.5 h-3.5" /> {t('models.paste')}
            </button>
          </div>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('models.saved')}</span>}
            {!shapeOk && <span className="text-xs text-amber-600 dark:text-amber-400">{t('models.curveIncomplete')}</span>}
            <button onClick={() => void save()} disabled={!shapeOk || busy}
              className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
              {rows.length ? t('models.saveCurve') : t('models.removeCurve')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
