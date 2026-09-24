import React, { useEffect, useState } from 'react';
import { X, Check, Info } from 'lucide-react';
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

export const AddScenarioModal: React.FC<AddScenarioModalProps> = ({
  isOpen, onClose, equipmentClassSlug, availableSignals, onCreate, onUpdate, existingScenario,
}) => {
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
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the scenario.`);
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
                {isEditing ? 'Edit Prediction Scenario' : 'New Prediction Scenario'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                {isEditing
                  ? 'Editing the working draft — publishing it is a separate step, from the list.'
                  : 'Created as a draft. Nothing here reaches a tenant until it is published.'}
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
                Scenario Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                autoFocus
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Coolant Overheat"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Slug <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                disabled={isEditing}
                value={slug}
                onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
                placeholder="e.g. coolant-overheat"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all font-mono disabled:bg-slate-50 dark:disabled:bg-slate-800/60 disabled:text-slate-400"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this scenario detects, and why it matters..."
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all resize-none leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Severity
              </label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Scenario['severity'])}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all cursor-pointer"
              >
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Scoring Tier
              </label>
              <select
                value={tier}
                onChange={(e) => setTier(Number(e.target.value) as Scenario['tier'])}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all cursor-pointer"
              >
                <option value={1}>1 — Rules on windows</option>
                <option value={2}>2 — Weak supervision</option>
                <option value={3}>3 — Trained model</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Min. History (days)
              </label>
              <input
                type="number"
                min={0}
                max={365}
                value={minimumHistoryDays}
                onChange={(e) => setMinimumHistoryDays(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>
          </div>

          <div className="p-4 rounded-xl bg-sky-50/60 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 space-y-2">
            <span className="text-xs font-bold text-slate-800 dark:text-white">Required Signals</span>
            <p className="text-[10px] text-slate-400 -mt-1">
              Drawn from this class's expected signals — a scenario cannot run without every one checked here.
            </p>
            {availableSignals.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">
                This class has no expected signals declared yet — add some on the class itself first.
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
