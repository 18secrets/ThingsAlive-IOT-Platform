import React, { useMemo, useState } from 'react';
import { AlertCircle, MapPin, X } from 'lucide-react';
import { Input } from 'rsuite';
import { ApiError, VisualAnchor } from '../../lib/api';

/**
 * Places signal markers on a schematic. Pick a signal (placed or from the tray of
 * unplaced ones), click the image where it lives; positions are percentages of the
 * image so they survive any display size. Saved as a whole set — the backend validates
 * the set, not marker by marker, so the editor keeps every change local until Save.
 */
export const AnchorEditor: React.FC<{
  imageUrl: string;
  anchors: (VisualAnchor & { placementCustom?: boolean })[];
  unplacedSignals: string[];
  onSave: (anchors: VisualAnchor[]) => Promise<void>;
  /** Shown under the image, e.g. what saving does for a client's copy. */
  note?: string;
}> = ({ imageUrl, anchors: initial, unplacedSignals, onSave, note }) => {
  const [anchors, setAnchors] = useState<VisualAnchor[]>(() => initial.map(({ signal, hotspotX, hotspotY, label }) => ({ signal, hotspotX, hotspotY, label })));
  const [selected, setSelected] = useState<string | null>(unplacedSignals[0] ?? initial[0]?.signal ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const custom = useMemo(() => new Set(initial.filter((a) => a.placementCustom).map((a) => a.signal)), [initial]);
  const placed = new Set(anchors.map((a) => a.signal));
  const tray = [...new Set([...unplacedSignals, ...initial.map((a) => a.signal)])].filter((s) => !placed.has(s));
  const current = anchors.find((a) => a.signal === selected);

  function place(e: React.MouseEvent<HTMLDivElement>) {
    if (!selected) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - box.left) / box.width) * 1000) / 10;
    const y = Math.round(((e.clientY - box.top) / box.height) * 1000) / 10;
    setAnchors((prev) => {
      const rest = prev.filter((a) => a.signal !== selected);
      return [...rest, { signal: selected, hotspotX: Math.min(100, Math.max(0, x)), hotspotY: Math.min(100, Math.max(0, y)), label: current?.label ?? null }];
    });
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(anchors);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the markers.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-slate-500 dark:text-slate-400 pt-1">Placing:</span>
        {[...anchors.map((a) => a.signal), ...tray].map((s) => (
          <button
            key={s}
            onClick={() => setSelected(s)}
            className={`px-2 py-1 rounded-md border cursor-pointer ${selected === s
              ? 'bg-sky-600 text-white border-sky-600'
              : placed.has(s)
                ? 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                : 'border-dashed border-amber-300 text-amber-700 dark:text-amber-300'}`}
            title={placed.has(s) ? 'Placed — click the image to move it' : 'Not placed yet'}
          >
            {s}{custom.has(s) ? ' ·yours' : ''}
          </button>
        ))}
      </div>

      <div
        onClick={place}
        className={`relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 ${selected ? 'cursor-crosshair' : ''}`}
      >
        <img src={imageUrl} alt="Equipment schematic" className="w-full h-auto block select-none pointer-events-none" draggable={false} />
        {anchors.map((a) => (
          <span
            key={a.signal}
            style={{ left: `${a.hotspotX}%`, top: `${a.hotspotY}%` }}
            className={`absolute -translate-x-1/2 -translate-y-full flex flex-col items-center pointer-events-none ${a.signal === selected ? 'z-10' : ''}`}
          >
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap shadow ${a.signal === selected ? 'bg-sky-600 text-white' : 'bg-white/90 text-slate-800'}`}>
              {a.label || a.signal}
            </span>
            <MapPin className={`w-4 h-4 ${a.signal === selected ? 'text-sky-600' : 'text-rose-500'}`} />
          </span>
        ))}
      </div>
      {note && <p className="text-[11px] text-slate-400">{note}</p>}

      {current && (
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Label for {current.signal}:</span>
          <Input
            size="sm"
            value={current.label ?? ''}
            onChange={(v) => { setAnchors((prev) => prev.map((a) => (a.signal === current.signal ? { ...a, label: v || null } : a))); setSaved(false); }}
            placeholder="Optional"
            className="max-w-xs"
          />
          <button
            onClick={() => { setAnchors((prev) => prev.filter((a) => a.signal !== current.signal)); setSaved(false); }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-rose-300 cursor-pointer"
          >
            <X className="w-3 h-3" /> Remove marker
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>}
        <span className="text-slate-400">{anchors.length} placed · {tray.length} not placed</span>
        <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold disabled:opacity-50 cursor-pointer">
          {busy ? 'Saving…' : 'Save markers'}
        </button>
      </div>
    </div>
  );
};
