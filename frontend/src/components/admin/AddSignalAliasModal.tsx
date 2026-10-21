import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { Input } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, SignalAlias, SignalAliasInput } from '../../lib/api';

interface AddSignalAliasModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: SignalAliasInput) => Promise<SignalAlias>;
  existingAlias?: SignalAlias | null;
}

export const AddSignalAliasModal: React.FC<AddSignalAliasModalProps> = ({
  isOpen, onClose, onSave, existingAlias,
}) => {
  const { t } = useTranslation('catalog');
  const [sourceSystem, setSourceSystem] = useState('');
  const [alias, setAlias] = useState('');
  const [canonical, setCanonical] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingAlias;

  useEffect(() => {
    if (!isOpen) return;
    // `*` is how the API spells "any source system"; the field shows it as blank.
    setSourceSystem(existingAlias?.sourceSystem === '*' ? '' : existingAlias?.sourceSystem ?? '');
    setAlias(existingAlias?.alias ?? '');
    setCanonical(existingAlias?.canonical ?? '');
    setUnit(existingAlias?.unit ?? '');
    setNote(existingAlias?.note ?? '');
    setError(undefined);
  }, [isOpen, existingAlias]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSourceSystem = sourceSystem.trim() || '*';
    const finalAlias = alias.trim();
    const finalCanonical = canonical.trim();
    if (!finalAlias || !finalCanonical) return;

    setBusy(true);
    setError(undefined);
    try {
      await onSave({
        sourceSystem: finalSourceSystem,
        alias: finalAlias,
        canonical: finalCanonical,
        unit: unit.trim() || undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (isEditing ? t('aliasModal.saveFailed') : t('aliasModal.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addSignalAliasModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? t('aliasModal.editTitle') : t('aliasModal.newTitle')}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? t('aliasModal.editSubtitle')
                  : t('aliasModal.newSubtitle')}
              </p>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('aliases.sourceSystem')} <span className="text-slate-400 font-normal">{t('common.optional')}</span>
              </label>
              <Input
                size="sm"
                autoFocus
                disabled={isEditing}
                value={sourceSystem}
                onChange={(value) => setSourceSystem(value)}
                placeholder={t('aliasModal.sourcePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('aliases.upstreamSpelling')} <span className="text-rose-500">*</span>
              </label>
              <Input
                size="sm"
                required
                disabled={isEditing}
                value={alias}
                onChange={(value) => setAlias(value)}
                placeholder={t('aliasModal.aliasPlaceholder')}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('aliases.canonicalName')} <span className="text-rose-500">*</span>
            </label>
            <Input
              size="sm"
              required
              value={canonical}
              onChange={(value) => setCanonical(value)}
              placeholder={t('aliasModal.canonicalPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('sensorModal.unit')} <span className="text-slate-400 font-normal">{t('common.optional')}</span>
            </label>
            <Input size="sm" value={unit} onChange={(value) => setUnit(value)} placeholder={t('aliasModal.unitPlaceholder')} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('aliases.note')} <span className="text-slate-400 font-normal">{t('common.optional')}</span>
            </label>
            <Input
              as="textarea"
              size="sm"
              rows={2}
              value={note}
              onChange={(value) => setNote(value)}
              placeholder={t('aliasModal.notePlaceholder')}
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
                <span>{busy ? t('common.saving') : (isEditing ? t('aliasModal.save') : t('aliasModal.create'))}</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
