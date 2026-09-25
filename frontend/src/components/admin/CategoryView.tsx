import React, { useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Wrench,
  Edit2,
  AlertCircle,
  Radio,
  UploadCloud,
  Archive,
  Activity,
} from 'lucide-react';
import { EquipmentClass, EquipmentClassInput } from '../../lib/api';
import { AddCategoryModal } from './AddCategoryModal';

interface CategoryViewProps {
  classes: EquipmentClass[];
  error?: string;
  onCreateClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdateClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onPublishClass: (slug: string) => Promise<void>;
  onRetireClass: (slug: string) => Promise<void>;
  onOpenClass: (slug: string) => void;
  onOpenBulkImport: () => void;
}

const STATUS_STYLE: Record<EquipmentClass['status'], string> = {
  draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  published: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  retired: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

/**
 * One card per slug. `allClasses()` returns every version, sorted slug ASC /
 * version DESC — the draft in progress (if any) is what an editor cares
 * about; otherwise the latest published version; otherwise whatever is left.
 */
function representativePerSlug(rows: EquipmentClass[]): EquipmentClass[] {
  const bySlug = new Map<string, EquipmentClass[]>();
  for (const row of rows) {
    const list = bySlug.get(row.slug) ?? [];
    list.push(row);
    bySlug.set(row.slug, list);
  }
  return Array.from(bySlug.values()).map((versions) =>
    versions.find((v) => v.status === 'draft')
      ?? versions.find((v) => v.status === 'published')
      ?? versions[0]);
}

export const CategoryView: React.FC<CategoryViewProps> = ({
  classes, error, onCreateClass, onUpdateClass, onPublishClass, onRetireClass, onOpenClass,
  onOpenBulkImport,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<EquipmentClass | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const representatives = useMemo(() => representativePerSlug(classes), [classes]);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return representatives.filter((c) =>
      c.name.toLowerCase().includes(term) ||
      c.slug.toLowerCase().includes(term) ||
      (c.category?.toLowerCase().includes(term) ?? false)
    );
  }, [representatives, searchTerm]);

  // Publish/retire report their failure through the `error` prop (App.tsx's
  // handlers already catch and set it) — busySlug here is purely for the
  // per-card spinner while the request is in flight.
  const handlePublish = async (slug: string) => {
    setBusySlug(slug);
    await onPublishClass(slug);
    setBusySlug(null);
  };

  const handleRetire = async (slug: string) => {
    setBusySlug(slug);
    await onRetireClass(slug);
    setBusySlug(null);
  };

  return (
    <div id="category-management-view" className="space-y-6">

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Class Names, Slugs, or Tags..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            onClick={onOpenBulkImport}
            className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors shrink-0 cursor-pointer flex items-center justify-center gap-2"
          >
            <UploadCloud className="w-4 h-4" />
            <span>Bulk Import</span>
          </button>
          <button
            id="add-category-btn"
            onClick={() => {
              setEditingClass(null);
              setIsModalOpen(true);
            }}
            className="flex-1 sm:flex-none px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Class</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Class Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((cls) => (
          <div
            key={cls.slug}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{cls.slug} · v{cls.version}
                </span>

                <button
                  onClick={() => {
                    setEditingClass(cls);
                    setIsModalOpen(true);
                  }}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                  title="Edit (working draft)"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {cls.name}
              </h4>
              {cls.category && (
                <p className="text-[11px] text-slate-400 mt-0.5">{cls.category}</p>
              )}
            </div>

            {cls.description && (
              <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed">
                {cls.description}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Radio className="w-3 h-3 text-sky-600" />
                <span>{cls.expectedSignals.length} Signals</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Wrench className="w-3 h-3 text-sky-600" />
                <span>{cls.failureModes.length} Failure Modes</span>
              </div>
            </div>

            <button
              onClick={() => onOpenClass(cls.slug)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 text-[11px] font-semibold hover:bg-sky-100 dark:hover:bg-sky-950/70 transition-colors cursor-pointer"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Configure Predictive Maintenance</span>
            </button>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[cls.status]}`}>
                {cls.status}
              </span>
              {cls.status === 'draft' && (
                <button
                  onClick={() => handlePublish(cls.slug)}
                  disabled={busySlug === cls.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer disabled:opacity-50"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Publish</span>
                </button>
              )}
              {cls.status === 'published' && (
                <button
                  onClick={() => handleRetire(cls.slug)}
                  disabled={busySlug === cls.slug}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 hover:text-rose-600 cursor-pointer disabled:opacity-50"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Retire</span>
                </button>
              )}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No equipment classes found.</span>
          </div>
        )}
      </div>

      {/* No delete — retiring is the API's only way to stop offering a class;
          accounts that already copied it keep running theirs. */}
      <AddCategoryModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingClass(null);
        }}
        onCreate={onCreateClass}
        onUpdate={onUpdateClass}
        existingClass={editingClass}
      />
    </div>
  );
};
