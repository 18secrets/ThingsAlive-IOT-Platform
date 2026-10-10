import React, { useEffect, useState } from 'react';
import { X, Check, AlertCircle, Info } from 'lucide-react';
import { CheckPicker } from 'rsuite';
import {
  ApiError, EquipmentProfile, Plant, SetUserAccessInput, TenantRole, TenantUser,
} from '../../lib/api';

interface EditUserAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: TenantUser | null;
  roles: TenantRole[];
  plants: Plant[];
  equipment: EquipmentProfile[];
  onSetAccess: (userId: string, input: SetUserAccessInput) => Promise<TenantUser>;
}

const equipmentKey = (sourceSystem: string, externalId: string) => `${sourceSystem}::${externalId}`;

export const EditUserAccessModal: React.FC<EditUserAccessModalProps> = ({
  isOpen, onClose, user, roles, plants, equipment, onSetAccess,
}) => {
  const [selectedPlantIds, setSelectedPlantIds] = useState<string[]>([]);
  const [selectedEquipmentKeys, setSelectedEquipmentKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const role = user ? roles.find((r) => r.slug === user.roleSlug) : undefined;
  const scopeShape = role?.scopeShape;

  useEffect(() => {
    if (!isOpen || !user) return;
    setSelectedPlantIds(user.plants.map((p) => p.plantId));
    setSelectedEquipmentKeys(user.equipment.map((e) => equipmentKey(e.sourceSystem, e.equipmentExternalId)));
    setError(undefined);
  }, [isOpen, user]);

  if (!isOpen || !user) return null;

  const plantOptions = plants.map((p) => ({ label: `${p.name} (${p.code})`, value: p.id }));
  const equipmentOptions = equipment.map((e) => ({
    label: e.name ?? e.externalId,
    value: equipmentKey(e.sourceSystem, e.externalId),
  }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (scopeShape === 'plant') {
        await onSetAccess(user.id, { plants: selectedPlantIds.map((plantId) => ({ plantId })) });
      } else if (scopeShape === 'equipment') {
        await onSetAccess(user.id, {
          equipment: selectedEquipmentKeys.map((key) => {
            const [sourceSystem, externalId] = key.split('::');
            return { sourceSystem, equipmentExternalId: externalId };
          }),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update access.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">{user.fullName}'s access</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs overflow-y-auto">
          {scopeShape === 'tenant' && (
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>The "{role?.name}" role sees the whole account — site/machine access does not apply to it.</span>
            </div>
          )}

          {scopeShape === 'plant' && (
            <>
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Leaving this empty means {user.fullName} sees no sites and no machines — not everything.</span>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Sites</label>
                <CheckPicker
                  data={plantOptions}
                  value={selectedPlantIds}
                  onChange={(value) => setSelectedPlantIds(value ?? [])}
                  placeholder="No sites selected"
                  block
                  searchable={plantOptions.length > 6}
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Machines follow the site they're on automatically — no need to pick them separately.
                </p>
              </div>
            </>
          )}

          {scopeShape === 'equipment' && (
            <>
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Leaving this empty means {user.fullName} sees no machines — not everything.</span>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Machines</label>
                <CheckPicker
                  data={equipmentOptions}
                  value={selectedEquipmentKeys}
                  onChange={(value) => setSelectedEquipmentKeys(value ?? [])}
                  placeholder="No machines selected"
                  block
                  searchable={equipmentOptions.length > 6}
                />
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-3 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium"
            >
              {scopeShape === 'tenant' ? 'Close' : 'Cancel'}
            </button>
            {scopeShape !== 'tenant' && (
              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2 rounded-lg bg-[#0077b6] hover:bg-[#023e8a] text-white font-medium shadow-xs flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
                {busy ? 'Saving…' : 'Save access'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
