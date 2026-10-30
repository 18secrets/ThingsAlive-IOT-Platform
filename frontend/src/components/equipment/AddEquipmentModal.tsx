import React, { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, EquipmentClass, EquipmentInput, EquipmentProfile, Plant, ServiceTier } from '../../lib/api';

interface AddEquipmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: EquipmentInput) => Promise<void>;
  onUpdate: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<void>;
  /** Placement has its own route and needs a reason — throws to abort the whole
   *  save if the person backs out of giving one. */
  onMove: (sourceSystem: string, externalId: string, toPlantId: string | null) => Promise<void>;
  equipmentClasses: EquipmentClass[];
  plants: Plant[];
  /** Present to edit that machine instead of registering a new one. */
  existingEquipment?: EquipmentProfile | null;
  /** Every machine in the account, to say before saving that a code is already taken. */
  allEquipment?: EquipmentProfile[];
}

const TIERS: ServiceTier[] = ['basic', 'standard', 'advanced', 'full'];

export const AddEquipmentModal: React.FC<AddEquipmentModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onUpdate,
  onMove,
  equipmentClasses,
  plants,
  existingEquipment,
  allEquipment = [],
}) => {
  const { t } = useTranslation('equipment');
  const tierOptions = TIERS.map((tier) => ({ label: t(`tier.${tier}`), value: tier }));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [equipmentClassSlug, setEquipmentClassSlug] = useState('');
  const [plantId, setPlantId] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [tier, setTier] = useState<ServiceTier>('basic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingEquipment;

  const equipmentClassOptions = equipmentClasses.map((ec) => ({ label: ec.name, value: ec.slug }));
  const plantOptions = plants.map((p) => ({ label: p.name, value: p.id }));

  const reset = () => {
    setCode('');
    setName('');
    setDescription('');
    setEquipmentClassSlug('');
    setPlantId('');
    setManufacturer('');
    setModelNumber('');
    setSerialNumber('');
    setTier('basic');
    setError(undefined);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (existingEquipment) {
      setCode(existingEquipment.externalId);
      setName(existingEquipment.name ?? '');
      setDescription(existingEquipment.description ?? '');
      setEquipmentClassSlug(existingEquipment.equipmentClassSlug ?? '');
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

  if (!isOpen) return null;

  // Said while typing, not after a 409. A mirrored machine with the same code is a
  // different identity the API allows, but two "3100092"s in one list is still a mistake.
  const duplicateOf = !existingEquipment && code.trim()
    ? allEquipment.find((e) => e.externalId.toLowerCase() === code.trim().toLowerCase())
    : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalCode = code.trim();
    const finalName = name.trim();
    if (!finalCode || !finalName) return;

    setBusy(true);
    setError(undefined);
    try {
      if (existingEquipment) {
        const plantChanged = plantId !== (existingEquipment.plantId ?? '');
        // Before any other edit — if the person backs out of giving a reason,
        // nothing here should be half-applied.
        if (plantChanged) {
          await onMove(existingEquipment.sourceSystem, existingEquipment.externalId, plantId || null);
        }
        await onUpdate(existingEquipment.sourceSystem, existingEquipment.externalId, {
          name: finalName,
          description: description.trim() || undefined,
          equipmentClassSlug: equipmentClassSlug || undefined,
          manufacturer: manufacturer.trim() || undefined,
          modelNumber: modelNumber.trim() || undefined,
          serialNumber: serialNumber.trim() || undefined,
          tier,
        });
      } else {
        await onSave({
          code: finalCode,
          name: finalName,
          description: description.trim() || undefined,
          equipmentClassSlug: equipmentClassSlug || undefined,
          plantId: plantId || undefined,
          manufacturer: manufacturer.trim() || undefined,
          modelNumber: modelNumber.trim() || undefined,
          serialNumber: serialNumber.trim() || undefined,
          tier,
        });
      }
      reset();
      onClose();
    } catch (err) {
      // The person backed out of the move's required reason prompt — not a
      // failure, just nothing to report.
      if (err instanceof Error && err.message === 'cancelled') return;
      setError(err instanceof ApiError ? err.message : (isEditing ? t('equipmentForm.saveFailed') : t('equipmentForm.registerFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addEquipmentModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {isEditing ? t('equipmentForm.editTitle') : t('equipmentForm.addTitle')}
          </h3>
          <button
            onClick={() => { reset(); onClose(); }}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.code')} <span className="text-rose-500">*</span>
              </label>
              <Input
                autoFocus={!isEditing}
                disabled={isEditing}
                value={code}
                onChange={(value) => setCode(value)}
                placeholder={t('common.eg', { example: 'DG-01' })}
                className="font-mono text-xs"
              />
              {duplicateOf ? (
                <p className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">
                  {t('equipmentForm.codeTaken', { name: duplicateOf.name ?? duplicateOf.externalId })}
                </p>
              ) : (
                <p className="text-[11px] text-slate-400 mt-1">
                  {isEditing ? t('equipmentForm.codeHintEdit') : t('equipmentForm.codeHintNew')}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.name')} <span className="text-rose-500">*</span>
              </label>
              <Input
                value={name}
                onChange={(value) => setName(value)}
                placeholder={t('common.eg', { example: 'Komatsu PC210LC' })}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipmentForm.description')}
            </label>
            <Input
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder={t('equipmentForm.descriptionPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.class')}
              </label>
              <SelectPicker
                data={equipmentClassOptions}
                value={equipmentClassSlug || null}
                onChange={(value) => setEquipmentClassSlug(value ?? '')}
                placeholder={t('common.unclassified')}
                block
                searchable={equipmentClassOptions.length > 6}
                cleanable
              />
              {equipmentClasses.length === 0 && (
                <p className="text-[11px] text-slate-400 mt-1">
                  {t('equipmentForm.noClasses')}
                </p>
              )}
              {/* A machine with no library class registered silently as Unclassified, with
                  nothing saying what it would not get or what to do next (test report OB-6). */}
              {!equipmentClassSlug && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-2 py-1.5 mt-1.5">
                  {t('equipmentForm.noLibraryClass')}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.plant')}
              </label>
              <SelectPicker
                data={plantOptions}
                value={plantId || null}
                onChange={(value) => setPlantId(value ?? '')}
                placeholder={t('common.unassigned')}
                block
                searchable={plantOptions.length > 6}
                cleanable
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.manufacturer')}
              </label>
              <Input
                value={manufacturer}
                onChange={(value) => setManufacturer(value)}
                placeholder={t('common.eg', { example: 'Komatsu' })}
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentForm.modelNumber')}
              </label>
              <Input
                value={modelNumber}
                onChange={(value) => setModelNumber(value)}
                placeholder={t('common.eg', { example: 'EC210' })}
                size="sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentForm.serialNumber')}
              </label>
              <Input
                value={serialNumber}
                onChange={(value) => setSerialNumber(value)}
                placeholder={t('common.eg', { example: 'SER-4920' })}
                className="font-mono"
                size="sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('equipmentForm.serviceTier')}
            </label>
            <SelectPicker
              data={tierOptions}
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
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || !!duplicateOf}
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              <span>
                {busy ? (isEditing ? t('common.saving') : t('equipmentForm.registering')) : (isEditing ? t('common.saveChanges') : t('equipmentForm.register'))}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
