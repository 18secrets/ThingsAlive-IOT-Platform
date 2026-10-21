import React, { Suspense, lazy, useMemo, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, ModelAnchor, ModelBounds } from '../../lib/api';

const ModelScene = lazy(() => import('./ModelScene'));

/**
 * Places signal markers on a class's 3-D model — the schematic's AnchorEditor in three
 * dimensions. Pick a signal, click the model where it lives (drag to turn the view);
 * the point is in the model's own units. Saved as a whole set, because the backend
 * validates the set, so every change stays local until Save. A marker the geometry
 * changed under is shown in amber and confirmed on its own, as it stands.
 */
export const ModelAnchorEditor: React.FC<{
  modelUrl: string;
  bounds: ModelBounds | null;
  anchors: (ModelAnchor & { placementCustom?: boolean; needsRecheck?: boolean })[];
  unplacedSignals: string[];
  /** Absent: the model is shown read only, markers and all. */
  onSave?: (anchors: ModelAnchor[]) => Promise<void>;
  /** A client's marker the geometry changed under: confirm it is still right. */
  onConfirm?: (signal: string) => Promise<void>;
  note?: string;
}> = ({ modelUrl, bounds, anchors: initial, unplacedSignals, onSave, onConfirm, note }) => {
  const { t } = useTranslation('catalog');
  const [anchors, setAnchors] = useState<ModelAnchor[]>(() => initial.map(({ signal, x, y, z, label }) => ({ signal, x, y, z, label })));
  const [selected, setSelected] = useState<string | null>(unplacedSignals[0] ?? initial[0]?.signal ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const custom = useMemo(() => new Set(initial.filter((a) => a.placementCustom).map((a) => a.signal)), [initial]);
  const recheck = useMemo(() => new Set(initial.filter((a) => a.needsRecheck).map((a) => a.signal)), [initial]);
  const placed = new Set(anchors.map((a) => a.signal));
  const tray = [...new Set([...unplacedSignals, ...initial.map((a) => a.signal)])].filter((s) => !placed.has(s));
  const current = anchors.find((a) => a.signal === selected);
  const editable = !!onSave;

  const place = (point: [number, number, number]) => {
    if (!selected) return;
    setAnchors((prev) => [...prev.filter((a) => a.signal !== selected), { signal: selected, x: point[0], y: point[1], z: point[2], label: current?.label ?? null }]);
    setSaved(false);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('anchors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-xs">
      {editable && (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-slate-500 dark:text-slate-400 pt-1">{t('anchors.placing')}</span>
          {[...anchors.map((a) => a.signal), ...tray].map((s) => (
            <button
              key={s}
              onClick={() => setSelected(s)}
              className={`px-2 py-1 rounded-md border cursor-pointer ${selected === s
                ? 'bg-sky-600 text-white border-sky-600'
                : recheck.has(s)
                  ? 'border-amber-400 text-amber-700 dark:text-amber-300'
                  : placed.has(s)
                    ? 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    : 'border-dashed border-amber-300 text-amber-700 dark:text-amber-300'}`}
              title={recheck.has(s) ? t('model.recheckHint') : placed.has(s) ? t('anchors.placedHint') : t('anchors.notPlacedYet')}
            >
              {s}{custom.has(s) ? ` ·${t('anchors.yours')}` : ''}
            </button>
          ))}
        </div>
      )}

      <div className="relative h-[420px] rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
        <Suspense fallback={<p className="p-4 text-slate-400">{t('model.loadingModel')}</p>}>
          <ModelScene
            url={modelUrl}
            bounds={bounds}
            markers={anchors.map((a) => ({ ...a, tone: a.signal === selected ? 'selected' : recheck.has(a.signal) ? 'recheck' : 'normal' }))}
            onPlace={editable ? place : undefined}
          />
        </Suspense>
      </div>
      <p className="text-[11px] text-slate-400">{editable ? t('model.howTo') : t('model.viewOnly')}</p>
      {note && <p className="text-[11px] text-slate-400">{note}</p>}

      {editable && current && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-slate-500">{t('anchors.labelFor', { signal: current.signal })}</span>
          <Input
            size="sm"
            value={current.label ?? ''}
            onChange={(v) => { setAnchors((prev) => prev.map((a) => (a.signal === current.signal ? { ...a, label: v || null } : a))); setSaved(false); }}
            placeholder={t('anchors.optional')}
            className="max-w-xs"
          />
          <span className="font-mono text-slate-400">{current.x}, {current.y}, {current.z}</span>
          <button
            onClick={() => { setAnchors((prev) => prev.filter((a) => a.signal !== current.signal)); setSaved(false); }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-rose-300 cursor-pointer"
          >
            <X className="w-3 h-3" /> {t('anchors.removeMarker')}
          </button>
          {onConfirm && recheck.has(current.signal) && (
            <button
              onClick={() => run(() => onConfirm(current.signal))}
              disabled={busy}
              className="px-2 py-1 rounded-md border border-amber-300 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50 cursor-pointer"
            >
              {t('model.confirmStill')}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      {editable && (
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-emerald-600 dark:text-emerald-400">{t('anchors.saved')}</span>}
          <span className="text-slate-400">{t('anchors.placedCount', { count: anchors.length })} · {t('anchors.notPlacedCount', { count: tray.length })}</span>
          <button
            onClick={() => run(async () => { await onSave!(anchors); setSaved(true); })}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold disabled:opacity-50 cursor-pointer"
          >
            {busy ? t('common.saving') : t('anchors.save')}
          </button>
        </div>
      )}
    </div>
  );
};

/** The box the backend checks markers against, measured in the browser: the API never sees the bytes. */
export async function measureModel(file: File): Promise<ModelBounds> {
  const [{ GLTFLoader }, { Box3 }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three'),
  ]);
  const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
  const box = new Box3().setFromObject(gltf.scene);
  if (box.isEmpty()) throw new Error('empty');
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { min: [r(box.min.x), r(box.min.y), r(box.min.z)], max: [r(box.max.x), r(box.max.y), r(box.max.z)] };
}
