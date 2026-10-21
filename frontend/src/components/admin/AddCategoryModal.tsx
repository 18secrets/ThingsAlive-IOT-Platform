import React, { useEffect, useState } from 'react';
import { X, Check, Info, Plus, Trash2 } from 'lucide-react';
import { CheckPicker, Input } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, EquipmentClass, EquipmentClassInput, ExpectedSignal, FailureMode } from '../../lib/api';

interface AddCategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdate: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  /** The current representative row for this slug — draft if one exists, else
   *  the latest published/retired version. Editing always affects the
   *  working draft, which may be a fresh fork of this row (see the API's own
   *  comment on PATCH /catalog/equipment-classes/:slug). */
  existingClass?: EquipmentClass | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const emptySignal = (): ExpectedSignal => ({ signal: '', unit: '', required: true });
const emptyFailureMode = (): FailureMode => ({ code: '', name: '', symptom: '', signals: [] });

export const AddCategoryModal: React.FC<AddCategoryModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingClass,
}) => {
  const { t } = useTranslation('catalog');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [signals, setSignals] = useState<ExpectedSignal[]>([emptySignal()]);
  const [failureModes, setFailureModes] = useState<FailureMode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingClass;

  useEffect(() => {
    if (!isOpen) return;
    setSlug(existingClass?.slug ?? '');
    setSlugTouched(isEditing);
    setName(existingClass?.name ?? '');
    setCategory(existingClass?.category ?? '');
    setDescription(existingClass?.description ?? '');
    setSignals(existingClass?.expectedSignals?.length ? existingClass.expectedSignals : [emptySignal()]);
    setFailureModes(existingClass?.failureModes?.length ? existingClass.failureModes : []);
    setError(undefined);
  }, [isOpen, existingClass, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const updateSignal = (index: number, field: keyof ExpectedSignal, value: string | boolean) => {
    setSignals((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };
  const addSignalRow = () => setSignals((prev) => [...prev, emptySignal()]);
  const removeSignalRow = (index: number) => setSignals((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const updateFailureMode = (index: number, field: 'code' | 'name' | 'symptom', value: string) => {
    setFailureModes((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  };
  const toggleFailureModeSignal = (index: number, signal: string) => {
    setFailureModes((prev) => prev.map((f, i) => (i === index
      ? { ...f, signals: f.signals.includes(signal) ? f.signals.filter((s) => s !== signal) : [...f.signals, signal] }
      : f)));
  };
  const addFailureModeRow = () => setFailureModes((prev) => [...prev, emptyFailureMode()]);
  const removeFailureModeRow = (index: number) => setFailureModes((prev) => prev.filter((_, i) => i !== index));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slug.trim();
    const finalName = name.trim();
    if (!finalSlug || !finalName) return;

    const validSignals = signals
      .filter((s) => s.signal.trim())
      .map((s) => ({ signal: s.signal.trim(), unit: s.unit?.trim() || null, required: s.required }));
    const validSignalNames = new Set(validSignals.map((s) => s.signal));

    // A failure mode naming a signal the class does not have is a description
    // nobody can act on (same rule seed-catalog.ts enforces on load) — dropped
    // here rather than sent, in case a signal row was removed after being picked.
    const validFailureModes = failureModes
      .filter((f) => f.code.trim() && f.name.trim() && f.symptom.trim())
      .map((f) => ({
        code: f.code.trim(),
        name: f.name.trim(),
        symptom: f.symptom.trim(),
        signals: f.signals.filter((s) => validSignalNames.has(s)),
      }));

    setBusy(true);
    setError(undefined);
    try {
      const input: EquipmentClassInput = {
        name: finalName,
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        expectedSignals: validSignals,
        failureModes: validFailureModes,
      };
      if (isEditing) {
        await onUpdate(finalSlug, input);
      } else {
        await onCreate(finalSlug, input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (isEditing ? t('classModal.saveFailed') : t('classModal.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addCategoryModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? t('classModal.editTitle') : t('classModal.newTitle')}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? t('classModal.editSubtitle')
                  : t('classModal.newSubtitle')}
              </p>
            </div>
          </div>
          <button
            id="close-category-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('classModal.className')} <span className="text-rose-500">*</span>
              </label>
              <Input
                size="sm"
                required
                autoFocus
                value={name}
                onChange={(value) => handleNameChange(value)}
                placeholder={t('classModal.classNamePlaceholder')}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('classModal.slug')} <span className="text-rose-500">*</span>
              </label>
              <Input
                size="sm"
                required
                disabled={isEditing}
                value={slug}
                onChange={(value) => { setSlug(value); setSlugTouched(true); }}
                placeholder={t('classModal.slugPlaceholder')}
              />
              <p className="text-[10px] text-slate-400 mt-1">
                {isEditing ? t('classModal.slugPermanent') : t('classModal.slugHint')}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('classModal.categoryTag')} <span className="text-slate-400 font-normal">{t('classModal.categoryTagHint')}</span>
            </label>
            <Input
              size="sm"
              value={category}
              onChange={(value) => setCategory(value)}
              placeholder={t('classModal.categoryPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('classModal.description')}
            </label>
            <Input
              as="textarea"
              size="sm"
              rows={3}
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder={t('classModal.descriptionPlaceholder')}
            />
          </div>

          <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-white">{t('classModal.expectedSignals')}</span>
              <button
                type="button"
                onClick={addSignalRow}
                className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold flex items-center gap-1 hover:text-sky-800 dark:hover:text-sky-200 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('classModal.addSignal')}</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-400 -mt-1">
              {t('classModal.signalsHint')}
            </p>

            {signals.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
                <Input
                  size="sm"
                  value={s.signal}
                  onChange={(value) => updateSignal(i, 'signal', value)}
                  placeholder={t('classModal.signalPlaceholder')}
                />
                <Input
                  size="sm"
                  value={s.unit ?? ''}
                  onChange={(value) => updateSignal(i, 'unit', value)}
                  placeholder={t('classModal.unitPlaceholder')}
                />
                <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={s.required}
                    onChange={(e) => updateSignal(i, 'required', e.target.checked)}
                    className="cursor-pointer"
                  />
                  {t('classModal.required')}
                </label>
                <button
                  type="button"
                  onClick={() => removeSignalRow(i)}
                  className="p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer"
                  title={t('classModal.removeSignal')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="p-4 rounded-xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-white">{t('classModal.failureModes')}</span>
              <button
                type="button"
                onClick={addFailureModeRow}
                className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold flex items-center gap-1 hover:text-amber-800 dark:hover:text-amber-200 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('classModal.addFailureMode')}</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-400 -mt-1">
              {t('classModal.failureModesHint')}
            </p>

            {failureModes.map((f, i) => (
              <div key={i} className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
                <div className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
                  <Input
                    size="sm"
                    value={f.code}
                    onChange={(value) => updateFailureMode(i, 'code', value)}
                    placeholder={t('classModal.codePlaceholder')}
                  />
                  <Input
                    size="sm"
                    value={f.name}
                    onChange={(value) => updateFailureMode(i, 'name', value)}
                    placeholder={t('classModal.namePlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={() => removeFailureModeRow(i)}
                    className="p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer"
                    title={t('classModal.removeFailureMode')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <Input
                  size="sm"
                  value={f.symptom}
                  onChange={(value) => updateFailureMode(i, 'symptom', value)}
                  placeholder={t('classModal.symptomPlaceholder')}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[10px] text-slate-400">{t('classModal.signalsThatMove')}</span>
                  {signals.filter((s) => s.signal.trim()).length === 0 ? (
                    <span className="text-[10px] text-slate-400 italic">{t('classModal.addSignalFirst')}</span>
                  ) : (
                    <CheckPicker
                      size="sm"
                      data={signals.filter((s) => s.signal.trim()).map((s) => ({ label: s.signal.trim(), value: s.signal.trim() }))}
                      value={f.signals}
                      onChange={(values) => setFailureModes((prev) => prev.map((ff, idx) => (idx === i ? { ...ff, signals: values ?? [] } : ff)))}
                      placeholder={t('classModal.selectSignals')}
                      searchable={false}
                      style={{ minWidth: 220 }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              <Trans t={t} i18nKey="common.mandatoryNote" components={{ req: <span className="text-rose-500 font-bold" /> }} />
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? t('common.saving') : (isEditing ? t('classModal.saveDraft') : t('classModal.createDraft'))}</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
