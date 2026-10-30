import React, { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, EquipmentInput, EquipmentProfile, Plant, ServiceTier, apiListEntitlements, apiListEquipmentClasses,
} from '../../lib/api';
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
  /** Every machine across accounts, to say before saving that a code is already taken in the chosen one. */
  allEquipment?: EquipmentProfile[];
}

// Labels are equipment.tier.<value> in the devices namespace.
const TIERS: ServiceTier[] = ['basic', 'standard', 'advanced', 'full'];

export const MasterAddEquipmentModal: React.FC<MasterAddEquipmentModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, onMove, clients, onListPlantsForTenant, existingEquipment, allEquipment = [],
}) => {
  const { t } = useTranslation(['devices', 'shared']);
  const TIER_OPTIONS = TIERS.map((tier) => ({ label: t(`equipment.tier.${tier}`), value: tier }));
  const [tenantId, setTenantId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [plantId, setPlantId] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [tier, setTier] = useState<ServiceTier>('basic');
  const [equipmentClassSlug, setEquipmentClassSlug] = useState('');
  // Machine types granted to each client, read once per opening (tester bug TC_145):
  // a machine may only run a class its account was granted (decision D04), so the
  // picker offers that client's grants, never the whole library.
  const [grants, setGrants] = useState<{ tenantId: string; slug: string }[]>([]);
  const [classNames, setClassNames] = useState<Record<string, string>>({});
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
    setEquipmentClassSlug('');
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
      setEquipmentClassSlug(existingEquipment.equipmentClassSlug ?? '');
    } else {
      reset();
    }
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingEquipment]);

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    Promise.all([apiListEntitlements(), apiListEquipmentClasses()])
      .then(([entitlements, classes]) => {
        if (!live) return;
        setGrants(entitlements.filter((e) => !e.revokedAt).map((e) => ({ tenantId: e.tenantId, slug: e.equipmentClassSlug })));
        setClassNames(Object.fromEntries(classes.map((c) => [c.slug, c.name])));
      })
      .catch(() => { if (live) setGrants([]); });
    return () => { live = false; };
  }, [isOpen]);

  const classOptions = grants
    .filter((g) => g.tenantId === tenantId)
    .map((g) => ({ label: classNames[g.slug] ?? g.slug, value: g.slug }));

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

  // Said while typing, as on the client's own form (test report MAJ-4c). A code is unique
  // within one account, so only the chosen client's machines can clash.
  const duplicateOf = !existingEquipment && tenantId && code.trim()
    ? allEquipment.find((e) => e.tenantId === tenantId && e.externalId.toLowerCase() === code.trim().toLowerCase())
    : undefined;

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
          const reason = window.prompt(t('equipment.movePrompt', { name: finalName }));
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
          equipmentClassSlug: equipmentClassSlug || null,
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
          equipmentClassSlug: equipmentClassSlug || undefined,
          tenantId,
        });
      }
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (isEditing ? t('equipment.saveFailed') : t('equipment.registerFailed')));
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
            {isEditing ? t('equipment.editTitle') : t('equipment.register')}
          </h3>
          <button
            onClick={() => { reset(); onClose(); }}
            aria-label={t('shared:close')}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('translation:common.client')} <span className="text-rose-500">*</span>
            </label>
            <SelectPicker
              data={clientOptions}
              value={tenantId || null}
              onChange={(value) => { setTenantId(value ?? ''); setPlantId(''); setEquipmentClassSlug(''); }}
              placeholder={t('assign.selectClient')}
              disabled={isEditing}
              block
              searchable={clientOptions.length > 6}
              cleanable={false}
            />
            {isEditing && (
              <p className="text-[11px] text-slate-400 mt-1">{t('equipment.clientLocked')}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipment.col.code')} <span className="text-rose-500">*</span>
              </label>
              <Input
                disabled={isEditing}
                value={code}
                onChange={(value) => setCode(value)}
                placeholder={t('equipment.codePlaceholder')}
                className="font-mono text-xs"
              />
              {duplicateOf ? (
                <p className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">
                  {t('equipment.codeTaken', { name: duplicateOf.name ?? duplicateOf.externalId })}
                </p>
              ) : (
                <p className="text-[11px] text-slate-400 mt-1">
                  {isEditing
                    ? t('equipment.codeLocked')
                    : t('equipment.codeHint')}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipment.name')} <span className="text-rose-500">*</span>
              </label>
              <Input
                value={name}
                onChange={(value) => setName(value)}
                placeholder={t('equipment.namePlaceholder')}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipment.machineType')}
            </label>
            <SelectPicker
              data={classOptions}
              value={equipmentClassSlug || null}
              onChange={(value) => setEquipmentClassSlug(value ?? '')}
              placeholder={!tenantId ? t('equipment.pickClientFirst') : t('equipment.unclassified')}
              disabled={!tenantId}
              block
              searchable={classOptions.length > 6}
              cleanable
            />
            {tenantId && classOptions.length === 0 && (
              <p className="text-[11px] text-slate-400 mt-1">{t('equipment.noGrantedTypes')}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipment.description')}
            </label>
            <Input
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder={t('equipment.descriptionPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipment.col.site')}
            </label>
            <SelectPicker
              data={plantOptions}
              value={plantId || null}
              onChange={(value) => setPlantId(value ?? '')}
              placeholder={!tenantId ? t('equipment.pickClientFirst') : plantsLoading ? t('equipment.loadingSites') : t('pool.unassigned')}
              disabled={!tenantId || plantsLoading}
              block
              searchable={plantOptions.length > 6}
              cleanable
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipment.manufacturer')}
              </label>
              <Input
                value={manufacturer}
                onChange={(value) => setManufacturer(value)}
                placeholder={t('equipment.manufacturerPlaceholder')}
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipment.modelNumber')}
              </label>
              <Input
                value={modelNumber}
                onChange={(value) => setModelNumber(value)}
                placeholder={t('equipment.modelNumberPlaceholder')}
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipment.serialNumber')}
              </label>
              <Input
                value={serialNumber}
                onChange={(value) => setSerialNumber(value)}
                placeholder={t('equipment.serialNumberPlaceholder')}
                className="font-mono"
                size="sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipment.serviceTier')}
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
              {t('shared:cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || !tenantId || !!duplicateOf}
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              <span>
                {busy ? (isEditing ? t('shared:saving') : t('register.registering')) : (isEditing ? t('shared:saveChanges') : t('equipment.register'))}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
