import React, { useEffect, useState } from 'react';
import { AlertCircle, ImageOff, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError, ClassVisual, MAX_VISUAL_BYTES, VISUAL_CONTENT_TYPES, apiConfirmClassVisual, apiDeleteClassVisual,
  apiGetClassVisual, apiRequestClassVisualUpload, apiSetClassAnchors,
} from '../../../lib/api';
import { AnchorEditor } from '../../visual/AnchorEditor';

/** What the browser measured; the API never sees the bytes. An SVG without explicit
 *  size reports 0, so it falls back to a nominal 1000x1000 rather than refusing. */
function measure(file: File, unreadableMessage: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || 1000, height: img.naturalHeight || 1000 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(unreadableMessage)); };
    img.src = url;
  });
}

/**
 * The class's schematic and its signal markers (QREC0c), on one class version. Only a
 * draft takes a new image or new markers; a published version is shown as it stands.
 * Not exercised against real storage in development: ASSET_S3_* is unset locally, which
 * the backend reports as `assets_unavailable` and this panel says in words.
 */
export const ClassVisualPanel: React.FC<{ slug: string; version: number; isDraft: boolean }> = ({ slug, version, isDraft }) => {
  const { t } = useTranslation('catalog');
  const [visual, setVisual] = useState<ClassVisual | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = () => apiGetClassVisual(slug, version)
    .then((v) => { setVisual(v); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('visual.loadFailed')));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [slug, version]);

  async function upload(file: File) {
    if (!VISUAL_CONTENT_TYPES.includes(file.type)) {
      setError(file.type
        ? t('visual.wrongType', { types: VISUAL_CONTENT_TYPES.join(', '), type: file.type })
        : t('visual.unknownType', { types: VISUAL_CONTENT_TYPES.join(', ') }));
      return;
    }
    if (file.size > MAX_VISUAL_BYTES) {
      setError(t('visual.tooLarge', { size: (file.size / 1048576).toFixed(1), limit: MAX_VISUAL_BYTES / 1048576 }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { width, height } = await measure(file, t('visual.unreadable'));
      const target = await apiRequestClassVisualUpload(slug, version, file.type);
      // Straight to storage with the presigned URL — no API token, and the bucket's CORS
      // has to allow PUT from the console's origin.
      const put = await fetch(target.uploadUrl, { method: target.method, headers: target.headers, body: file });
      if (!put.ok) throw new Error(t('visual.storageRefused', { status: put.status }));
      setVisual(await apiConfirmClassVisual(slug, version, width, height));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t('visual.uploadFailed'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(t('visual.confirmRemove'))) return;
    setBusy(true);
    try {
      await apiDeleteClassVisual(slug, version);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('visual.removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  const uploader = (
    <label className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
      <Upload className="w-4 h-4" /> {busy ? t('visual.uploading') : t('visual.upload')}
      <input
        type="file"
        accept={VISUAL_CONTENT_TYPES.join(',')}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }}
      />
    </label>
  );

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{t('visual.title')}</h3>
          <p className="text-xs text-slate-400">
            v{version} · {isDraft ? t('visual.draftEditable') : t('visual.publishedReadOnly')}
          </p>
        </div>
        {isDraft && visual?.state === 'ready' && (
          <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-50 cursor-pointer">
            <Trash2 className="w-3.5 h-3.5" /> {t('visual.remove')}
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {!visual ? (
        !error && <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : visual.state === 'assets_unavailable' ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <ImageOff className="w-4 h-4" />
          {t('visual.storageUnavailable')}
        </div>
      ) : visual.state === 'no_visual' || visual.state === 'upload_pending' ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {visual.state === 'upload_pending' ? t('visual.uploadPending') : t('visual.noImage')}
            {visual.unplacedSignals.length > 0 && ` ${t('visual.unplaced', { count: visual.unplacedSignals.length })}`}
          </p>
          {isDraft ? uploader : <p className="text-xs text-slate-400">{t('visual.draftOnly')}</p>}
        </div>
      ) : visual.imageUrl ? (
        isDraft ? (
          <AnchorEditor
            key={`${visual.classVersion}-${visual.anchors.length}`}
            imageUrl={visual.imageUrl}
            anchors={visual.anchors}
            unplacedSignals={visual.unplacedSignals}
            onSave={async (anchors) => { setVisual(await apiSetClassAnchors(slug, version, anchors)); }}
            note={t('visual.inheritNote')}
          />
        ) : (
          <div className="relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800">
            <img src={visual.imageUrl} alt={t('visual.schematicAlt')} className="w-full h-auto block" />
            {visual.anchors.map((a) => (
              <span key={a.signal} style={{ left: `${a.hotspotX}%`, top: `${a.hotspotY}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-white/90 text-slate-800 shadow">
                {a.label || a.signal}
              </span>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
};
