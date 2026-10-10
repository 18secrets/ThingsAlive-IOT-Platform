import React, { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { ApiError, EquipmentInput, EquipmentProfile, Plant, ServiceTier } from '../../lib/api';
import { ClientAccount } from '../../types';

interface MasterAddEquipmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: EquipmentInput) => Promise<EquipmentProfile>;
  onUpdate: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<EquipmentProfile>;
  onMove: (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string, tenantId: string,
  ) => Promise<EquipmentProfile>;
  clients: ClientAccount[];
  onListPlantsForTenant: (tenantId: string) => Promise<Plant[]>;
  existingEquipment?: EquipmentProfile | null;
}

const TIERS: ServiceTier[] = ['basic', 'standard', 'advanced', 'full'];
const TIER_OPTIONS = TIERS.map((t) => ({ label: t.charAt(0).toUpperCase() + t.slice(1), value: t }));

export const MasterAddEquipmentModal: React.FC<MasterAddEquipmentModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, onMove, clients, onListPlantsForTenant, existingEquipment,
}) => {
  const [tenantId, setTenantId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [plantId, setPlantId] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [tier, setTier] = useState<ServiceTier>('basic');
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantsLoading, setPlantsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingEquipment;
  const clientOptions = clients.map((c) => ({ label: c.clientName, value: c.id }));
  const plantOptions = plants.map((p) => ({ label: p.name, value: p.id }));

  const reset = () => {
    setTenantId('');
    setCode('');
    setName('');
    setDescription('');
    setPlantId('');
    setManufacturer('');
    setModelNumber('');
    setSerialNumber('');
    setTier('basic');
    setPlants([]);
    setError(undefined);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (existingEquipment) {
      setTenantId(existingEquipment.tenantId);
      setCode(existingEquipment.externalId);
      setName(existingEquipment.name ?? '');
      setDescription(existingEquipment.description ?? '');
      setPlantId(existingEquipment.plantId ?? '');
      setManufacturer(existingEquipment.manufacturer ?? '');
      setModelNumber(existingEquipment.modelNumber ?? '');
      setSerialNumber(existingEquipment.serialNumber ?? '');
      setTier(existingEquipment.tier);
    } else {
      reset();
    }
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingEquipment]);

  // The site picker is per-client — fetched fresh whenever the chosen client
  // changes, never preloaded for every account up front.
  useEffect(() => {
    if (!tenantId) { setPlants([]); return; }
    let live = true;
    setPlantsLoading(true);
    onListPlantsForTenant(tenantId)
      .then((result) => { if (live) setPlants(result); })
      .catch(() => { if (live) setPlants([]); })
      .finally(() => { if (live) setPlantsLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalCode = code.trim();
    const finalName = name.trim();
    if (!finalCode || !finalName || !tenantId) return;

    setBusy(true);
    setError(undefined);
    try {
      if (existingEquipment) {
        const plantChanged = plantId !== (existingEquipment.plantId ?? '');
        if (plantChanged) {
          const reason = window.prompt(`Why is ${finalName} moving site?`);
          if (!reason) { setBusy(false); return; }
          await onMove(existingEquipment.sourceSystem, existingEquipment.externalId, plantId || null, reason, tenantId);
        }
        await onUpdate(existingEquipment.sourceSystem, existingEquipment.externalId, {
          name: finalName,
          description: description.trim() || undefined,
          manufacturer: manufacturer.trim() || undefined,
          modelNumber: modelNumber.trim() || undefined,
          serialNumber: serialNumber.trim() || undefined,
          tier,
          tenantId,
        });
      } else {
        await onCreate({
          code: finalCode,
          name: finalName,
          description: description.trim() || undefined,
          plantId: plantId || undefined,
          manufacturer: manufacturer.trim() || undefined,
          modelNumber: modelNumber.trim() || undefined,
          serialNumber: serialNumber.trim() || undefined,
          tier,
          tenantId,
        });
      }
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'register'} this equipment.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="masterAddEquipmentModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {isEditing ? 'Edit Equipment' : 'Register Equipment'}
          </h3>
          <button
            onClick={() => { reset(); onClose(); }}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Client <span className="text-rose-500">*</span>
            </label>
            <SelectPicker
              data={clientOptions}
              value={tenantId || null}
              onChange={(value) => { setTenantId(value ?? ''); setPlantId(''); }}
              placeholder="— Select client —"
              disabled={isEditing}
              block
              searchable={clientOptions.length > 6}
              cleanable={false}
            />
            {isEditing && (
              <p className="text-[11px] text-slate-400 mt-1">Which account this machine belongs to isn't changed here.</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Code <span className="text-rose-500">*</span>
              </label>
              <Input
                disabled={isEditing}
                value={code}
                onChange={(value) => setCode(value)}
                placeholder="e.g. DG-01"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {isEditing
                  ? "Permanent — this machine's identity, not changed here."
                  : "This machine's permanent identity. Not changed later."}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Equipment Name <span className="text-rose-500">*</span>
              </label>
              <Input
                value={name}
                onChange={(value) => setName(value)}
                placeholder="e.g. Komatsu PC210LC"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <Input
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder="Equipment role & function"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Site
            </label>
            <SelectPicker
              data={plantOptions}
              value={plantId || null}
              onChange={(value) => setPlantId(value ?? '')}
              placeholder={!tenantId ? 'Pick a client first' : plantsLoading ? 'Loading sites…' : 'Unassigned'}
              disabled={!tenantId || plantsLoading}
              block
              searchable={plantOptions.length > 6}
              cleanable
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Manufacturer
              </label>
              <Input
                value={manufacturer}
                onChange={(value) => setManufacturer(value)}
                placeholder="e.g. Komatsu"
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Model Number
              </label>
              <Input
                value={modelNumber}
                onChange={(value) => setModelNumber(value)}
                placeholder="e.g. EC210"
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Serial Number
              </label>
              <Input
                value={serialNumber}
                onChange={(value) => setSerialNumber(value)}
                placeholder="e.g. SER-4920"
                className="font-mono"
                size="sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Service Tier
            </label>
            <SelectPicker
              data={TIER_OPTIONS}
              value={tier}
              onChange={(value) => setTier((value ?? 'basic') as ServiceTier)}
              block
              searchable={false}
              cleanable={false}
            />
          </div>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => { reset(); onClose(); }}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !tenantId}
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              <span>
                {busy ? (isEditing ? 'Saving…' : 'Registering…') : (isEditing ? 'Save Changes' : 'Register Equipment')}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
