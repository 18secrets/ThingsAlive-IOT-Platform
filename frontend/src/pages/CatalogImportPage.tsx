import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Download, Upload, FileSpreadsheet, AlertCircle, CheckCircle2,
  UploadCloud, Layers, Radio,
} from 'lucide-react';
import {
  ApiError, CatalogImportApplySummary, CatalogImportBatch, CatalogImportDiff,
} from '../lib/api';
import { usePageHeader } from '../lib/PageHeaderContext';

interface CatalogImportPageProps {
  batches: CatalogImportBatch[];
  batchesError?: string;
  onDownloadTemplate: () => Promise<void>;
  onUpload: (file: File) => Promise<{ id: string }>;
  onLoadDiff: (id: string) => Promise<CatalogImportDiff>;
  onApply: (id: string) => Promise<CatalogImportApplySummary>;
}

const STATUS_STYLE: Record<CatalogImportBatch['status'], string> = {
  parsed: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  validated: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  rejected: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  applied: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
};

const ACTION_STYLE: Record<string, string> = {
  create: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  new_version: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  unchanged: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

const ACTION_LABEL: Record<string, string> = {
  create: 'New class',
  new_version: 'New version',
  unchanged: 'Unchanged',
};

export const CatalogImportPage: React.FC<CatalogImportPageProps> = ({
  batches, batchesError, onDownloadTemplate, onUpload, onLoadDiff, onApply,
}) => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [diff, setDiff] = useState<CatalogImportDiff | null>(null);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);
  const [applySummary, setApplySummary] = useState<CatalogImportApplySummary | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [applying, setApplying] = useState(false);

  usePageHeader({
    title: 'Equipment Library Import',
    subtitle: 'Bulk-author classes, scenarios & alert rules from a workbook',
    breadcrumb: 'Equipment Classes',
    onBack: () => navigate('/admin/category'),
  });

  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;

  const openDiff = async (id: string) => {
    setSelectedBatchId(id);
    setApplySummary(null);
    setDiff(null);
    setDiffError(undefined);
    setLoadingDiff(true);
    try {
      setDiff(await onLoadDiff(id));
    } catch (err) {
      setDiffError(err instanceof ApiError ? err.message : 'Could not load the diff for this batch.');
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await onDownloadTemplate();
    } finally {
      setDownloading(false);
    }
  };

  const handleFileChosen = async (file: File) => {
    setUploading(true);
    setUploadError(undefined);
    try {
      const { id } = await onUpload(file);
      await openDiff(id);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Could not upload the workbook.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleApply = async () => {
    if (!selectedBatchId) return;
    setApplying(true);
    setDiffError(undefined);
    try {
      const summary = await onApply(selectedBatchId);
      setApplySummary(summary);
    } catch (err) {
      setDiffError(err instanceof ApiError ? err.message : 'Could not apply this batch.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6" data-purpose="catalog-import">
      <button
        onClick={() => navigate('/admin/category')}
        className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Equipment Classes</span>
      </button>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Equipment Library Import</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xl">
            Download the workbook template, fill it in offline, and upload it here.
            Every upload is reviewed as a dry-run diff before anything is written —
            applying is a separate, explicit step.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-60 flex items-center gap-2"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{downloading ? 'Preparing…' : 'Download Template'}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileChosen(f); }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2.5 rounded-lg bg-[#0B7285] hover:bg-[#095C6B] text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center gap-2"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{uploading ? 'Uploading…' : 'Upload Workbook'}</span>
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{uploadError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* Recent batches */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2 h-fit">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-200 mb-2">Recent Uploads</h3>
          {batchesError && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400">{batchesError}</p>
          )}
          {batches.length === 0 && !batchesError && (
            <p className="text-[11px] text-slate-400 italic">No workbooks uploaded yet.</p>
          )}
          <div className="space-y-1.5">
            {batches.map((b) => (
              <button
                key={b.id}
                onClick={() => openDiff(b.id)}
                className={`w-full text-left p-2.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                  selectedBatchId === b.id
                    ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200 font-medium truncate">
                  <FileSpreadsheet className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{b.filename}</span>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[10px] text-slate-400">{new Date(b.createdAt).toLocaleString()}</span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded border ${STATUS_STYLE[b.status]}`}>
                    {b.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Diff / result panel */}
        <div className="space-y-4">
          {!selectedBatchId && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 shadow-xs text-center text-slate-400 text-sm">
              Upload a workbook, or pick a recent one, to see its dry-run diff here.
            </div>
          )}

          {loadingDiff && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 shadow-xs text-center text-slate-400 text-sm">
              Loading diff…
            </div>
          )}

          {diffError && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{diffError}</span>
            </div>
          )}

          {diff && !loadingDiff && (
            <>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {selectedBatch?.filename ?? 'Batch'}
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">{diff.partialApplyNote}</p>
                  </div>
                  {selectedBatch && (
                    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[selectedBatch.status]}`}>
                      {selectedBatch.status}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                    <Layers className="w-3 h-3 text-sky-600" />
                    <span>{diff.classes.length} classes referenced</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                    <Radio className="w-3 h-3 text-sky-600" />
                    <span>{diff.sensorCapabilities.valid} sensor capabilities valid</span>
                  </div>
                  {diff.rejectedRows.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-medium text-[11px] rounded-md border border-rose-200 dark:border-rose-800">
                      <AlertCircle className="w-3 h-3" />
                      <span>{diff.rejectedRows.length} rows rejected</span>
                    </div>
                  )}
                </div>

                {/* Class-by-class diff */}
                <div className="space-y-1.5">
                  {diff.classes.map((c) => (
                    <div key={c.slug} className="flex items-center justify-between p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-slate-700 dark:text-slate-200">#{c.slug}</span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${ACTION_STYLE[c.action]}`}>
                          {ACTION_LABEL[c.action]}
                        </span>
                      </div>
                      <div className="flex gap-1.5 text-[10px] text-slate-400">
                        {Object.entries(c.countsBySheet).map(([sheet, count]) => (
                          <span key={sheet} className="px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">
                            {sheet}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {diff.classes.length === 0 && (
                    <p className="text-xs text-slate-400 italic">No classes referenced in this workbook.</p>
                  )}
                </div>

                {/* Rejected rows */}
                {diff.rejectedRows.length > 0 && (
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                    <span className="text-xs font-bold text-rose-600 dark:text-rose-400">Rejected rows</span>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {diff.rejectedRows.map((r, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                          <span className="font-mono text-slate-400 shrink-0">{r.sheet}:{r.rowNumber}</span>
                          <span>{r.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedBatch?.status === 'validated' && !applySummary && (
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                    <button
                      onClick={handleApply}
                      disabled={applying}
                      className="px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center gap-2"
                    >
                      <UploadCloud className="w-3.5 h-3.5" />
                      <span>{applying ? 'Applying…' : 'Apply This Batch'}</span>
                    </button>
                  </div>
                )}
              </div>

              {applySummary && (
                <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900 rounded-xl p-5 shadow-xs space-y-3">
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" />
                    <h3 className="text-sm font-semibold">Applied</h3>
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(applySummary.classes).map(([slug, result]) => (
                      <div key={slug} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-slate-700 dark:text-slate-200">#{slug}</span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {ACTION_LABEL[result.action]} · v{result.version} ·{' '}
                          {Object.entries(result.created).map(([k, v]) => `${v} ${k}`).join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                    Sensor capabilities: {applySummary.sensorCapabilities.created} created, {applySummary.sensorCapabilities.skipped} skipped.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
