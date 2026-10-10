import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { Input } from 'rsuite';
import { ApiError, GeoJsonPolygon, Plant } from '../../lib/api';

interface EditPlantBoundaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  plant: Plant | null;
  onSave: (id: string, boundary: GeoJsonPolygon | null) => Promise<Plant>;
}

interface CoordRow {
  lat: string;
  lng: string;
}

const emptyRow = (): CoordRow => ({ lat: '', lng: '' });

/** The outer ring without its closing repeat — what somebody actually types. */
function ringToRows(boundary: GeoJsonPolygon | null): CoordRow[] {
  const ring = boundary?.coordinates?.[0];
  if (!ring || ring.length < 2) return [emptyRow(), emptyRow(), emptyRow()];
  const open = ring.slice(0, -1); // drop the repeated closing position
  return open.map(([lng, lat]) => ({ lat: String(lat), lng: String(lng) }));
}

export const EditPlantBoundaryModal: React.FC<EditPlantBoundaryModalProps> = ({
  isOpen, onClose, plant, onSave,
}) => {
  const [rows, setRows] = useState<CoordRow[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) return;
    setRows(ringToRows(plant?.boundary ?? null));
    setError(undefined);
  }, [isOpen, plant]);

  if (!isOpen || !plant) return null;

  const updateRow = (i: number, field: keyof CoordRow, value: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) => setRows((prev) => (prev.length > 3 ? prev.filter((_, idx) => idx !== i) : prev));

  const parsed = rows
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), filled: r.lat.trim() !== '' && r.lng.trim() !== '' }))
    .filter((r) => r.filled);
  const allValid = parsed.length >= 3 && parsed.every(
    (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && r.lat >= -90 && r.lat <= 90 && r.lng >= -180 && r.lng <= 180,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allValid) return;

    // Closed here rather than asked of the person typing it — a ring that
    // repeats its own first point is a database rule, not something anybody
    // filling in a shape thinks to do themselves.
    const outerRing: [number, number][] = parsed.map((r) => [r.lng, r.lat]);
    outerRing.push(outerRing[0]);

    setBusy(true);
    setError(undefined);
    try {
      await onSave(plant.id, { type: 'Polygon', coordinates: [outerRing] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this boundary.');
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm(`Remove ${plant.name}'s boundary?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(plant.id, null);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clear this boundary.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="editPlantBoundaryModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">Site Boundary</h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">{plant.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The corners of the site, in order, as latitude / longitude. At least three points — the shape closes itself.
          </p>

          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <Input
                  size="sm"
                  value={r.lat}
                  onChange={(value) => updateRow(i, 'lat', value)}
                  placeholder="latitude, e.g. 17.6868"
                />
                <Input
                  size="sm"
                  value={r.lng}
                  onChange={(value) => updateRow(i, 'lng', value)}
                  placeholder="longitude, e.g. 83.2185"
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={rows.length <= 3}
                  className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  title="Remove point"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addRow}
            className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold flex items-center gap-1 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add point</span>
          </button>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              At least 3 valid points needed
            </span>
            <div className="flex items-center gap-3">
              {plant.boundary && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleClear}
                  className="px-4 py-2.5 rounded-xl border border-rose-200 dark:border-rose-900 bg-white dark:bg-slate-700 text-rose-600 dark:text-rose-300 text-xs font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer disabled:opacity-60"
                >
                  Clear
                </button>
              )}
              <button
                type="submit"
                disabled={busy || !allValid}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? 'Saving…' : 'Save Boundary'}</span>
              </button>
            </div>
          </div>
        </form>

      </div>
    </div>
  );
};
