import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { ApiError, Plant, PlantInput } from '../../lib/api';

interface AddPlantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: PlantInput) => Promise<Plant>;
  onUpdate: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  existingPlant?: Plant | null;
}

const slugify = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const AddPlantModal: React.FC<AddPlantModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingPlant,
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [address, setAddress] = useState('');
  const [siteArea, setSiteArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingPlant;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingPlant?.name ?? '');
    setCode(existingPlant?.code ?? '');
    setCodeTouched(isEditing);
    setAddress(existingPlant?.address ?? '');
    setSiteArea(existingPlant?.siteArea ?? '');
    setError(undefined);
  }, [isOpen, existingPlant, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!codeTouched) setCode(slugify(value));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    const finalCode = code.trim();
    if (!finalName || !finalCode) return;

    setBusy(true);
    setError(undefined);
    try {
      if (existingPlant) {
        await onUpdate(existingPlant.id, {
          name: finalName, code: finalCode, address: address.trim() || undefined, siteArea: siteArea.trim() || undefined,
        });
      } else {
        await onCreate({
          name: finalName, code: finalCode, address: address.trim() || undefined, siteArea: siteArea.trim() || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'register'} the site.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addPlantModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Plant / Depot' : 'Register New Plant / Depot'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                Regional production facility, maintenance depot, or assembly site — in your own account.
              </p>
            </div>
          </div>
          <button
            id="close-plant-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Plant Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Hyderabad Central Works"
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Address <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g. Hyderabad, Telangana"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Plant Code <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => { setCode(e.target.value); setCodeTouched(true); }}
                placeholder="e.g. HYD-WKS"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all font-mono"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Letters, digits, dots, hyphens or underscores — unique within your account.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Site Area <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={siteArea}
              onChange={(e) => setSiteArea(e.target.value)}
              placeholder="e.g. 12 acres"
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
            />
          </div>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? 'Saving…' : (isEditing ? 'Save Plant' : 'Register Plant')}</span>
              </button>
            </div>
          </div>
        </form>

      </div>
    </div>
  );
};
