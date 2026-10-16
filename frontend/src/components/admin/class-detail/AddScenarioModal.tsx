import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, Scenario, ScenarioInput } from '../../../lib/api';

interface AddScenarioModalProps {
  isOpen: boolean;
  onClose: () => void;
  equipmentClassSlug: string;
  /** Signals this class declares — what a scenario's requiredSignals can draw from. */
  availableSignals: string[];
  onCreate: (slug: string, equipmentClassSlug: string, input: ScenarioInput) => Promise<Scenario>;
  onUpdate: (slug: string, input: ScenarioInput) => Promise<Scenario>;
  /** The working draft (or latest version) being edited — undefined means "new". */
  existingScenario?: Scenario | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const SEVERITIES: Scenario['severity'][] = ['low', 'medium', 'high', 'critical'];
const TIERS: Scenario['tier'][] = [1, 2, 3];

export const AddScenarioModal: React.FC<AddScenarioModalProps> = ({
  isOpen, onClose, equipmentClassSlug, availableSignals, onCreate, onUpdate, existingScenario,
}) => {
  const { t } = useTranslation('catalog');
  const SEVERITY_OPTIONS = SEVERITIES.map((s) => ({ label: t(`common.severity.${s}`, { defaultValue: s }), value: s }));
  const TIER_OPTIONS = TIERS.map((n) => ({ label: t(`scenarioModal.tierOption.${n}`), value: n }));
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Scenario['severity']>('medium');
  const [tier, setTier] = useState<Scenario['tier']>(1);
  const [requiredSignals, setRequiredSignals] = useState<string[]>([]);
  const [minimumHistoryDays, setMinimumHistoryDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingScenario;

  useEffect(() => {
    if (!isOpen) return;
    setSlug(existingScenario?.slug ?? '');
    setSlugTouched(isEditing);
    setName(existingScenario?.name ?? '');
    setDescription(existingScenario?.description ?? '');
    setSeverity(existingScenario?.severity ?? 'medium');
    setTier(existingScenario?.tier ?? 1);
    setRequiredSignals(existingScenario?.requiredSignals ?? []);
    setMinimumHistoryDays(existingScenario?.minimumHistoryDays ?? 0);
    setError(undefined);
  }, [isOpen, existingScenario, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const toggleSignal = (signal: string) => {
    setRequiredSignals((prev) =>
      prev.includes(signal) ? prev.filter((s) => s !== signal) : [...prev, signal]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slug.trim();
    const finalName = name.trim();
    if (!finalSlug || !finalName) return;

    setBusy(true);
    setError(undefined);
    try {
      const input: ScenarioInput = {
        name: finalName,
        description: description.trim() || undefined,
        severity,
        tier,
        requiredSignals,
        minimumHistoryDays,
      };
      if (isEditing) {
        await onUpdate(finalSlug, input);
      } else {
        await onCreate(finalSlug, equipmentClassSlug, input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (isEditing ? t('scenarioModal.saveFailed') : t('scenarioModal.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? t('scenarioModal.editTitle') : t('scenarioModal.newTitle')}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? t('common.editDraftSubtitleList')
                  : t('classModal.newSubtitle')}
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

        <form onSubmit={handleSubmit} className="px-7 py-6 overflow-y-auto max-h-[calc(85vh-130px)] space-y-5">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('scenarioModal.name')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                autoFocus
                value={name}
                onChange={(value) => handleNameChange(value)}
                placeholder={t('scenarioModal.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('classModal.slug')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                disabled={isEditing}
                value={slug}
                onChange={(value) => { setSlug(value); setSlugTouched(true); }}
                placeholder={t('scenarioModal.slugPlaceholder')}
                className="font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('classModal.description')}
            </label>
            <Input
              as="textarea"
              rows={2}
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder={t('scenarioModal.descriptionPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('common.severityLabel')}
              </label>
              <SelectPicker
                data={SEVERITY_OPTIONS}
                value={severity}
                onChange={(value) => setSeverity((value ?? 'medium') as Scenario['severity'])}
                block
                searchable={false}
                cleanable={false}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('scenarioModal.scoringTier')}
              </label>
              <SelectPicker
                data={TIER_OPTIONS}
                value={tier}
                onChange={(value) => setTier((value ?? 1) as Scenario['tier'])}
                block
                searchable={false}
                cleanable={false}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('scenarioModal.minHistory')}
              </label>
              <InputNumber
                min={0}
                max={365}
                value={minimumHistoryDays}
                onChange={(value) => setMinimumHistoryDays(Math.max(0, Number(value) || 0))}
              />
            </div>
          </div>

          <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-2">
            <span className="text-xs font-bold text-slate-800 dark:text-white">{t('scenarioModal.requiredSignals')}</span>
            <p className="text-[10px] text-slate-400 -mt-1">
              {t('scenarioModal.requiredSignalsHint')}
            </p>
            {availableSignals.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">
                {t('common.noClassSignals')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableSignals.map((signal) => {
                  const checked = requiredSignals.includes(signal);
                  return (
                    <button
                      type="button"
                      key={signal}
                      onClick={() => toggleSignal(signal)}
                      className={`px-2.5 py-1 rounded-md border text-[11px] font-mono transition-colors cursor-pointer ${
                        checked
                          ? 'bg-sky-600 border-sky-600 text-white'
                          : 'bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-sky-400'
                      }`}
                    >
                      {signal}
                    </button>
                  );
                })}
              </div>
            )}
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
