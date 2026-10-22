import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Edit2, AlertCircle, UploadCloud, FunctionSquare, History } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, NamedFormula, NamedFormulaInput, apiGetNamedFormulaVersions } from '../../lib/api';
import { Modal } from '../common/Modal';
import { TablePagination, usePagination } from '../common/TablePagination';
import { AddNamedFormulaModal } from './AddNamedFormulaModal';

interface NamedFormulaViewProps {
  formulas: NamedFormula[];
  error?: string;
  onCreateFormula: (slug: string, input: NamedFormulaInput) => Promise<NamedFormula>;
  onUpdateFormula: (slug: string, version: number, input: NamedFormulaInput) => Promise<NamedFormula>;
  onPublishFormula: (slug: string, version: number) => Promise<void>;
}

const STATUS_STYLE: Record<NamedFormula['status'], string> = {
  draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  published: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

/** One card per slug — the draft in progress if any, else the latest published
 *  version. Same convention CategoryView uses for equipment classes. */
function representativePerSlug(rows: NamedFormula[]): NamedFormula[] {
  const bySlug = new Map<string, NamedFormula[]>();
  for (const row of rows) {
    const list = bySlug.get(row.slug) ?? [];
    list.push(row);
    bySlug.set(row.slug, list);
  }
  return Array.from(bySlug.values()).map((versions) =>
    versions.find((v) => v.status === 'draft')
      ?? versions.slice().sort((a, b) => b.version - a.version)[0]);
}

export const NamedFormulaView: React.FC<NamedFormulaViewProps> = ({
  formulas, error, onCreateFormula, onUpdateFormula, onPublishFormula,
}) => {
  const { t } = useTranslation('catalog');
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFormula, setEditingFormula] = useState<NamedFormula | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<NamedFormula | null>(null);
  const [publishError, setPublishError] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<'all' | NamedFormula['status']>('all');

  const representatives = useMemo(() => representativePerSlug(formulas), [formulas]);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return representatives.filter((f) => (statusFilter === 'all' || f.status === statusFilter) && (
      f.name.toLowerCase().includes(term) ||
      f.slug.toLowerCase().includes(term) ||
      (f.category?.toLowerCase().includes(term) ?? false) ||
      (f.description?.toLowerCase().includes(term) ?? false)));
  }, [representatives, searchTerm, statusFilter]);

  const handlePublish = async (f: NamedFormula) => {
    setBusySlug(f.slug);
    setPublishError((prev) => { const next = { ...prev }; delete next[f.slug]; return next; });
    try {
      await onPublishFormula(f.slug, f.version);
    } catch (err) {
      setPublishError((prev) => ({ ...prev, [f.slug]: err instanceof ApiError ? err.message : t('formulas.publishFailed') }));
    } finally {
      setBusySlug(null);
    }
  };

  const { pageItems: pagedFormulas, ...pager } = usePagination(filtered);

  return (
    <div id="named-formula-management-view" className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Filters stay together on the left; actions sit on the right. */}
        <div className="flex flex-1 flex-col sm:flex-row sm:items-center gap-3 w-full min-w-0">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input size="sm" value={searchTerm} onChange={(value) => setSearchTerm(value)} placeholder={t('formulas.searchPlaceholder')} className="w-full pl-9!" />
        </div>
        <SelectPicker
          data={[{ label: t('common.allStatuses'), value: 'all' }, { label: t('common.statusLabel.draft'), value: 'draft' }, { label: t('common.statusLabel.published'), value: 'published' }]}
          value={statusFilter}
          onChange={(v) => setStatusFilter((v ?? 'all') as typeof statusFilter)}
          searchable={false}
          cleanable={false}
          size="sm"
          className="w-full sm:w-36"
        />
        </div>

        <button
          onClick={() => { setEditingFormula(null); setIsModalOpen(true); }}
          className="px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('formulas.newFormula')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pagedFormulas.map((f) => (
          <div key={f.slug} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{f.slug} · v{f.version}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setHistoryOf(f)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title={t('formulas.versionHistory')}
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setEditingFormula(f); setIsModalOpen(true); }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title={f.status === 'published' ? t('formulas.viewPublished') : t('classes.editDraft')}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">{f.name}</h4>
              {f.category && <p className="text-[11px] text-slate-400 mt-0.5">{f.category}</p>}
            </div>

            {f.description && <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed">{f.description}</p>}

            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700 w-fit">
              <FunctionSquare className="w-3 h-3 text-sky-600 shrink-0" />
              <span className="truncate">{f.expression}</span>
            </div>
            <p className="text-[11px] text-slate-400">{t('formulas.roleCount', { count: f.inputs.length })} · {f.resultDimension ?? (f.resultUnit ? t('formulas.unit', { unit: f.resultUnit }) : t('formulas.dimensionInferred'))}</p>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[f.status]}`}>
                {t(`common.status.${f.status}`, { defaultValue: f.status })}
              </span>
              {f.status === 'draft' && (
                <button
                  onClick={() => handlePublish(f)}
                  disabled={busySlug === f.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer disabled:opacity-50"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>{t('common.publish')}</span>
                </button>
              )}
            </div>
            {publishError[f.slug] && (
              <div className="flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-2 py-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{t('formulas.notPublished', { error: publishError[f.slug] })}</span>
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>{t('formulas.noneFound')}</span>
          </div>
        )}
      </div>
      {filtered.length > 0 && <TablePagination bare {...pager} />}

      <AddNamedFormulaModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingFormula(null); }}
        onCreate={onCreateFormula}
        onUpdate={onUpdateFormula}
        existingFormula={editingFormula}
      />

      <Modal
        isOpen={!!historyOf}
        onClose={() => setHistoryOf(null)}
        title={t('formulas.versionHistory')}
        subtitle={historyOf ? `${historyOf.name} · #${historyOf.slug}` : undefined}
        maxWidth="max-w-2xl"
      >
        {historyOf && <FormulaVersions key={historyOf.slug} slug={historyOf.slug} />}
      </Modal>
    </div>
  );
};

