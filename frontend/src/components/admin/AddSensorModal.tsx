import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, Sensor, SensorCategory, SensorInput, SensorParameterSpec,
} from '../../lib/api';

interface AddSensorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: SensorInput) => Promise<Sensor>;
  onUpdate: (id: string, input: SensorInput) => Promise<Sensor>;
  categories: SensorCategory[];
  onCreateCategory: (name: string) => Promise<SensorCategory>;
  existingSensor?: Sensor | null;
}

const emptySpec = (): SensorParameterSpec => ({
  parameter: '', unit: '', min: 0, max: 0, normalRange: '', notes: '',
});

const NEW_CATEGORY = '__new__';

export const AddSensorModal: React.FC<AddSensorModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, categories, onCreateCategory, existingSensor,
}) => {
  const { t } = useTranslation('catalog');
  const [categoryId, setCategoryId] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [sensorName, setSensorName] = useState('');
  const [description, setDescription] = useState('');
  const [specs, setSpecs] = useState<SensorParameterSpec[]>([emptySpec()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingSensor;

  useEffect(() => {
    if (!isOpen) return;
    setCategoryId(existingSensor?.categoryId ?? '');
    setNewCategoryName('');
    setSensorName(existingSensor?.sensorName ?? '');
    setDescription(existingSensor?.description ?? '');
    setSpecs(existingSensor?.parameterSpecs?.length ? existingSensor.parameterSpecs : [emptySpec()]);
    setError(undefined);
  }, [isOpen, existingSensor]);

  if (!isOpen) return null;

  const updateSpec = (index: number, field: keyof SensorParameterSpec, value: string) => {
    setSpecs((prev) => prev.map((s, i) => {
      if (i !== index) return s;
      if (field === 'min' || field === 'max') return { ...s, [field]: value === '' ? 0 : Number(value) };
      return { ...s, [field]: value };
    }));
  };
  const addSpecRow = () => setSpecs((prev) => [...prev, emptySpec()]);
  const removeSpecRow = (index: number) =>
    setSpecs((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = sensorName.trim();
    if (!finalName) return;
    if (categoryId === NEW_CATEGORY && !newCategoryName.trim()) return;

    const parameterSpecs = specs.filter((s) => s.parameter.trim());

    setBusy(true);
    setError(undefined);
    try {
      let finalCategoryId = categoryId || undefined;
      if (categoryId === NEW_CATEGORY) {
        const created = await onCreateCategory(newCategoryName.trim());
        finalCategoryId = created.id;
      }
      const input: SensorInput = {
        sensorName: finalName,
        categoryId: finalCategoryId,
        description: description.trim() || undefined,
        parameterSpecs,
      };
      if (isEditing) {
        await onUpdate(existingSensor!.id, input);
      } else {
        await onCreate(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (isEditing ? t('sensorModal.saveFailed') : t('sensorModal.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addSensorModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150 max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">
            {isEditing ? t('sensorModal.editTitle') : t('sensorModal.newTitle')}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs overflow-y-auto">
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('sensorModal.sensorCategory')} <span className="text-red-500">*</span>
            </label>
            <SelectPicker
              size="sm"
              data={[
                ...categories.map((c) => ({ label: c.name, value: c.id })),
                { label: t('sensorModal.addNewCategory'), value: NEW_CATEGORY },
              ]}
              value={categoryId}
              onChange={(value) => setCategoryId(value ?? '')}
              placeholder={t('sensorModal.selectCategory')}
              block
              searchable={false}
              cleanable={false}
            />
            {categoryId === NEW_CATEGORY && (
              <Input
                size="sm"
                autoFocus
                required
                value={newCategoryName}
                onChange={(value) => setNewCategoryName(value)}
                placeholder={t('sensorModal.newCategoryPlaceholder')}
                className="mt-2"
              />
            )}
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('sensors.sensorName')} <span className="text-red-500">*</span>
            </label>
            <Input
              size="sm"
              required
              value={sensorName}
              onChange={(value) => setSensorName(value)}
              placeholder={t('sensorModal.sensorNamePlaceholder')}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block font-medium text-slate-700 dark:text-slate-300">
                {t('sensorModal.telemetryParameters')}
              </label>
              <button
                type="button"
                onClick={addSpecRow}
                className="text-sky-600 dark:text-sky-400 font-medium flex items-center gap-1 hover:text-sky-700 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('sensorModal.addParameter')}
              </button>
            </div>

            <div className="space-y-2">
              {specs.map((spec, index) => (
                <div
                  key={index}
                  className="grid grid-cols-12 gap-1.5 items-center bg-slate-50 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-700 rounded-lg p-2"
                >
                  <Input
                    size="sm"
                    value={spec.parameter}
                    onChange={(value) => updateSpec(index, 'parameter', value)}
                    placeholder={t('sensorModal.parameterPlaceholder')}
                    className="col-span-4"
                  />
                  <Input
                    size="sm"
                    value={spec.unit}
                    onChange={(value) => updateSpec(index, 'unit', value)}
                    placeholder={t('sensorModal.unit')}
                    className="col-span-1"
                  />
                  <InputNumber
                    size="sm"
                    value={spec.min}
                    onChange={(value) => updateSpec(index, 'min', String(value))}
                    placeholder={t('sensorModal.min')}
                    className="col-span-1"
                  />
                  <InputNumber
                    size="sm"
                    value={spec.max}
                    onChange={(value) => updateSpec(index, 'max', String(value))}
                    placeholder={t('sensorModal.max')}
                    className="col-span-1"
                  />
                  <Input
                    size="sm"
                    value={spec.normalRange}
                    onChange={(value) => updateSpec(index, 'normalRange', value)}
                    placeholder={t('sensorModal.normalRange')}
                    className="col-span-3"
                  />
                  <Input
                    size="sm"
                    value={spec.notes}
                    onChange={(value) => updateSpec(index, 'notes', value)}
                    placeholder={t('sensorModal.notes')}
                    className="col-span-1"
                  />
                  <button
                    type="button"
                    onClick={() => removeSpecRow(index)}
                    disabled={specs.length === 1}
                    className="col-span-1 flex items-center justify-center text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title={t('sensorModal.removeParameter')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('classModal.description')}
            </label>
            <Input
              as="textarea"
              size="sm"
              rows={2}
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder={t('sensorModal.descriptionPlaceholder')}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-3 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2 rounded-lg bg-[#0077b6] hover:bg-[#023e8a] text-white font-medium shadow-xs flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              {busy ? t('common.saving') : t('sensorModal.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
