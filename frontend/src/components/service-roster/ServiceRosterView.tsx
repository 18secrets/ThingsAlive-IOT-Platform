import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDown, ArrowUp, Download, Edit2, MapPinned, Plus, Trash2, Upload, X } from 'lucide-react';
import {
  ApiError, Plant, RosterPlan, RosterRegion, TenantUser,
  apiApplyRosterImport, apiDeleteRosterRegion, apiDownloadRosterTemplate, apiGetServiceRoster, apiListPlants,
  apiListTenantUsers, apiPlanRosterImport, apiPutRosterRegion,
} from '../../lib/api';
import { Modal } from '../common/Modal';
import { Chip } from '../common/Chip';
import { Skeleton } from '../common/Skeleton';

/**
 * The service roster (Crompton U5, 11 Nov): which engineer takes a job on a machine. Regions
 * group sites; each region lists its engineers in the order they take a job. The backend
 * routed critical jobs by it since 9 Nov, with no screen to see or keep the roster.
 */
export const ServiceRosterView: React.FC = () => {
  const { t } = useTranslation('workOrders');
  const [regions, setRegions] = useState<RosterRegion[] | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<RosterRegion | 'new' | null>(null);
  const [importing, setImporting] = useState(false);

  const load = () => apiGetServiceRoster()
    .then((r) => { setRegions(r); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('roster.loadFailed')));

  useEffect(() => {
    void load();
    apiListPlants(false).then(setPlants).catch(() => setPlants([]));
    apiListTenantUsers().then(setUsers).catch(() => setUsers([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sites in no region: jobs on their machines stay unassigned, which is worth seeing.
  const uncovered = useMemo(() => {
    const covered = new Set((regions ?? []).flatMap((r) => r.sites.map((s) => s.id)));
    return plants.filter((p) => !covered.has(p.id));
  }, [regions, plants]);

  const remove = async (r: RosterRegion) => {
    if (!window.confirm(t('roster.deleteConfirm', { name: r.name }))) return;
    try { await apiDeleteRosterRegion(r.code); await load(); } catch { /* the toast says why */ }
  };

  const download = async () => {
    try {
      const url = URL.createObjectURL(await apiDownloadRosterTemplate());
      const a = document.createElement('a');
      a.href = url; a.download = 'service-roster-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('roster.templateFailed'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400 flex-1">{t('roster.intro')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void download()}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
            <Download className="w-4 h-4" /> {t('roster.template')}
          </button>
          <button onClick={() => setImporting(true)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer">
            <Upload className="w-4 h-4" /> {t('roster.import')}
          </button>
          <button id="new-region-btn" onClick={() => setEditing('new')}
            className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold inline-flex items-center gap-2 cursor-pointer">
            <Plus className="w-4 h-4" /> {t('roster.newRegion')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {regions && uncovered.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
          {t('roster.uncovered', { count: uncovered.length, sites: uncovered.map((p) => p.code).join(', ') })}
        </p>
      )}

      {regions === null ? <Skeleton lines={4} /> : regions.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
          {t('roster.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {regions.map((r) => (
            <div key={r.code} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-1.5">
                    <MapPinned className="w-4 h-4 text-slate-400 shrink-0" /> {r.name}
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">{r.code}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setEditing(r)} title={t('roster.edit')}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 cursor-pointer"><Edit2 className="w-3.5 h-3.5" /></button>
                  <button onClick={() => void remove(r)} title={t('roster.delete')}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <div>
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400 mb-1">{t('roster.sites', { count: r.sites.length })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {r.sites.length ? r.sites.map((s) => <Chip key={s.id} tone="slate">{s.name}</Chip>) : <span className="text-xs text-slate-400">{t('roster.noSites')}</span>}
                </div>
              </div>
              <div>
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400 mb-1">{t('roster.engineers')}</p>
                {r.engineers.length === 0 ? <span className="text-xs text-slate-400">{t('roster.noEngineers')}</span> : (
                  <ol className="space-y-1">
                    {r.engineers.map((e) => (
                      <li key={e.userId} className="flex items-center gap-2 text-sm">
                        <span className="w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 text-[0.6875rem] font-bold flex items-center justify-center shrink-0">{e.rank}</span>
                        <span className="text-slate-800 dark:text-slate-100 truncate">{e.fullName || e.email}</span>
                        {e.rank === Math.min(...r.engineers.map((x) => x.rank)) && <Chip tone="sky">{t('roster.takesJobs')}</Chip>}
                        {e.status === 'suspended' && <Chip tone="rose">{t('roster.suspended')}</Chip>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <RegionModal region={editing === 'new' ? null : editing} plants={plants} users={users}
          takenCodes={(regions ?? []).map((r) => r.code)}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onApplied={() => { setImporting(false); void load(); }} />}
    </div>
  );
};

const fieldLabel = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1';
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

const RegionModal: React.FC<{
  region: RosterRegion | null; plants: Plant[]; users: TenantUser[]; takenCodes: string[];
  onClose: () => void; onSaved: () => void;
}> = ({ region, plants, users, takenCodes, onClose, onSaved }) => {
  const { t } = useTranslation('workOrders');
  const [code, setCode] = useState(region?.code ?? '');
  const [name, setName] = useState(region?.name ?? '');
  const [siteCodes, setSiteCodes] = useState<string[]>(region?.sites.map((s) => s.code) ?? []);
  // In the order they take a job: the list order is the rank.
  const [engineers, setEngineers] = useState<string[]>(
    region ? [...region.engineers].sort((a, b) => a.rank - b.rank).map((e) => e.email) : [],
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const codeProblem = !region && code.trim() && (!CODE.test(code.trim()) ? t('roster.codeRule') : takenCodes.includes(code.trim()) ? t('roster.codeTaken') : null);
  const valid = !!code.trim() && !codeProblem && !!name.trim();
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const move = (i: number, by: number) => setEngineers((es) => {
    const next = [...es]; const j = i + by;
    if (j < 0 || j >= next.length) return es;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      await apiPutRosterRegion(code.trim(), {
        name: name.trim(), siteCodes, engineers: engineers.map((email, i) => ({ email, rank: i + 1 })),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('roster.saveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={region ? region.name : t('roster.newRegion')} subtitle={t('roster.regionSubtitle')} maxWidth="max-w-xl">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void save(); }}>
        <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-3">
          <label className="block">
            <span className={fieldLabel}>{t('roster.code')} <span className="text-rose-500">*</span></span>
            <Input value={code} onChange={setCode} disabled={!!region} className="font-mono" placeholder="PUNE" />
            {codeProblem && <span className="block text-xs text-rose-600 dark:text-rose-400 mt-1">{codeProblem}</span>}
          </label>
          <label className="block">
            <span className={fieldLabel}>{t('roster.name')} <span className="text-rose-500">*</span></span>
            <Input value={name} onChange={setName} placeholder={t('roster.namePlaceholder')} />
          </label>
        </div>
        {/* Divs, not labels: a label hands its click to a picker again and it closes. */}
        <div>
          <span className={fieldLabel}>{t('roster.sitesLabel')}</span>
          <CheckPicker data={plants.map((p) => ({ label: `${p.name} (${p.code})`, value: p.code }))} value={siteCodes}
            onChange={(v) => setSiteCodes(v ?? [])} block placeholder={t('roster.pickSites')} />
        </div>
        <div>
          <span className={fieldLabel}>{t('roster.engineersLabel')}</span>
          <p className="text-xs text-slate-400 mb-1.5">{t('roster.rankHint')}</p>
          <ol className="space-y-1.5">
            {engineers.map((email, i) => {
              const u = byEmail.get(email);
              return (
                <li key={email} className="flex items-center gap-2 rounded-lg border border-slate-100 dark:border-slate-800 px-2 py-1.5">
                  <span className="w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 text-[0.6875rem] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <span className="text-sm flex-1 min-w-0 truncate">{u?.fullName ?? email} <span className="text-slate-400 text-xs">{email}</span></span>
                  {u?.status === 'suspended' && <Chip tone="rose">{t('roster.suspended')}</Chip>}
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-slate-400 hover:text-sky-600 disabled:opacity-30 cursor-pointer" title={t('roster.up')}><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === engineers.length - 1} className="p-1 text-slate-400 hover:text-sky-600 disabled:opacity-30 cursor-pointer" title={t('roster.down')}><ArrowDown className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => setEngineers((es) => es.filter((x) => x !== email))} className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer" title={t('roster.remove')}><X className="w-3.5 h-3.5" /></button>
                </li>
              );
            })}
          </ol>
          <div className="flex items-center gap-2 mt-2">
            <SelectPicker
              data={users.filter((u) => !engineers.includes(u.email) && u.status !== 'suspended')
                .map((u) => ({ label: `${u.fullName} (${u.email})`, value: u.email }))}
              value={adding} onChange={setAdding} placeholder={t('roster.pickEngineer')} className="flex-1" block
            />
            <button type="button" disabled={!adding || engineers.length >= 20}
              onClick={() => { if (adding) { setEngineers((es) => [...es, adding]); setAdding(null); } }}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold disabled:opacity-50 cursor-pointer shrink-0">
              {t('roster.addEngineer')}
            </button>
          </div>
        </div>
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm cursor-pointer">{t('roster.cancel')}</button>
          <button type="submit" disabled={!valid || busy} className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
            {t('roster.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/** Check first, then replace: the workbook replaces the whole roster, refused whole on any row error. */
const ImportModal: React.FC<{ onClose: () => void; onApplied: () => void }> = ({ onClose, onApplied }) => {
  const { t } = useTranslation('workOrders');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<RosterPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const check = async (f: File) => {
    setFile(f); setPlan(null); setError(undefined); setBusy(true);
    try { setPlan(await apiPlanRosterImport(f)); } catch (err) { setError(err instanceof ApiError ? err.message : t('roster.readFailed')); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!file) return;
    setBusy(true); setError(undefined);
    try { await apiApplyRosterImport(file); onApplied(); } catch (err) { setError(err instanceof ApiError ? err.message : t('roster.applyFailed')); } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('roster.import')} subtitle={t('roster.importSubtitle')} maxWidth="max-w-xl">
      <div className="space-y-3">
        <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="w-full px-4 py-6 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 text-sm text-slate-500 hover:border-sky-300 cursor-pointer">
          {file ? file.name : t('roster.chooseFile')}
        </button>
        {busy && <Skeleton lines={2} />}
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        {plan && (
          <div className="space-y-2">
            <p className={`text-sm font-medium ${plan.valid ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {plan.valid ? t('roster.planOk', { count: plan.regions.length }) : t('roster.planErrors', { count: plan.errors.length })}
            </p>
            <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
              {plan.regions.map((r) => <li key={r.code}>{t('roster.planRegion', { code: r.code, name: r.name, sites: r.sites, engineers: r.engineers })}</li>)}
            </ul>
            {plan.errors.length > 0 && (
              <ul className="text-xs text-rose-600 dark:text-rose-400 space-y-0.5">
                {plan.errors.map((e, i) => <li key={i}>{e.row ? t('roster.row', { row: e.row }) : ''}{e.region ? ` ${e.region}: ` : ''}{e.message}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm cursor-pointer">{t('roster.cancel')}</button>
          <button onClick={() => void apply()} disabled={!plan?.valid || busy}
            className="px-4 py-2 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">
            {t('roster.replace')}
          </button>
        </div>
      </div>
    </Modal>
  );
};
