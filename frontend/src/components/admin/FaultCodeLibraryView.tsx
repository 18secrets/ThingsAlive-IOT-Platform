import React, { useEffect, useRef, useState } from 'react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertCircle, Archive, ArchiveRestore, Download, Edit2, Eye, History, Plus, Search, Upload } from 'lucide-react';
import {
  ApiError, FAULT_CODE_TYPES, FaultCodeGrant, FaultCodeImport, FaultCodeInput, FaultCodeItem, FaultCodeRevision, FaultCodeType,
  apiCreateFaultCode, apiDownloadFaultCodeTemplate, apiFaultCodeHistory, apiImportFaultCodes, apiGrantFaultCodeType, apiListFaultCodeGrants, apiListFaultCodes,
  apiRevokeFaultCodeGrant, apiSetFaultCodeRetired, apiUpdateFaultCode,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthProvider';
import { staffMay } from '../../lib/pageAccess';
import { appLocale, appTimeZone } from '../../lib/dateLocale';
import { ClientAccount } from '../../types';
import { Chip, ChipTone } from '../common/Chip';
import { ListTable } from '../common/ListTable';
import { Modal } from '../common/Modal';
import { RecordCards } from '../common/RecordCards';
import { Skeleton } from '../common/Skeleton';
import { LIST_PANEL, TablePagination, usePagination } from '../common/TablePagination';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

type Section = FaultCodeType | 'access';
const SECTIONS: Section[] = [...FAULT_CODE_TYPES, 'access'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const LAMPS = ['red_stop', 'amber_warning', 'protect', 'mil', 'none'];
// The chip's colour follows the lamp, as on the machine page: a warning is amber.
const SEVERITY_TONE: Record<string, ChipTone> = { critical: 'rose', high: 'amber', medium: 'amber', low: 'sky', info: 'slate' };

const label = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1';
const MUTED = 'text-slate-500 dark:text-slate-400';
const ACTION = 'p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 cursor-pointer';

/**
 * The fault code library under Administration (17 Nov 2026): vehicle codes (1.0's copy,
 * read-only here, and codes 2.0 adds), motor codes (2.0's own), and which kinds each
 * account sees. Fetches its own data, like Telemetry Archive and Models beside it.
 *
 * Who may do what is the server's: the library's editors write codes (catalog.write),
 * Master Admin gives accounts their kinds (entitlement.grant). A role without one sees
 * the codes and no buttons the server would refuse.
 */
export const FaultCodeLibraryView: React.FC<{ clients: ClientAccount[] }> = ({ clients }) => {
  const { t } = useTranslation('admin');
  const { authUser } = useAuth();
  // Opens on the first section, as every tabbed page does.
  const [section, setSection] = useState<Section>(SECTIONS[0]);
  const canEdit = staffMay(authUser, 'catalog.write');
  const canGrant = staffMay(authUser, 'entitlement.grant');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('tabs.faultCodes')}>
        {SECTIONS.filter((s) => s !== 'access' || canGrant).map((s) => (
          <button key={s} role="tab" aria-selected={section === s} onClick={() => setSection(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${section === s
              ? 'bg-sky-600 text-white' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
            {t(`faultCodes.section.${s}`)}
          </button>
        ))}
      </div>
      {section === 'access'
        ? <AccessView clients={clients} />
        : <CodesView key={section} type={section} canEdit={canEdit} />}
    </div>
  );
};

/** One kind's codes, searched and paged on the server: 1.0's vehicle list runs to thousands. */
const CodesView: React.FC<{ type: FaultCodeType; canEdit: boolean }> = ({ type, canEdit }) => {
  const { t } = useTranslation('admin');
  const { t: ts } = useTranslation('shared');
  const [viewMode, setViewMode] = useViewMode('fault-codes');
  const [query, setQuery] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState<{ total: number; codes: FaultCodeItem[] } | null>(null);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<{ code: FaultCodeItem | null; tab: 'details' | 'history' } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const download = async () => {
    try {
      const url = URL.createObjectURL(await apiDownloadFaultCodeTemplate(type));
      const a = document.createElement('a');
      a.href = url; a.download = `fault-codes-${type}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('faultCodes.import.templateFailed'));
    }
  };

  const load = () => apiListFaultCodes(type, { q: query.trim() || undefined, limit: pageSize, offset: (page - 1) * pageSize, includeRetired: showRetired })
    .then((d) => { setData(d); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('faultCodes.loadFailed')));
  useEffect(() => { void load(); }, [type, query, showRetired, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = data?.total ?? 0;
  const motor = type === 'motor-pump';
  // Vehicle codes are 1.0's, sent here every day: their tabs are for reading (17 Nov).
  // Adding and importing are for motor codes, which only 2.0 holds. The API still takes a
  // 2.0 vehicle code, for the day a vehicle device reports to 2.0 itself.
  const canWrite = canEdit && motor;
  const columns = [
    { label: t('faultCodes.col.code'), width: 150 },
    { label: t('faultCodes.col.fault'), grow: 3, minWidth: 180 },
    { label: t('faultCodes.field.causes'), grow: 3, minWidth: 180 },
    { label: t('faultCodes.col.severity'), width: 110 },
    { label: t('faultCodes.col.source'), width: 100 },
    { label: ts('listCol.actions'), width: 128, align: 'right' as const },
  ];
  // A retired code is marked beside its code and greyed, never by a third line under its
  // fault: that one taller row stood out of the table (17 Nov).
  // `card`: the same cells for a card, which has the room the table does not: the
  // symptom and causes whole rather than cut to a line or two, and the buttons at the
  // card's foot from the left, as every other card's are.
  const cells = (c: FaultCodeItem, card = false) => [
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={`font-mono text-xs break-all ${c.retiredAt ? MUTED : 'text-slate-700 dark:text-slate-200'}`}>{c.code}</span>
      {c.retiredAt && <Chip tone="slate">{t('faultCodes.retired')}</Chip>}
    </span>,
    <span className="min-w-0 block">
      <span className={`block text-sm break-words ${c.retiredAt ? MUTED : 'text-slate-800 dark:text-slate-100'}`}>{c.description}</span>
      {motor && c.symptom && <span className={`block text-xs ${MUTED} break-words ${card ? '' : 'line-clamp-1'}`} title={c.symptom}>{c.symptom}</span>}
    </span>,
    // Two lines, so one long cause does not make its row twice the others; the dialog has it whole.
    <span className={`block text-xs ${MUTED} break-words ${card ? '' : 'line-clamp-2'}`} title={c.causes ?? undefined}>{c.causes ?? '—'}</span>,
    <Chip tone={SEVERITY_TONE[c.severity] ?? 'slate'}>{t(`faultCodes.severity.${c.severity}`, { defaultValue: c.severity })}</Chip>,
    <Chip tone={c.source === '1.0' ? 'slate' : 'sky'}>{t(`faultCodes.source.${c.source === '1.0' ? 'v1' : 'v2'}`)}</Chip>,
    <div className={`flex items-center gap-1.5 ${card ? '' : 'justify-end'}`}>
      <button onClick={() => setOpen({ code: c, tab: 'details' })} title={canEdit && c.source === '2.0' ? t('faultCodes.edit') : t('faultCodes.view')}
        aria-label={canEdit && c.source === '2.0' ? t('faultCodes.edit') : t('faultCodes.view')} className={ACTION}>
        {canEdit && c.source === '2.0' ? <Edit2 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      {/* 1.0's codes are edited in 1.0: they have no history here, and are not retired here. */}
      {c.source === '2.0' && (
        <button onClick={() => setOpen({ code: c, tab: 'history' })} title={t('faultCodes.tab.history')} aria-label={t('faultCodes.tab.history')} className={ACTION}>
          <History className="w-3.5 h-3.5" />
        </button>
      )}
      {canEdit && c.source === '2.0' && (
        <button onClick={() => void setRetired(c, !c.retiredAt)} disabled={busyId === c.id}
          title={c.retiredAt ? t('faultCodes.restore') : t('faultCodes.retire')} aria-label={c.retiredAt ? t('faultCodes.restore') : t('faultCodes.retire')}
          className={`${ACTION} ${c.retiredAt ? '' : 'hover:text-rose-600! hover:border-rose-300!'} disabled:opacity-50`}>
          {c.retiredAt ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>,
  ];

  // Cards read differently from rows (17 Nov, from the screenshots): the fault is the
  // card's title with its code and severity above it, the symptom is a labelled line of
  // its own, and Source only appears where it varies (vehicle codes; every motor code is
  // 2.0's). The table keeps its columns.
  // Vehicle codes also say which unit raised them and the maker's own code (1.0's
  // source_type and dtc_code): a System column after Code, and the maker's code under it.
  const systemCell = (c: FaultCodeItem) => <span className="text-xs text-slate-700 dark:text-slate-200 break-words">{c.system ?? '—'}</span>;
  const tableColumns = motor ? columns : [columns[0], { label: t('faultCodes.field.system'), width: 120 }, ...columns.slice(1)];
  const tableCells = (c: FaultCodeItem) => {
    const row = cells(c);
    if (motor) return row;
    const code = (
      <span className="block space-y-0.5">
        {row[0]}
        {c.oemCode && <span className={`block text-xs ${MUTED} break-all`}>{t('faultCodes.field.oemCode')}: {c.oemCode}</span>}
      </span>
    );
    return [code, systemCell(c), ...row.slice(1)];
  };

  const cardColumns = [
    { label: t('faultCodes.col.fault') },
    ...(motor ? [{ label: t('faultCodes.field.symptom') }] : [{ label: t('faultCodes.field.system') }, { label: t('faultCodes.field.oemCode') }]),
    { label: t('faultCodes.field.causes') },
    ...(motor ? [] : [{ label: t('faultCodes.col.source') }]),
    { label: ts('listCol.actions') },
  ];
  const cardCells = (c: FaultCodeItem) => {
    const row = cells(c, true);
    return [
      <span className="block space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`font-mono text-xs ${MUTED}`}>{c.code}</span>
          <Chip tone={SEVERITY_TONE[c.severity] ?? 'slate'}>{t(`faultCodes.severity.${c.severity}`, { defaultValue: c.severity })}</Chip>
          {c.retiredAt && <Chip tone="slate">{t('faultCodes.retired')}</Chip>}
        </span>
        <span className={`block text-sm font-semibold break-words ${c.retiredAt ? MUTED : 'text-slate-900 dark:text-white'}`}>{c.description}</span>
      </span>,
      ...(motor ? [<span className="break-words">{c.symptom ?? '—'}</span>] : [systemCell(c), <span className="font-mono text-xs break-all">{c.oemCode ?? '—'}</span>]),
      row[2],
      ...(motor ? [] : [row[4]]),
      row[5],
    ];
  };

  // Retiring takes a code away from every account given it, so it is confirmed; restoring is not.
  const setRetired = async (c: FaultCodeItem, retired: boolean) => {
    if (retired && !window.confirm(t('faultCodes.retireConfirm', { code: c.code }))) return;
    setBusyId(c.id);
    try { await apiSetFaultCodeRetired(type, c.id, retired); await load(); } catch { /* the red toast says why */ } finally { setBusyId(null); }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
          <Input size="sm" value={query} onChange={(v) => { setQuery(v); setPage(1); }} placeholder={t('faultCodes.search')}
            aria-label={t('faultCodes.search')} className="w-full pl-9!" />
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
          {/* Retiring is 2.0's: 1.0 decides which of its vehicle codes are in use. */}
          {motor && (
            <label className={`inline-flex items-center gap-2 text-xs ${MUTED} cursor-pointer`}>
              <input id={`fault-codes-retired-${type}`} type="checkbox" checked={showRetired} onChange={(e) => { setShowRetired(e.target.checked); setPage(1); }} />
              {t('faultCodes.showRetired')}
            </label>
          )}
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          {canWrite && (
            <>
              <button onClick={() => void download()} title={t('faultCodes.import.template')}
                className="flex-1 sm:flex-none px-4 py-2.5 border border-[#0B7285] text-[#0B7285] dark:text-sky-400 dark:border-sky-700 hover:bg-[#0B7285]/5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer">
                <Download className="w-4 h-4" /> {t('faultCodes.import.template')}
              </button>
              <button onClick={() => setImporting(true)}
                className="flex-1 sm:flex-none px-4 py-2.5 border border-[#0B7285] text-[#0B7285] dark:text-sky-400 dark:border-sky-700 hover:bg-[#0B7285]/5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer">
                <Upload className="w-4 h-4" /> {t('faultCodes.import.open')}
              </button>
            </>
          )}
          {canWrite && (
            <button id="new-fault-code-btn" onClick={() => setOpen({ code: null, tab: 'details' })}
              className="flex-1 sm:flex-none px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer">
              <Plus className="w-4 h-4" /> {t('faultCodes.add')}
            </button>
          )}
        </div>
      </div>
      {type !== 'motor-pump' && <p className={`text-xs ${MUTED}`}>{t('faultCodes.vehicleHint')}</p>}

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className={LIST_PANEL}>
        {data === null ? <Skeleton lines={4} className="p-4" /> : data.codes.length === 0 ? (
          <p className={`p-6 text-center text-sm ${MUTED}`}>{t('faultCodes.empty')}</p>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={tableColumns} rows={data.codes} rowKey={(c) => c.id} cells={tableCells} />
        ) : (
          <div className="p-4"><RecordCards columns={cardColumns} rows={data.codes} rowKey={(c) => c.id} cells={cardCells} actionsIndex={cardColumns.length - 1} /></div>
        )}
        {total > 0 && (
          <TablePagination pinToBottom page={page} setPage={setPage} pageSize={pageSize}
            setPageSize={(n) => { setPageSize(n); setPage(1); }} total={total} totalPages={Math.max(1, Math.ceil(total / pageSize))} />
        )}
      </div>

      {importing && <ImportModal type={type} onClose={() => setImporting(false)} onApplied={() => void load()} />}

      {open && (
        open.tab === 'history' && open.code ? (
          <Modal isOpen onClose={() => setOpen(null)} title={open.code.code} subtitle={t('faultCodes.tab.history')} maxWidth="max-w-xl">
            <HistoryList type={type} id={open.code.id} />
          </Modal>
        ) : (
          <CodeModal type={type} code={open.code} canEdit={canEdit}
            onClose={() => setOpen(null)} onSaved={(c) => { setOpen({ code: c, tab: 'details' }); void load(); }} />
        )
      )}
    </div>
  );
};

/** One code's fields. Retiring and its history are the row's own actions, not this form's. */
const CodeModal: React.FC<{
  type: FaultCodeType; code: FaultCodeItem | null; canEdit: boolean;
  onClose: () => void; onSaved: (c: FaultCodeItem) => void;
}> = ({ type, code, canEdit, onClose, onSaved }) => {
  const { t } = useTranslation('admin');
  return (
    <Modal isOpen onClose={onClose} title={code ? code.code : t('faultCodes.modalNew')} subtitle={t(`faultCodes.section.${type}`)} maxWidth="max-w-2xl">
      <CodeForm type={type} code={code} canEdit={canEdit} onSaved={onSaved} />
    </Modal>
  );
};

const CodeForm: React.FC<{ type: FaultCodeType; code: FaultCodeItem | null; canEdit: boolean; onSaved: (c: FaultCodeItem) => void }> = ({
  type, code, canEdit, onSaved,
}) => {
  const { t } = useTranslation('admin');
  const motor = type === 'motor-pump';
  // 1.0's codes are edited in 1.0 and copied here daily: shown, never editable.
  const editable = canEdit && (!code || code.source === '2.0');
  const [key, setKey] = useState(code?.code ?? '');
  const [spn, setSpn] = useState<number | null>(code?.spn ?? null);
  const [fmi, setFmi] = useState<number | null>(code?.fmi ?? null);
  const [form, setForm] = useState<FaultCodeInput>({
    description: code?.description ?? '', symptom: code?.symptom ?? '', causes: code?.causes ?? '', remedies: code?.remedies ?? '',
    detection: code?.detection ?? '', foundBy: code?.foundBy ?? null, severity: code?.severity ?? 'medium', lamp: code?.lamp ?? 'none',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<FaultCodeInput>) => { setSaved(false); setForm((f) => ({ ...f, ...patch })); };

  const keyReady = code || (type === 'vehicle-j1939' ? spn !== null && fmi !== null : key.trim().length > 0);
  const ready = editable && keyReady && !!form.description?.trim() && !busy;

  const save = async () => {
    setBusy(true);
    try {
      // Vehicle codes carry no motor fields; an edit sends what the form shows.
      const body: FaultCodeInput = motor ? form : { description: form.description, causes: form.causes, remedies: form.remedies, severity: form.severity, lamp: form.lamp };
      const result = code
        ? await apiUpdateFaultCode(type, code.id, body)
        : await apiCreateFaultCode(type, { ...body, ...(type === 'vehicle-j1939' ? { spn, fmi } : { code: key.trim() }) });
      setSaved(true);
      onSaved(result);
    } catch { /* the red toast says why */ } finally { setBusy(false); }
  };

  const text = (field: 'description' | 'symptom' | 'causes' | 'remedies' | 'detection', rows = 2, required = false) => (
    <label className="block">
      <span className={label}>{t(`faultCodes.field.${field}`)}{required && <span className="text-rose-500"> *</span>}</span>
      <Input as="textarea" rows={rows} value={(form[field] as string) ?? ''} onChange={(v) => set({ [field]: v })} disabled={!editable} />
    </label>
  );

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
      {code && !motor && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className={MUTED}>{t('faultCodes.field.system')}</dt><dd className="text-slate-700 dark:text-slate-200 break-words">{code.system ?? '—'}</dd>
          <dt className={MUTED}>{t('faultCodes.field.oemCode')}</dt><dd className="font-mono text-slate-700 dark:text-slate-200 break-all">{code.oemCode ?? '—'}</dd>
        </dl>
      )}
      {code?.source === '1.0' && (
        <p className="text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-3 py-2 text-slate-600 dark:text-slate-300">
          {t('faultCodes.readOnly10')}
        </p>
      )}
      {!code && (type === 'vehicle-j1939' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className={label}>{t('faultCodes.field.spn')} <span className="text-rose-500">*</span></span>
            <InputNumber value={spn ?? ''} min={0} onChange={(v) => setSpn(v === '' || v === null ? null : Number(v))} /></label>
          <label className="block"><span className={label}>{t('faultCodes.field.fmi')} <span className="text-rose-500">*</span></span>
            <InputNumber value={fmi ?? ''} min={0} max={31} onChange={(v) => setFmi(v === '' || v === null ? null : Number(v))} /></label>
        </div>
      ) : (
        <label className="block">
          <span className={label}>{t('faultCodes.field.code')} <span className="text-rose-500">*</span></span>
          <Input value={key} onChange={setKey} placeholder={t(motor ? 'faultCodes.codeHintMotor' : 'faultCodes.codeHintObd2')} />
        </label>
      ))}
      {text('description', 1, true)}
      {motor && text('symptom')}
      {text('causes')}
      {text('remedies')}
      {motor && text('detection')}
      <div className={`grid grid-cols-1 ${motor ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-3`}>
        {/* Divs, not labels: a label hands its click to the picker again and it closes. */}
        <div><span className={label}>{t('faultCodes.field.severity')}</span>
          <SelectPicker block searchable={false} cleanable={false} disabled={!editable} value={form.severity}
            data={SEVERITIES.map((s) => ({ label: t(`faultCodes.severity.${s}`), value: s }))} onChange={(v) => set({ severity: v ?? 'medium' })} /></div>
        <div><span className={label}>{t('faultCodes.field.lamp')}</span>
          <SelectPicker block searchable={false} cleanable={false} disabled={!editable} value={form.lamp}
            data={LAMPS.map((l) => ({ label: t(`faultCodes.lamp.${l}`), value: l }))} onChange={(v) => set({ lamp: v ?? 'none' })} /></div>
        {motor && (
          <div><span className={label}>{t('faultCodes.field.foundBy')}</span>
            <SelectPicker block searchable={false} disabled={!editable} value={form.foundBy}
              data={(['logger', 'technician'] as const).map((f) => ({ label: t(`faultCodes.foundBy.${f}`), value: f }))}
              onChange={(v) => set({ foundBy: v ?? null })} /></div>
        )}
      </div>
      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('faultCodes.saved')}</span>}
            <button type="submit" disabled={!ready}
              className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
              {code ? t('faultCodes.save') : t('faultCodes.create')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
};

const STATUS_TONE: Record<string, ChipTone> = { new: 'emerald', changed: 'sky', unchanged: 'slate', error: 'rose' };

/** A stored value in the screen's own words: "high" is Warning, "amber_warning" Amber warning. */
const shownValue = (t: TFunction, field: string, value: string | null) => {
  if (value === null) return '—';
  if (field === 'severity') return t(`faultCodes.severity.${value}`, { defaultValue: value });
  if (field === 'lamp') return t(`faultCodes.lamp.${value}`, { defaultValue: value });
  if (field === 'found_by') return t(`faultCodes.foundBy.${value}`, { defaultValue: value });
  return value;
};

/**
 * Bulk import: choose the workbook and it is checked at once, row by row; Apply writes it
 * only when no row is in error and something would change. Nothing is written by a check.
 */
const ImportModal: React.FC<{ type: FaultCodeType; onClose: () => void; onApplied: () => void }> = ({ type, onClose, onApplied }) => {
  const { t } = useTranslation('admin');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<FaultCodeImport | null>(null);
  const [applied, setApplied] = useState<FaultCodeImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (step: 'check' | 'apply', f: File) => {
    setBusy(true); setError(undefined);
    try {
      const result = await apiImportFaultCodes(type, step, f);
      if (step === 'apply' && result.applied) { setApplied(result); onApplied(); } else setPlan(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('faultCodes.import.failed'));
    } finally { setBusy(false); }
  };
  const choose = (f: File) => { setFile(f); setPlan(null); setApplied(null); void run('check', f); };

  const toChange = plan ? plan.summary.new + plan.summary.changed : 0;
  const canApply = !!plan && !!file && plan.summary.errors === 0 && toChange > 0 && !busy;
  const shown = (plan?.rows ?? []).filter((r) => r.status !== 'unchanged');

  return (
    <Modal isOpen onClose={onClose} title={t('faultCodes.import.title')} subtitle={t(`faultCodes.section.${type}`)} maxWidth="max-w-2xl">
      <div className="space-y-4 text-sm">
        <p className={`text-xs ${MUTED}`}>{t('faultCodes.import.hint')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <input id={`fault-code-import-${type}`} ref={fileRef} type="file" accept=".xlsx" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) choose(f); e.target.value = ''; }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60 cursor-pointer">
            <Upload className="w-4 h-4" /> {t('faultCodes.import.choose')}
          </button>
          {file && <span className={`text-xs ${MUTED} break-all`}>{file.name}</span>}
          {busy && <span className={`text-xs ${MUTED}`}>{t('faultCodes.import.checking')}</span>}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{error}</span>
          </div>
        )}

        {applied && (
          <p className="text-xs rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-emerald-700 dark:text-emerald-300">
            {t('faultCodes.import.done', { added: applied.summary.new, changed: applied.summary.changed })}
          </p>
        )}

        {plan && !applied && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="emerald">{t('faultCodes.import.countNew', { count: plan.summary.new })}</Chip>
              <Chip tone="sky">{t('faultCodes.import.countChanged', { count: plan.summary.changed })}</Chip>
              <Chip tone="slate">{t('faultCodes.import.countUnchanged', { count: plan.summary.unchanged })}</Chip>
              <Chip tone={plan.summary.errors ? 'rose' : 'slate'}>{t('faultCodes.import.countErrors', { count: plan.summary.errors })}</Chip>
            </div>
            {plan.summary.errors > 0 && <p className="text-xs text-rose-600 dark:text-rose-400">{t('faultCodes.import.fixErrors')}</p>}
            {plan.summary.errors === 0 && toChange === 0 && <p className={`text-xs ${MUTED}`}>{t('faultCodes.import.nothing')}</p>}
            {shown.length > 0 && (
              <ul className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border border-slate-100 dark:border-slate-800 rounded-lg">
                {shown.map((r) => (
                  <li key={r.row} className="px-3 py-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs ${MUTED} tabular-nums`}>{t('faultCodes.import.row', { n: r.row })}</span>
                      <span className="font-mono text-xs text-slate-700 dark:text-slate-200">{r.code || '—'}</span>
                      <Chip tone={STATUS_TONE[r.status]}>{t(`faultCodes.import.status.${r.status}`)}</Chip>
                    </div>
                    {r.error && <p className="text-xs text-rose-600 dark:text-rose-400 break-words">{r.error}</p>}
                    {r.changes?.map((c) => (
                      <p key={c.field} className={`text-xs ${MUTED} break-words`}>
                        <span className="font-semibold">{t(`faultCodes.historyField.${c.field}`, { defaultValue: c.field })}</span>: {shownValue(t, c.field, c.from)} → {shownValue(t, c.field, c.to)}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold cursor-pointer">
            {applied ? t('faultCodes.import.close') : t('faultCodes.import.cancel')}
          </button>
          {!applied && (
            <button onClick={() => file && void run('apply', file)} disabled={!canApply}
              className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
              {t('faultCodes.import.apply', { count: toChange })}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

/** Who changed which field, from what, and when: newest first. */
const HistoryList: React.FC<{ type: FaultCodeType; id: string }> = ({ type, id }) => {
  const { t } = useTranslation('admin');
  const [rows, setRows] = useState<FaultCodeRevision[] | null>(null);
  useEffect(() => { apiFaultCodeHistory(type, id).then(setRows).catch(() => setRows([])); }, [type, id]);
  if (rows === null) return <Skeleton lines={3} />;
  if (rows.length === 0) return <p className={`text-sm ${MUTED}`}>{t('faultCodes.historyEmpty')}</p>;
  const when = (iso: string) => new Date(iso).toLocaleString(appLocale(), { timeZone: appTimeZone(), dateStyle: 'medium', timeStyle: 'short' });
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((r) => (
        <li key={r.id} className="py-2.5 space-y-0.5">
          <p className="text-sm text-slate-800 dark:text-slate-100 break-words">
            {/* Retiring and restoring are events, said as such; a field edit shows from → to. */}
            {r.field === 'retired' ? (
              <span className="font-semibold">{r.newValue === 'yes' ? t('faultCodes.historyField.retired') : t('faultCodes.historyRestored')}</span>
            ) : (
              <>
                <span className="font-semibold">{t(`faultCodes.historyField.${r.field}`, { defaultValue: r.field })}</span>
                {r.field === 'created' ? '' : `: ${shownValue(t, r.field, r.oldValue)} → ${shownValue(t, r.field, r.newValue)}`}
              </>
            )}
          </p>
          <p className={`text-xs ${MUTED}`}>{t('faultCodes.historyBy', { who: r.changedByName ?? r.changedBy, when: when(r.changedAt) })}</p>
        </li>
      ))}
    </ul>
  );
};

/** Which kinds of code each account sees: a switch per kind, one row per account. */
const AccessView: React.FC<{ clients: ClientAccount[] }> = ({ clients }) => {
  const { t } = useTranslation('admin');
  const [viewMode, setViewMode] = useViewMode('fault-code-access');
  const [grants, setGrants] = useState<FaultCodeGrant[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => apiListFaultCodeGrants()
    .then((g) => { setGrants(g); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('faultCodes.access.loadFailed')));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { pageItems, ...pager } = usePagination(clients);
  const active = (tenantId: string, type: FaultCodeType) => grants?.find((g) => g.tenantId === tenantId && g.codeType === type && !g.revokedAt);
  const toggle = async (client: ClientAccount, type: FaultCodeType) => {
    const grant = active(client.id, type);
    if (grant && !window.confirm(t('faultCodes.access.revokeConfirm', { type: t(`faultCodes.section.${type}`), account: client.clientName }))) return;
    setBusy(`${client.id}:${type}`);
    try {
      if (grant) await apiRevokeFaultCodeGrant(grant.id);
      else await apiGrantFaultCodeType(client.id, type);
      await load();
    } catch { /* toast */ } finally { setBusy(null); }
  };

  const columns = [
    { label: t('faultCodes.access.account'), grow: 2, minWidth: 160 },
    ...FAULT_CODE_TYPES.map((type) => ({ label: t(`faultCodes.section.${type}`), width: 150 })),
  ];
  const cells = (c: ClientAccount) => [
    <span className="font-medium text-slate-800 dark:text-slate-100 break-words">{c.clientName}</span>,
    ...FAULT_CODE_TYPES.map((type) => {
      const on = !!active(c.id, type);
      return (
        <button type="button" role="switch" aria-checked={on} disabled={busy === `${c.id}:${type}`} onClick={() => void toggle(c, type)}
          aria-label={`${t(`faultCodes.section.${type}`)}: ${on ? t('faultCodes.access.granted') : t('faultCodes.access.notGranted')}`}
          className="inline-flex items-center gap-2 cursor-pointer disabled:opacity-50">
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}>
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-4.5' : 'translate-x-1'}`} />
          </span>
          <span className={`text-xs ${MUTED}`}>{on ? t('faultCodes.access.granted') : t('faultCodes.access.notGranted')}</span>
        </button>
      );
    }),
  ];

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className={`text-xs ${MUTED} max-w-2xl`}>{t('faultCodes.access.hint')}</p>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
      <div className={LIST_PANEL}>
        {grants === null && !error ? <Skeleton lines={4} className="p-4" /> : clients.length === 0 ? (
          <p className={`p-6 text-center text-sm ${MUTED}`}>{t('faultCodes.access.noAccounts')}</p>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={columns} rows={pageItems} rowKey={(c) => c.id} cells={cells} />
        ) : (
          <div className="p-4"><RecordCards columns={columns} rows={pageItems} rowKey={(c) => c.id} cells={cells} /></div>
        )}
        {clients.length > 0 && <TablePagination pinToBottom {...pager} />}
      </div>
    </div>
  );
};

