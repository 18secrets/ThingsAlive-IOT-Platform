import React, { useEffect, useState } from 'react';
import { AlertCircle, ImageOff, Trash2, Upload } from 'lucide-react';
import {
  ApiError, ClassVisual, MAX_VISUAL_BYTES, VISUAL_CONTENT_TYPES, apiConfirmClassVisual, apiDeleteClassVisual,
  apiGetClassVisual, apiRequestClassVisualUpload, apiSetClassAnchors,
} from '../../../lib/api';
import { AnchorEditor } from '../../visual/AnchorEditor';

/** What the browser measured; the API never sees the bytes. An SVG without explicit
 *  size reports 0, so it falls back to a nominal 1000x1000 rather than refusing. */
function measure(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || 1000, height: img.naturalHeight || 1000 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
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
  const [visual, setVisual] = useState<ClassVisual | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = () => apiGetClassVisual(slug, version)
    .then((v) => { setVisual(v); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the visual.'));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [slug, version]);

  async function upload(file: File) {
    if (!VISUAL_CONTENT_TYPES.includes(file.type)) {
      setError(`Use ${VISUAL_CONTENT_TYPES.join(', ')} — this file is ${file.type || 'of an unknown type'}.`);
      return;
    }
    if (file.size > MAX_VISUAL_BYTES) {
      setError(`The image is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_VISUAL_BYTES / 1048576} MB.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { width, height } = await measure(file);
      const target = await apiRequestClassVisualUpload(slug, version, file.type);
      // Straight to storage with the presigned URL — no API token, and the bucket's CORS
      // has to allow PUT from the console's origin.
      const put = await fetch(target.uploadUrl, { method: target.method, headers: target.headers, body: file });
      if (!put.ok) throw new Error(`Storage refused the upload (${put.status}).`);
      setVisual(await apiConfirmClassVisual(slug, version, width, height));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not upload the image.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove this version\'s image and all its markers?')) return;
    setBusy(true);
    try {
      await apiDeleteClassVisual(slug, version);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the image.');
    } finally {
      setBusy(false);
    }
  }

  const uploader = (
    <label className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
      <Upload className="w-4 h-4" /> {busy ? 'Uploading…' : 'Upload image'}
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
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Equipment image &amp; signal markers</h3>
          <p className="text-xs text-slate-400">
            v{version} · {isDraft ? 'draft — editable' : 'published — read-only; start a new draft to change it'}
          </p>
        </div>
        {isDraft && visual?.state === 'ready' && (
          <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-50 cursor-pointer">
            <Trash2 className="w-3.5 h-3.5" /> Remove image
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {!visual ? (
        !error && <p className="text-sm text-slate-500">Loading…</p>
      ) : visual.state === 'assets_unavailable' ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <ImageOff className="w-4 h-4" />
          Image storage is not configured on this server (ASSET_S3_*), so no image can be uploaded or shown.
        </div>
      ) : visual.state === 'no_visual' || visual.state === 'upload_pending' ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {visual.state === 'upload_pending' ? 'An upload was started but never confirmed. Upload the image again.' : 'No image for this version yet.'}
            {visual.unplacedSignals.length > 0 && ` ${visual.unplacedSignals.length} signal(s) are waiting to be placed on it.`}
          </p>
          {isDraft ? uploader : <p className="text-xs text-slate-400">Only a draft version takes an image.</p>}
        </div>
      ) : visual.imageUrl ? (
        isDraft ? (
          <AnchorEditor
            key={`${visual.classVersion}-${visual.anchors.length}`}
            imageUrl={visual.imageUrl}
            anchors={visual.anchors}
            unplacedSignals={visual.unplacedSignals}
            onSave={async (anchors) => { setVisual(await apiSetClassAnchors(slug, version, anchors)); }}
            note="Clients inherit these markers when they take this version; any marker a client moves stays theirs."
          />
        ) : (
          <div className="relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800">
            <img src={visual.imageUrl} alt="Equipment schematic" className="w-full h-auto block" />
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
