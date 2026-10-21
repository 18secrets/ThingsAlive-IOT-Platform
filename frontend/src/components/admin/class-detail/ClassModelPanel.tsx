import React, { useEffect, useState } from 'react';
import { AlertCircle, Box, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError, ClassModel, MAX_VISUAL_BYTES, MODEL_CONTENT_TYPES, apiConfirmClassModel, apiDeleteClassModel,
  apiGetClassModel, apiRequestClassModelUpload, apiSetClassModelAnchors,
} from '../../../lib/api';
import { ModelAnchorEditor, measureModel } from '../../visual/ModelAnchorEditor';

/**
 * The class's 3-D model and its signal markers (QTWIN1), beside the schematic and on
 * its rules: a draft takes a new model and markers, a published version is shown as it
 * stands. On a replacement the uploader says whether the geometry changed; only an
 * unchanged geometry *and* an unchanged box keep every account's markers where they are.
 * Not exercised against real storage in development: ASSET_S3_* is unset locally.
 */
export const ClassModelPanel: React.FC<{ slug: string; version: number; isDraft: boolean }> = ({ slug, version, isDraft }) => {
  const { t } = useTranslation('catalog');
  const [model, setModel] = useState<ClassModel | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [geometryChanged, setGeometryChanged] = useState(true);

  const load = () => apiGetClassModel(slug, version)
    .then((m) => { setModel(m); setError(undefined); })
    .catch((err) => setError(err instanceof ApiError ? err.message : t('model.loadFailed')));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [slug, version]);

  async function upload(file: File) {
    // Browsers report a .glb as "" or application/octet-stream; the extension decides.
    if (!file.name.toLowerCase().endsWith('.glb')) {
      setError(t('model.wrongType'));
      return;
    }
    if (file.size > MAX_VISUAL_BYTES) {
      setError(t('visual.tooLarge', { size: (file.size / 1048576).toFixed(1), limit: MAX_VISUAL_BYTES / 1048576 }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const bounds = await measureModel(file).catch(() => { throw new Error(t('model.unreadable')); });
      const contentType = MODEL_CONTENT_TYPES[0];
      const target = await apiRequestClassModelUpload(slug, version, contentType);
      // Straight to storage with the presigned URL, like the schematic.
      const put = await fetch(target.uploadUrl, { method: target.method, headers: target.headers, body: file });
      if (!put.ok) throw new Error(t('visual.storageRefused', { status: put.status }));
      setModel(await apiConfirmClassModel(slug, version, bounds, model?.state === 'ready' ? geometryChanged : true));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t('model.uploadFailed'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(t('model.confirmRemove'))) return;
    setBusy(true);
    try {
      await apiDeleteClassModel(slug, version);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('model.removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  const uploader = (
    <div className="flex items-center gap-3 flex-wrap">
      <label className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
        <Upload className="w-4 h-4" /> {busy ? t('visual.uploading') : model?.state === 'ready' ? t('model.replace') : t('model.upload')}
        <input
          type="file"
          accept=".glb,model/gltf-binary"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }}
        />
      </label>
      {model?.state === 'ready' && (
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={!geometryChanged} onChange={(e) => setGeometryChanged(!e.target.checked)} />
          {t('model.sameGeometry')}
        </label>
      )}
    </div>
  );

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-base flex items-center gap-2"><Box className="w-4 h-4 text-sky-600" />{t('model.title')}</h3>
          <p className="text-xs text-slate-400">
            v{version} · {isDraft ? t('visual.draftEditable') : t('visual.publishedReadOnly')}
            {model?.geometryVersion != null && ` · ${t('model.geometryVersion', { version: model.geometryVersion })}`}
          </p>
        </div>
        {isDraft && model?.state === 'ready' && (
          <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-300 disabled:opacity-50 cursor-pointer">
            <Trash2 className="w-3.5 h-3.5" /> {t('model.remove')}
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {!model ? (
        !error && <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : model.state === 'assets_unavailable' ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('model.storageUnavailable')}</p>
      ) : model.state === 'no_model' || model.state === 'upload_pending' ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {model.state === 'upload_pending' ? t('visual.uploadPending') : t('model.noModel')}
            {model.unplacedSignals.length > 0 && ` ${t('visual.unplaced', { count: model.unplacedSignals.length })}`}
          </p>
          {isDraft ? uploader : <p className="text-xs text-slate-400">{t('visual.draftOnly')}</p>}
        </div>
      ) : model.modelUrl ? (
        <div className="space-y-3">
          {isDraft && uploader}
          <ModelAnchorEditor
            key={`${model.classVersion}-${model.geometryVersion}-${model.anchors.length}`}
            modelUrl={model.modelUrl}
            bounds={model.bounds}
            anchors={model.anchors}
            unplacedSignals={model.unplacedSignals}
            onSave={isDraft ? async (anchors) => { setModel(await apiSetClassModelAnchors(slug, version, anchors)); } : undefined}
            note={isDraft ? t('model.inheritNote') : undefined}
          />
        </div>
      ) : null}
    </div>
  );
};
