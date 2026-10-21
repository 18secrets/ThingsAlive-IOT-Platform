import React, { useState } from 'react';
import { X, Check, Info, AlertCircle } from 'lucide-react';
import { Input } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, IndustryType, IndustryTypeInput } from '../../lib/api';

interface AddIndustryTypeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: IndustryTypeInput & { name: string; code: string }) => Promise<void>;
  existingIndustryType?: IndustryType | null;
}

// The backend's own rule (ck on industry_type.code); checked here only so the button can
// say why it is disabled instead of round-tripping a 400.
const CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

export const AddIndustryTypeModal: React.FC<AddIndustryTypeModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingIndustryType,
}) => {
  const { t } = useTranslation('equipment');
  // Read once per mount. The parent remounts this modal (by key) every time it opens,
  // so an edit always starts from the item it was opened for, never the previous one.
  const [name, setName] = useState(existingIndustryType?.name ?? '');
  const [code, setCode] = useState(existingIndustryType?.code ?? '');
  const [statusActive, setStatusActive] = useState((existingIndustryType?.status ?? 'active') === 'active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!isOpen) return null;

  const normalisedCode = code.trim().toUpperCase();
  const codeValid = CODE_PATTERN.test(normalisedCode);
  const canSave = !!name.trim() && codeValid && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave({ name: name.trim(), code: normalisedCode, status: statusActive ? 'active' : 'inactive' });
      onClose();
    } catch (err) {
      // Kept open on a refusal (a name or code already taken, in any spelling) so the
      // admin can correct it rather than retype it.
      setError(err instanceof ApiError ? err.message : t('industry.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="addIndustryTypeModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {existingIndustryType ? t('industry.edit') : t('industry.add')}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {t('industry.modalSubtitle')}
              </p>
            </div>
          </div>
          <button
            id="close-industry-type-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-5">

          {error && (
            <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Name & Code */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('industry.name')} <span className="text-rose-500">*</span>
              </label>
              <Input
                size="sm"
                required
                autoFocus
                value={name}
                onChange={(value) => setName(value)}
                placeholder={t('industry.namePlaceholder')}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('equipmentList.col.code')} <span className="text-rose-500">*</span>
              </label>
              <Input
                size="sm"
                required
                value={code}
                onChange={(value) => setCode(value.toUpperCase())}
                placeholder={t('common.eg', { example: 'PWR' })}
              />
              <p className={`text-[11px] mt-1 ${code && !codeValid ? 'text-rose-500' : 'text-slate-400'}`}>
                {t('industry.codeHint')}
              </p>
            </div>
          </div>

          {/* Status toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-700/30">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                <Check className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{t('industry.status')}</div>
                <div className="text-[11px] text-slate-400">{t('industry.statusHint')}</div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStatusActive(!statusActive)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                statusActive ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  statusActive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Modal Footer Buttons */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              <Trans i18nKey="common.mandatoryNote" t={t}>Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory</Trans>
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
                disabled={!canSave}
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{busy ? t('common.saving') : t('industry.save')}</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