/** Every version of one formula, newest first. Published versions are immutable, so
 *  this is where an older expression a class may still be bound to can be read. */
const FormulaVersions: React.FC<{ slug: string }> = ({ slug }) => {
  const { t } = useTranslation('catalog');
  const [versions, setVersions] = useState<NamedFormula[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    apiGetNamedFormulaVersions(slug)
      .then((v) => { if (live) setVersions(v); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('formulas.historyFailed')); });
    return () => { live = false; };
  }, [slug]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!versions) return <p className="text-sm text-slate-500">{t('common.loading')}</p>;

  return (
    <ol className="space-y-2.5">
      {versions.map((v) => (
        <li key={v.id} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">v{v.version}</span>
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[v.status]}`}>
                {t(`common.status.${v.status}`, { defaultValue: v.status })}
              </span>
            </div>
            <span className="text-[11px] text-slate-400">
              {v.publishedAt ? t('formulas.publishedAt', { date: new Date(v.publishedAt).toLocaleString() }) : t('formulas.lastEdited', { date: new Date(v.updatedAt).toLocaleString() })}
            </span>
          </div>
          {v.name !== versions[0].name && <p className="text-xs text-slate-600 dark:text-slate-300">{v.name}</p>}
          <div className="flex items-start gap-1.5 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
            <FunctionSquare className="w-3 h-3 text-sky-600 shrink-0 mt-0.5" />
            <span className="break-all">{v.expression}</span>
          </div>
          <p className="text-[11px] text-slate-400">
            {v.inputs.length ? v.inputs.map((i) => `${i.role} (${i.dimension})`).join(', ') : t('formulas.noInputRoles')}
            {' · '}
            {v.resultDimension ?? (v.resultUnit ? t('formulas.unit', { unit: v.resultUnit }) : t('formulas.dimensionInferred'))}
          </p>
        </li>
      ))}
      {versions.length === 0 && <p className="text-sm text-slate-400">{t('formulas.noVersions')}</p>}
    </ol>
  );
};
