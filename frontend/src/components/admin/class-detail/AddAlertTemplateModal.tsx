import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { Input, InputNumber, SelectPicker } from 'rsuite';
import {
  AlertParams, AlertRuleTemplate, AlertRuleTemplateInput, AlertTrigger, ApiError, ChainOriginParams,
} from '../../../lib/api';

interface AddAlertTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  equipmentClassSlug: string;
  /** Signals this class declares — what a signal-threshold trigger can watch. */
  availableSignals: string[];
  onCreate: (slug: string, equipmentClassSlug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  onUpdate: (slug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  existingTemplate?: AlertRuleTemplate | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const SEVERITIES: AlertRuleTemplate['severity'][] = ['low', 'medium', 'high', 'critical'];
const SEVERITY_OPTIONS = SEVERITIES.map((s) => ({ label: s, value: s }));
const SEVERITY_OR_ABOVE_OPTIONS = SEVERITIES.map((s) => ({ label: `${s} or above`, value: s }));
// fuel-loss needs a live GPS fix this authoring screen has no data for — left out of
// the picker rather than half-modelled (see api.ts's comment).
const TRIGGERS: AlertTrigger[] = ['signal-threshold', 'prediction-severity', 'no-telemetry', 'chain-origin'];
const TRIGGER_LABEL: Record<AlertTrigger, string> = {
  'signal-threshold': 'Signal Threshold',
  'prediction-severity': 'Prediction Severity',
  'no-telemetry': 'No Telemetry',
  'fuel-loss': 'Fuel Loss',
  'chain-origin': 'Chain Origin',
};
const TRIGGER_OPTIONS = TRIGGERS.map((t) => ({ label: TRIGGER_LABEL[t], value: t }));

function defaultParams(trigger: AlertTrigger, signals: string[]): AlertParams {
  switch (trigger) {
    case 'signal-threshold':
      return { signal: signals[0] ?? '', max: null, min: null };
    case 'prediction-severity':
      return { atLeast: 'high', clientScenarioSlug: null };
    case 'chain-origin':
      return { atLeast: 'warning', chainSlug: null, stageSignal: null };
    default:
      return {};
  }
}

export const AddAlertTemplateModal: React.FC<AddAlertTemplateModalProps> = ({
  isOpen, onClose, equipmentClassSlug, availableSignals, onCreate, onUpdate, existingTemplate,
}) => {
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<AlertRuleTemplate['severity']>('high');
  const [enabledOnCopy, setEnabledOnCopy] = useState(true);
  const [trigger, setTrigger] = useState<AlertTrigger>('signal-threshold');
  const [params, setParams] = useState<AlertParams>(defaultParams('signal-threshold', availableSignals));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingTemplate;

  useEffect(() => {
    if (!isOpen) return;
    setSlug(existingTemplate?.slug ?? '');
    setSlugTouched(isEditing);
    setName(existingTemplate?.name ?? '');
    setDescription(existingTemplate?.description ?? '');
    setSeverity(existingTemplate?.severity ?? 'high');
    setEnabledOnCopy(existingTemplate?.enabledOnCopy ?? true);
    const t = existingTemplate?.trigger ?? 'signal-threshold';
    setTrigger(t);
    setParams(existingTemplate?.params ?? defaultParams(t, availableSignals));
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingTemplate, isEditing]);

  if (!isOpen) return null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const handleTriggerChange = (next: AlertTrigger) => {
    setTrigger(next);
    setParams(defaultParams(next, availableSignals));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slug.trim();
    const finalName = name.trim();
    if (!finalSlug || !finalName) return;

    setBusy(true);
    setError(undefined);
    try {
      const input: AlertRuleTemplateInput = {
        name: finalName,
        description: description.trim() || undefined,
        trigger,
        params,
        severity,
        enabledOnCopy,
      };
      if (isEditing) {
        await onUpdate(finalSlug, input);
      } else {
        await onCreate(finalSlug, equipmentClassSlug, input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the alert rule.`);
    } finally {
      setBusy(false);
    }
  };

  const thresholdParams = params as SignalThresholdParamsLike;
  const severityParams = params as PredictionSeverityParamsLike;
  const chainParams = params as ChainOriginParams;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {isEditing ? 'Edit Alert Rule Template' : 'New Alert Rule Template'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? 'Editing the working draft — publishing it is a separate step, from the list.'
                  : 'Created as a draft. Granting the class from now on copies published rules into the account.'}
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
                Rule Name <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                autoFocus
                value={name}
                onChange={(value) => handleNameChange(value)}
                placeholder="e.g. Coolant Over Limit"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Slug <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                disabled={isEditing}
                value={slug}
                onChange={(value) => { setSlug(value); setSlugTouched(true); }}
                placeholder="e.g. coolant-over-limit"
                className="font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <Input
              as="textarea"
              rows={2}
              value={description}
              onChange={(value) => setDescription(value)}
              placeholder="What this rule watches for, and why it matters..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Severity
              </label>
              <SelectPicker
                data={SEVERITY_OPTIONS}
                value={severity}
                onChange={(value) => setSeverity((value ?? 'high') as AlertRuleTemplate['severity'])}
                block
                searchable={false}
                cleanable={false}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Trigger
              </label>
              <SelectPicker
                data={TRIGGER_OPTIONS}
                value={trigger}
                onChange={(value) => handleTriggerChange((value ?? 'signal-threshold') as AlertTrigger)}
                block
                searchable={false}
                cleanable={false}
              />
            </div>
          </div>

          {trigger === 'signal-threshold' && (
            <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
              <span className="text-xs font-bold text-slate-800 dark:text-white">Threshold</span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Signal</label>
                  <SelectPicker
                    data={availableSignals.map((s) => ({ label: s, value: s }))}
                    value={thresholdParams.signal ?? ''}
                    onChange={(value) => setParams({ ...thresholdParams, signal: value ?? '' })}
                    placeholder="no signals on this class"
                    block
                    searchable={false}
                    cleanable={false}
                    className="font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Min (optional)</label>
                  <InputNumber
                    value={thresholdParams.min ?? ''}
                    onChange={(value) => setParams({ ...thresholdParams, min: value === '' ? null : Number(value) })}
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Max (optional)</label>
                  <InputNumber
                    value={thresholdParams.max ?? ''}
                    onChange={(value) => setParams({ ...thresholdParams, max: value === '' ? null : Number(value) })}
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-400">At least one of min or max is required.</p>
            </div>
          )}

          {trigger === 'prediction-severity' && (
            <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
              <span className="text-xs font-bold text-slate-800 dark:text-white">Fires when a scenario reaches</span>
              <SelectPicker
                data={SEVERITY_OR_ABOVE_OPTIONS}
                value={severityParams.atLeast ?? 'high'}
                onChange={(value) => setParams({ ...severityParams, atLeast: (value ?? 'high') as PredictionSeverityParamsLike['atLeast'] })}
                block
                searchable={false}
                cleanable={false}
              />
              <p className="text-[10px] text-slate-400">Watches every scenario on the machine — there's no single scenario to pin to at template authoring time.</p>
            </div>
          )}

          {trigger === 'no-telemetry' && (
            <p className="text-[11px] text-slate-400 italic">
              Nothing to configure — fires when a shift produced no readings at all.
            </p>
          )}

          {trigger === 'chain-origin' && (
            <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-3">
              <span className="text-xs font-bold text-slate-800 dark:text-white">Fires when a chain's origin stage reaches</span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Severity</label>
                  <SelectPicker
                    data={[{ label: 'warning', value: 'warning' }, { label: 'critical', value: 'critical' }]}
                    value={chainParams.atLeast ?? 'warning'}
                    onChange={(value) => setParams({ ...chainParams, atLeast: (value ?? 'warning') as ChainOriginParams['atLeast'] })}
                    block
                    searchable={false}
                    cleanable={false}
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Stage signal (optional)</label>
                  <SelectPicker
                    data={availableSignals.map((s) => ({ label: s, value: s }))}
                    value={chainParams.stageSignal ?? null}
                    onChange={(value) => setParams({ ...chainParams, stageSignal: value ?? null })}
                    placeholder="any stage"
                    block
                    searchable={false}
                    className="font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Chain slug (optional)</label>
                  <Input
                    value={chainParams.chainSlug ?? ''}
                    onChange={(value) => setParams({ ...chainParams, chainSlug: value.trim() || null })}
                    placeholder="any published chain"
                    className="font-mono"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-400">
                Left unset, watches every published chain bound to this class — narrow to one stage or one
                chain once there's a reason to route it differently.
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={enabledOnCopy}
              onChange={(e) => setEnabledOnCopy(e.target.checked)}
              className="cursor-pointer"
            />
            Enabled by default when a client's copy is created
          </label>

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
                <span>{busy ? 'Saving…' : (isEditing ? 'Save Draft' : 'Create Draft')}</span>
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
};

// Local, narrower views onto AlertParams for the two forms above — the type itself
// stays a loose union at the API boundary (see api.ts's comment on why).
interface SignalThresholdParamsLike { signal?: string; min?: number | null; max?: number | null }
interface PredictionSeverityParamsLike { atLeast?: 'none' | 'low' | 'medium' | 'high' | 'critical'; clientScenarioSlug?: string | null }
